import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Resource, Tool } from "../define/index.ts";
import {
  edit_file,
  execute,
  type FileBackend,
  fileTools,
  glob,
  grep,
  local,
  ls,
  read_file,
  readTools,
  Sandbox,
  view,
  write_file,
} from "./index.ts";

let host = "";
let backend: FileBackend;

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), "que-pasa-tools-"));
  for (const [path, content] of Object.entries({
    README: "one\ntwo\nthree\n",
    "src/a.ts": "const a = 1;\nconst b = a;\n",
    "src/empty.ts": "",
  })) {
    mkdirSync(dirname(join(host, path)), { recursive: true });
    writeFileSync(join(host, path), content);
  }
  backend = local({ root: host });
});
afterEach(() => rmSync(host, { recursive: true, force: true }));

/** Call a tool as a run would: its input parsed, and the run's sandbox given. */
function call<S extends z.ZodObject>(
  tool: Tool<S, never>,
  input: z.input<S>,
  given = backend,
) {
  return tool.run(tool.schema.parse(input), {
    caller: { id: "test" },
    context: undefined as never,
    use: async <T>(resource: Resource<T>) => {
      expect(resource).toBe(Sandbox);
      return given as T;
    },
  });
}

describe("the file tools", () => {
  it("each use the sandbox, and run again after a crash only when twice is once", () => {
    for (const tool of [...fileTools, execute])
      expect(tool.uses).toEqual([Sandbox]);
    expect(
      Object.fromEntries(
        [...fileTools, execute].map((t) => [t.name, t.replay ?? "never"]),
      ),
    ).toEqual({
      ls: "safe",
      read_file: "safe",
      glob: "safe",
      grep: "safe",
      write_file: "safe",
      edit_file: "never",
      execute: "never",
    });
    expect(readTools.map((t) => t.name)).toEqual([
      "ls",
      "read_file",
      "glob",
      "grep",
    ]);
  });

  it("ls: a folder with a slash, and Deep Agents' answers", async () => {
    expect(await call(ls, {})).toBe("README\nsrc/");
    expect(await call(ls, { path: "nope" })).toBe(
      "Error: Path 'nope' not found",
    );
    expect(await call(ls, { path: "../x" })).toBe(
      "Error: Path traversal not allowed: ../x",
    );
  });

  it("read_file: the header, then the lines as they are, and the next offset while there are more", async () => {
    expect(await call(read_file, { file_path: "README", limit: 2 })).toBe(
      "@@ lines 1-2 of 3 | next offset 2 @@\none\ntwo\n",
    );
    expect(await call(read_file, { file_path: "README", offset: 2 })).toBe(
      "@@ lines 3-3 of 3 @@\nthree\n",
    );
    expect(await call(read_file, { file_path: "README", offset: 3 })).toBe(
      "Error: Line offset 3 exceeds file length (3 lines)",
    );
    expect(await call(read_file, { file_path: "src/empty.ts" })).toBe(
      "System reminder: File exists but has empty contents",
    );
    expect(await call(read_file, { file_path: "nope" })).toBe(
      "Error: File 'nope' not found",
    );
    expect(await call(read_file, { file_path: "src" })).toBe(
      "Error: 'src' is a directory, not a file",
    );
  });

  it("read_file: a file too long for one answer is cut at a whole line, and says where to go on", async () => {
    writeFileSync(join(host, "big"), `${"x".repeat(99)}\n`.repeat(1000));
    const answer = String(
      await call(read_file, { file_path: "big", limit: 1000 }),
    );
    expect(answer.length).toBeLessThanOrEqual(80_100);
    expect(answer).toMatch(
      /^@@ lines 1-800 of 1000 \| next offset 800 \| truncated due to size @@\n/,
    );
  });

  it("write_file and edit_file: Deep Agents' answers", async () => {
    expect(
      await call(write_file, {
        file_path: "src/n.ts",
        content: "x = 1; x = 1;\n",
      }),
    ).toBe("Successfully wrote to 'src/n.ts'");
    expect(
      await call(edit_file, {
        file_path: "src/n.ts",
        old_string: "x = 1",
        new_string: "y",
      }),
    ).toBe(
      "Error: String 'x = 1' appears 2 times in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.",
    );
    expect(
      await call(edit_file, {
        file_path: "src/n.ts",
        old_string: "x = 1",
        new_string: "y",
        replace_all: true,
      }),
    ).toBe("Successfully replaced 2 occurrence(s) in 'src/n.ts'");
    expect(
      await call(edit_file, {
        file_path: "src/n.ts",
        old_string: "zzz",
        new_string: "y",
      }),
    ).toBe("Error: String not found in file: 'zzz'");
  });

  it("glob and grep: paths from the root, and matches by file", async () => {
    expect(await call(glob, { pattern: "**/*.ts" })).toBe(
      "src/a.ts\nsrc/empty.ts",
    );
    expect(await call(glob, { pattern: "*.md" })).toBe(
      "No files found matching pattern '*.md'",
    );
    expect(await call(grep, { pattern: "const" })).toBe(
      "src/a.ts:\n  1: const a = 1;\n  2: const b = a;",
    );
    expect(await call(grep, { pattern: "zzz" })).toBe(
      "No matches found for pattern 'zzz'",
    );
  });

  it("execute: the output, then how the command ended", async () => {
    expect(await call(execute, { command: "echo hi" })).toBe(
      "hi\n[Command succeeded with exit code 0]",
    );
    expect(await call(execute, { command: "echo no >&2; exit 2" })).toBe(
      "no\n[Command failed with exit code 2]",
    );
  });

  it("execute: the tail of an output too long, where a failure is", async () => {
    const answer = String(
      await call(execute, { command: "seq 1 100000; echo last" }),
    );
    expect(answer).toMatch(
      /last\n\[Command succeeded with exit code 0\]\n\[Output was truncated due to size limits\]$/,
    );
    expect(answer.length).toBeLessThan(80_200);
  });

  it("execute: on a backend with no execute, Deep Agents' answer", async () => {
    const bound = view(backend, { read: ["README"], write: [] });
    expect(await call(execute, { command: "ls" }, bound)).toMatch(
      /^Error: Execution not available/,
    );
  });

  it("a view: a file outside it is missing, and a write outside it says what it may write", async () => {
    const bound = view(backend, { read: ["README"], write: ["src/a.ts"] });
    expect(await call(read_file, { file_path: "src/empty.ts" }, bound)).toBe(
      "Error: File 'src/empty.ts' not found",
    );
    expect(
      await call(write_file, { file_path: "README", content: "x" }, bound),
    ).toBe(
      "Error: permission denied for write on README: README is not a file this view may write: it may write src/a.ts",
    );
  });
});
