import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasPodman, image } from "./podman.fixture.ts";
import { podman, type Podman } from "./index.ts";

const made: Podman[] = [];
let host = "";
let count = 0;

afterEach(async () => {
  await Promise.all(made.splice(0).map((box) => box.close()));
  if (host) rmSync(host, { recursive: true, force: true });
  host = "";
});

function box(
  options: { readOnly?: boolean; memory?: string } = {},
  name?: string,
) {
  host ||= mkdtempSync(join(tmpdir(), "que-pasa-podman-"));
  writeFileSync(join(host, "README"), "hello\n");
  const sandbox = podman({
    name: name ?? `que-pasa-test-${process.pid}-p${(count += 1)}`,
    image,
    mounts: [
      { source: host, target: "/work", readOnly: options.readOnly ?? false },
    ],
    runArgs: ["--security-opt", "label=disable"],
    ...(options.memory ? { memory: options.memory } : {}),
  });
  made.push(sandbox);
  return sandbox;
}

const idOf = (name: string) =>
  spawnSync("podman", ["container", "inspect", "--format", "{{.Id}}", name], {
    encoding: "utf8",
  }).stdout.trim();

describe.runIf(hasPodman)("a podman sandbox", () => {
  it("has no network", async () => {
    const result = await box().execute(
      "wget -q -T 2 -O- http://1.1.1.1 || echo offline",
    );
    expect(result.output).toContain("offline");
  });

  it("is kept between calls, and between backends of the same name and options", async () => {
    const first = box();
    await first.read("README", 0, 1);
    const id = idOf(first.id);
    const again = box({}, first.id);
    await again.read("README", 0, 1);
    expect(idOf(first.id)).toBe(id);
  });

  it("refuses a container of its name made with other options", async () => {
    const first = box();
    await first.read("README", 0, 1);
    const other = box({ memory: "256m" }, first.id);
    await expect(other.read("README", 0, 1)).rejects.toThrow(
      "made with other options",
    );
  });

  it("is made again when it is gone", async () => {
    const sandbox = box();
    await sandbox.read("README", 0, 1);
    spawnSync("podman", ["rm", "--force", "--time", "0", sandbox.id]);
    expect(await sandbox.read("README", 0, 1)).toEqual({
      content: "hello\n",
      totalLines: 1,
    });
  });

  it("is started again when it stopped", async () => {
    const sandbox = box();
    await sandbox.read("README", 0, 1);
    spawnSync("podman", ["stop", "--time", "0", sandbox.id]);
    const fresh = box({}, sandbox.id);
    expect((await fresh.read("README", 0, 1)).content).toBe("hello\n");
  });

  it("cannot write a read-only mount", async () => {
    const sandbox = box({ readOnly: true });
    await expect(sandbox.write("README", "x")).rejects.toThrow(
      /Read-only file system/,
    );
    const result = await sandbox.execute("touch /work/edited");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toMatch(/Read-only file system/);
  });
});
