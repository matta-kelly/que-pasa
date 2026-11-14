import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canExecute, local, view, type FileBackend } from "./index.ts";

let host = "";
let bound: FileBackend;
let free: FileBackend;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), "que-pasa-view-"));
  for (const [path, content] of Object.entries({
    README: "const r = 0;\n",
    "src/b.ts": "const b = 1;\n",
    "src/c.ts": "const c = 2;\n",
    "src/lib/a.ts": "const a = 3;\n",
  })) {
    mkdirSync(dirname(join(host, path)), { recursive: true });
    writeFileSync(join(host, path), content);
  }
  free = local({ root: host });
  bound = view(free, {
    read: ["README", "src/lib/a.ts"],
    write: ["src/b.ts", "test/b.test.ts"],
  });
});
afterEach(() => rmSync(host, { recursive: true, force: true }));

describe("a view", () => {
  it("answers a file outside it as the backend answers a missing one", async () => {
    expect(await bound.read("src/c.ts", 0, 10)).toEqual(
      await free.read("nope", 0, 10),
    );
    expect(await bound.ls("src/c.ts")).toEqual(await free.ls("nope"));
    expect(await bound.grep("const", "src/c.ts")).toEqual({
      error: "file_not_found",
    });
    expect(await bound.download(["src/c.ts", "README"])).toEqual([
      { path: "src/c.ts", error: "file_not_found" },
      { path: "README", content: new TextEncoder().encode("const r = 0;\n") },
    ]);
  });

  it("lists only its files, and the folders on the way to them", async () => {
    expect((await bound.ls(".")).files?.map((f) => f.path)).toEqual([
      "README",
      "src",
    ]);
    expect((await bound.ls("src")).files?.map((f) => f.path)).toEqual([
      "src/b.ts",
      "src/lib",
    ]);
  });

  it("holds everything under a folder it reads, and nothing beside it", async () => {
    const folder = view(free, { read: ["src/lib"], write: [] });
    expect((await folder.read("src/lib/a.ts", 0, 10)).content).toBe(
      "const a = 3;\n",
    );
    expect((await folder.ls("src")).files?.map((f) => f.path)).toEqual([
      "src/lib",
    ]);
    expect(await folder.read("src/c.ts", 0, 10)).toEqual({
      error: "file_not_found",
    });
    expect((await folder.glob("**/*.ts", ".")).files).toEqual(["src/lib/a.ts"]);
    expect(await folder.write("src/lib/a.ts", "x")).toMatchObject({
      error: "permission_denied",
    });
  });

  it("globs and greps only its files that are there", async () => {
    expect((await bound.glob("**/*.ts", ".")).files).toEqual([
      "src/b.ts",
      "src/lib/a.ts",
    ]);
    expect(
      (await bound.grep("const", ".")).matches?.map((m) => m.path),
    ).toEqual(["README", "src/b.ts", "src/lib/a.ts"]);
  });

  it("searches in one backend call, and keeps its own files and the backend's cut", async () => {
    const calls: string[] = [];
    const counted: FileBackend = {
      ...free,
      glob: async (...a) => (calls.push("glob"), free.glob(...a)),
      grep: async (...a) => {
        calls.push("grep");
        return { ...(await free.grep(...a)), truncated: true };
      },
    };
    const one = view(counted, {
      read: ["src/b.ts", "src/lib/a.ts"],
      write: [],
    });
    expect(await one.grep("const", "src")).toEqual({
      matches: [
        { path: "src/b.ts", line: 1, text: "const b = 1;" },
        { path: "src/lib/a.ts", line: 1, text: "const a = 3;" },
      ],
      truncated: true,
    });
    expect((await one.glob("**/*.ts", "src")).files?.sort()).toEqual([
      "src/b.ts",
      "src/lib/a.ts",
    ]);
    expect(calls).toEqual(["grep", "glob"]);
  });

  it("writes its write files, and a write file not made yet, and refuses any other, saying which it may write", async () => {
    expect(await bound.write("src/b.ts", "x\n")).toEqual({ path: "src/b.ts" });
    expect(await bound.write("test/b.test.ts", "t\n")).toEqual({
      path: "test/b.test.ts",
    });
    const refused = await bound.write("README", "x");
    expect(refused).toEqual({
      error: "permission_denied",
      message:
        "README is not a file this view may write: it may write src/b.ts, test/b.test.ts",
    });
    expect((await bound.edit("src/c.ts", "c", "d", false)).error).toBe(
      "permission_denied",
    );
  });

  it("checks the path it hands the backend", async () => {
    expect(await bound.read("/x/../src/b.ts", 0, 1)).toEqual({
      error: "invalid_path",
    });
    expect((await bound.read(`${host}/./src//b.ts`, 0, 1)).content).toBe(
      "const b = 1;\n",
    );
  });

  it("has no execute", () => {
    expect(canExecute(bound)).toBe(false);
  });

  it("refuses a file of its own outside the root", () => {
    expect(() => view(free, { read: ["../x"], write: [] })).toThrow(
      "not a file under",
    );
  });
});
