import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Middleware } from "../define/index.ts";
import { type FileBackend, local } from "../sandbox/index.ts";
import { memory, memoryPrompt } from "./index.ts";

const run = { runId: "run-1", caller: { id: "matt" } };

let host = "";
let backend: FileBackend;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), "que-pasa-memory-"));
  mkdirSync(join(host, "memory"));
  writeFileSync(join(host, "memory/craft.md"), "Keep it simple.\n\n");
  writeFileSync(
    join(host, "memory/team.md"),
    "<!-- an authoring note -->Matt reviews.\n",
  );
  backend = local({ root: host });
});
afterEach(() => rmSync(host, { recursive: true, force: true }));

/** What a memory adds to the system prompt for a run, as the loop does it: load once, then render from what was kept. */
async function promptOf(middleware: Middleware) {
  const kept = await middleware.beforeAgent!(run);
  // The run keeps it as JSON in storage.
  return middleware.systemPrompt!(JSON.parse(JSON.stringify(kept)));
}

describe("memory", () => {
  it("is middleware named memory, with Deep Agents' two hooks", () => {
    const m = memory({ backend, sources: [] });
    expect(m.name).toBe("memory");
    expect(typeof m.beforeAgent).toBe("function");
    expect(typeof m.systemPrompt).toBe("function");
  });

  it("puts each source in Deep Agents' prompt, in order: its path, a blank line, its text, HTML comments left out", async () => {
    const prompt = await promptOf(
      memory({ backend, sources: ["memory/team.md", "memory/craft.md"] }),
    );
    expect(prompt).toBe(
      memoryPrompt.replace(
        "{agent_memory}",
        "memory/team.md\n\nMatt reviews.\n\nmemory/craft.md\n\nKeep it simple.",
      ),
    );
    expect(prompt).toMatch(/^<agent_memory>\n/);
    expect(prompt).not.toMatch(/edit_file/);
  });

  it("leaves out a source that is not there, as Deep Agents does", async () => {
    const prompt = await promptOf(
      memory({ backend, sources: ["memory/nope.md", "memory/craft.md"] }),
    );
    expect(prompt).toContain("memory/craft.md\n\nKeep it simple.");
    expect(prompt).not.toContain("nope");
  });

  it("says no memory was loaded when no source is there, or the run kept none", async () => {
    const none = memoryPrompt.replace("{agent_memory}", "(No memory loaded)");
    const m = memory({ backend, sources: ["memory/nope.md"] });
    expect(await promptOf(m)).toBe(none);
    expect(m.systemPrompt!(null)).toBe(none);
  });

  it("fails the load on any other error, such as a folder or a path outside the backend", async () => {
    await expect(
      memory({ backend, sources: ["memory"] }).beforeAgent!(run),
    ).rejects.toThrow(/memory: memory: is_directory/);
    await expect(
      memory({ backend, sources: ["../x"] }).beforeAgent!(run),
    ).rejects.toThrow(/invalid_path/);
  });

  it("fails the load on a source that is not UTF-8 text", async () => {
    writeFileSync(join(host, "memory/bin"), Uint8Array.from([0xff, 0xfe]));
    await expect(
      memory({ backend, sources: ["memory/bin"] }).beforeAgent!(run),
    ).rejects.toThrow();
  });

  it("puts its memory in a prompt of the host's, at {agent_memory}", async () => {
    const prompt = await promptOf(
      memory({
        backend,
        sources: ["memory/craft.md"],
        systemPrompt: "Context:\n{agent_memory}",
      }),
    );
    expect(prompt).toBe("Context:\nmemory/craft.md\n\nKeep it simple.");
  });

  it("refuses a prompt with no {agent_memory}", () => {
    expect(() =>
      memory({ backend, sources: [], systemPrompt: "Context:" }),
    ).toThrow(/must hold \{agent_memory\}/);
  });
});
