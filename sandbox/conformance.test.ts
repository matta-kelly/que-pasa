/**
 * One suite every backend must pass: the same operations, the same results, the same errors, and every adversarial
 * path refused. It runs over `local`, over a `view` that holds every file, and over `podman` when podman is there.
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  canExecute,
  type FileBackend,
  local,
  podman,
  type Podman,
  view,
} from "./index.ts";
import { hasPodman, image } from "./podman.fixture.ts";

/** The files every case starts with, from the root. */
const seed: Record<string, string> = {
  README: "hello\nworld\n",
  "src/a.ts": "const a = 1;\nexport { a };\n",
  "src/lib/b.ts": "const b = 2;\n",
  "src/x:1.ts": "const x = 3;\n",
  ".git/config": "const hidden = 0;\n",
};
const written = ["src/new.ts", "deep/er/new.ts", "src/$(touch pwned)"];
/** A file of every byte, which no text encoding keeps: a download must give it back as it is. Made by its case. */
const binary = "bin/all.bin";
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

/** A fresh host folder with the seed files. */
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "que-pasa-sandbox-"));
  for (const [path, content] of Object.entries(seed)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

type Made = { backend: FileBackend; root: string; host: string };
const containers: Podman[] = [];
let count = 0;

const backends: [string, () => Made, boolean][] = [
  [
    "local",
    () => {
      const host = folder();
      return { backend: local({ root: host }), root: host, host };
    },
    true,
  ],
  [
    "view over local",
    () => {
      const host = folder();
      const backend = view(local({ root: host }), {
        read: [...Object.keys(seed), binary],
        write: [...Object.keys(seed), ...written],
      });
      return { backend, root: host, host };
    },
    true,
  ],
  [
    "podman",
    () => {
      const host = folder();
      const box = podman({
        name: `que-pasa-test-${process.pid}-${(count += 1)}`,
        image,
        mounts: [{ source: host, target: "/work" }],
        runArgs: ["--security-opt", "label=disable"],
      });
      containers.push(box);
      return { backend: box, root: "/work", host };
    },
    hasPodman,
  ],
];

afterAll(async () => {
  await Promise.all(containers.map((box) => box.close()));
});

describe.each(backends)("the %s backend", (name, make, runs) => {
  let made: Made;
  /** A view refuses a write to anything but its write files, before the backend looks. */
  const notWritable = (error: string) =>
    name.startsWith("view")
      ? expect.objectContaining({ error: "permission_denied" })
      : { error };
  beforeEach(() => {
    if (runs) made = make();
    return () => {
      if (runs) rmSync(made.host, { recursive: true, force: true });
    };
  });
  const b = () => made.backend;

  describe.runIf(runs)("files", () => {
    it("lists a folder, a folder with a slash, and a file as itself", async () => {
      const root = await b().ls(".");
      expect(root.files?.filter((f) => f.path !== ".git")).toEqual([
        { path: "README", isDir: false },
        { path: "src", isDir: true },
      ]);
      expect((await b().ls("src")).files?.map((f) => f.path)).toEqual([
        "src/a.ts",
        "src/lib",
        "src/x:1.ts",
      ]);
      expect((await b().ls("README")).files).toEqual([
        { path: "README", isDir: false },
      ]);
      expect(await b().ls("nope")).toEqual({ error: "file_not_found" });
    });

    it("reads lines after an offset, with the file's line count", async () => {
      expect(await b().read("src/a.ts", 0, 100)).toEqual({
        content: "const a = 1;\nexport { a };\n",
        totalLines: 2,
      });
      expect(await b().read("src/a.ts", 1, 1)).toEqual({
        content: "export { a };\n",
        totalLines: 2,
      });
      expect(await b().read(`${made.root}/README`, 0, 1)).toEqual({
        content: "hello\n",
        totalLines: 2,
      });
      expect(await b().read("nope", 0, 10)).toEqual({
        error: "file_not_found",
      });
      expect(await b().read("src", 0, 10)).toEqual({ error: "is_directory" });
    });

    it("writes a file whole, with its folders, and its content as is", async () => {
      const content = "a $HOME `id` $(id) \\n ' \" line\n";
      expect(await b().write("deep/er/new.ts", content)).toEqual({
        path: "deep/er/new.ts",
      });
      expect((await b().read("deep/er/new.ts", 0, 10)).content).toBe(content);
      await b().write("src/a.ts", "short\n");
      expect((await b().read("src/a.ts", 0, 10)).content).toBe("short\n");
      expect(await b().write(".", "x")).toEqual(notWritable("is_directory"));
    });

    it("never reads a path as a command", async () => {
      await b().write("src/$(touch pwned)", "x\n");
      expect(existsSync(join(made.host, "src/$(touch pwned)"))).toBe(true);
      expect(existsSync(join(made.host, "pwned"))).toBe(false);
      expect(existsSync(join(made.host, "src/pwned"))).toBe(false);
    });

    it("edits one occurrence, each with all, and refuses none or several", async () => {
      await b().write("src/new.ts", "x = 1; x = 1; y = 2;\n");
      expect(await b().edit("src/new.ts", "y = 2", "y = $&$1", false)).toEqual({
        path: "src/new.ts",
        occurrences: 1,
      });
      expect((await b().read("src/new.ts", 0, 1)).content).toBe(
        "x = 1; x = 1; y = $&$1;\n",
      );
      expect(await b().edit("src/new.ts", "x = 1", "z", false)).toEqual({
        error: "string_not_unique",
        occurrences: 2,
      });
      expect(await b().edit("src/new.ts", "x = 1", "z", true)).toEqual({
        path: "src/new.ts",
        occurrences: 2,
      });
      expect(await b().edit("src/new.ts", "nowhere", "z", false)).toEqual({
        error: "string_not_found",
      });
      expect(await b().edit("nope.ts", "a", "b", false)).toEqual(
        notWritable("file_not_found"),
      );
    });

    it("globs from a folder, with .git left out", async () => {
      expect((await b().glob("**/*.ts", ".")).files).toEqual([
        "src/a.ts",
        "src/lib/b.ts",
        "src/x:1.ts",
      ]);
      expect((await b().glob("*.ts", "src")).files).toEqual([
        "src/a.ts",
        "src/x:1.ts",
      ]);
      expect((await b().glob("*.md", ".")).files).toEqual([]);
      expect(await b().glob("*", "nope")).toEqual({ error: "file_not_found" });
    });

    it("greps a literal text, by path, with .git left out, and a file whose name holds a colon", async () => {
      expect((await b().grep("const", ".")).matches).toEqual([
        { path: "src/a.ts", line: 1, text: "const a = 1;" },
        { path: "src/lib/b.ts", line: 1, text: "const b = 2;" },
        { path: "src/x:1.ts", line: 1, text: "const x = 3;" },
      ]);
      expect((await b().grep("const", "src", "*.ts")).matches).toHaveLength(2);
      expect((await b().grep("a.*", ".")).matches).toEqual([]);
      expect((await b().grep("hello\nworld", ".")).matches).toEqual([]);
      expect(await b().grep("x", "nope")).toEqual({ error: "file_not_found" });
    });

    it("downloads files whole, as bytes, in order, each with its own error", async () => {
      mkdirSync(join(made.host, "bin"));
      writeFileSync(join(made.host, binary), bytes);
      const got = await b().download([binary, "README", "nope", "src"]);
      expect(got.map((r) => r.path)).toEqual([binary, "README", "nope", "src"]);
      expect(got[0]!.content).toEqual(bytes);
      expect(new TextDecoder().decode(got[1]!.content)).toBe(seed["README"]);
      expect(got[2]).toEqual({ path: "nope", error: "file_not_found" });
      expect(got[3]).toEqual({ path: "src", error: "is_directory" });
      expect(await b().download([])).toEqual([]);
    });

    it.each([
      "..",
      "../x",
      "src/../../x",
      "/etc/passwd",
      "~",
      "~/x",
      "a\nb",
      "a\u0000b",
    ])("refuses the path %j in every operation", async (bad) => {
      const refused = { error: "invalid_path" };
      expect(await b().ls(bad)).toEqual(refused);
      expect(await b().read(bad, 0, 1)).toEqual(refused);
      expect(await b().write(bad, "x")).toEqual(refused);
      expect(await b().edit(bad, "a", "b", false)).toEqual(refused);
      expect(await b().glob("*", bad)).toEqual(refused);
      expect(await b().grep("x", bad)).toEqual(refused);
      expect(await b().download([bad])).toEqual([{ path: bad, ...refused }]);
    });

    it("refuses an absolute path beside the root that starts with its name", async () => {
      expect(await b().read(`${made.root}x/README`, 0, 1)).toEqual({
        error: "invalid_path",
      });
    });
  });

  describe.runIf(runs)("commands", () => {
    it("runs a command in the root, with its output, both streams, and its exit code", async () => {
      const backend = b();
      if (!canExecute(backend)) {
        expect(name).toMatch(/view/);
        return;
      }
      const result = await backend.execute("cat README; echo err >&2; exit 3");
      expect(result).toEqual({
        output: "hello\nworld\nerr\n",
        exitCode: 3,
        truncated: false,
      });
    });

    it("stops a command when its signal aborts", async () => {
      const backend = b();
      if (!canExecute(backend)) return;
      const started = Date.now();
      await expect(
        backend.execute("sleep 20", { signal: AbortSignal.timeout(500) }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });
});
