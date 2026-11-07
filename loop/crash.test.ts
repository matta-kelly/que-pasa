import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/** A span as the fixture writes it. */
type Span = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, unknown>;
};

const fixture = new URL("./crash.fixture.ts", import.meta.url).pathname;
let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Run one phase of the fixture as its own process. The first is killed at its crash point; the second gives its outcome. */
function phase(
  scenario: string,
  which: "first" | "second",
  folder: string,
): Promise<string> {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      fixture,
      scenario,
      which,
      join(folder, "runs.sqlite"),
      join(folder, "step.log"),
      join(folder, "spans.jsonl"),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let out = "";
  return new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (which === "first" && out.includes("CRASH_POINT"))
        child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (which === "first" && signal === "SIGKILL") resolve(out);
      else if (which === "second" && code === 0) resolve(out);
      else
        reject(
          new Error(`${scenario} ${which}: exited ${code ?? signal}\n${out}`),
        );
    });
  });
}

/** Kill a run at its crash point `crashes` times, then run it again in a fresh process, and give what that process saw. */
async function crashAndResume(scenario: string, crashes = 1) {
  dir = mkdtempSync(join(tmpdir(), "que-pasa-crash-"));
  let first = "";
  for (let i = 0; i < crashes; i++) first = await phase(scenario, "first", dir);
  const out = await phase(scenario, "second", dir);
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error(`${scenario}: no RESULT\n${out}`);
  const [, traceId, spanId] =
    first
      .split("\n")
      .find((l) => l.startsWith("HOST "))
      ?.split(" ") ?? [];
  const spans = readFileSync(join(dir, "spans.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Span);
  return {
    ...(JSON.parse(line.slice("RESULT ".length)) as {
      value: unknown;
      calls: number;
      ran: string[];
      messages: string[];
    }),
    host: { traceId, spanId },
    spans,
  };
}

const done = { verdict: "done", note: "ok" };

describe("a run killed at a crash point and opened again in a new process", () => {
  it("killed mid model request: goes on and gives its result", async () => {
    const seen = await crashAndResume("model");
    expect(seen.value).toEqual(done);
    expect(seen.ran).toEqual([]);
  });

  it("killed mid tool that is not replay-safe: the tool does not run again, and the model gets it as interrupted", async () => {
    const seen = await crashAndResume("unsafe-tool");
    expect(seen.value).toEqual(done);
    expect(seen.ran).toEqual(["first"]);
    expect(seen.messages).toContain("step error");
    expect(seen.calls).toBe(1);
  });

  it("killed mid tool: the resumed process's spans join the trace the first process started", async () => {
    const seen = await crashAndResume("unsafe-tool");
    const runs = seen.spans.filter(
      (span) => span.name === "invoke_agent worker",
    );
    expect(seen.spans.every((span) => span.traceId === seen.host.traceId)).toBe(
      true,
    );
    // The first process's run span was open when it was killed; the second's is a resumed segment under the host's span.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.attributes["que_pasa.resumed"]).toBe(true);
    expect(runs[0]?.parentSpanId).toBe(seen.host.spanId);
    const interrupted = seen.spans.find(
      (span) => span.name === "execute_tool step",
    );
    expect(interrupted?.attributes["error.type"]).toMatch(/interrupt/);
    expect(interrupted?.parentSpanId).toBe(runs[0]?.spanId);
  });

  it("killed mid replay-safe tool: the tool runs again, with the context the run was started with", async () => {
    const seen = await crashAndResume("safe-tool");
    expect(seen.value).toEqual(done);
    expect(seen.ran).toEqual(["first", "first"]);
    expect(seen.messages.filter((m) => m.startsWith("step"))).toEqual(["step"]);
    expect(seen.calls).toBe(1);
  });

  it("killed mid replay-safe tool as often as pi's restart limit: the tool stops, and the model gets it as an error", async () => {
    const seen = await crashAndResume("safe-tool", 5);
    expect(seen.value).toEqual(done);
    expect(seen.ran).toEqual(["first", "first", "first", "first", "first"]);
    expect(seen.messages).toContain("step error");
  });

  it("killed after its submit: gives back the kept result, with no model call", async () => {
    const seen = await crashAndResume("after-submit");
    expect(seen.value).toEqual(done);
    expect(seen.calls).toBe(0);
    expect(seen.messages.at(-1)).toBe("submit");
  });
}, 60_000);
