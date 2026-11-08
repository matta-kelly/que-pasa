/**
 * The file and command tools of LangChain Deep Agents, as que-pasa tools, with their names, parameters and wording:
 * ls, read_file, write_file, edit_file, glob, grep and execute. Each asks its run for the `Sandbox` the host provides,
 * and works through it: the tools hold no backend and no policy.
 */
import { z } from "zod";
import {
  defineResource,
  defineTool,
  type Json,
  type Runtime,
} from "../define/index.ts";
import { canExecute, type FileBackend, type Failed } from "./backend.ts";

/** The backend a run's file tools work in: the host provides it per run, such as a container, or a view over one. */
export const Sandbox = defineResource<FileBackend>("sandbox");

type Any = Runtime<Json | undefined>;

/** The most of a tool's answer the model gets (Deep Agents: 20,000 tokens, at four characters each). */
export const maxAnswer = 80_000;

const cutNote =
  "\n... [results truncated, try being more specific with your parameters]";

/** An answer cut to the most the model gets, at a whole line. */
function cut(text: string) {
  if (text.length <= maxAnswer) return text;
  const head = text.slice(0, maxAnswer);
  return head.slice(0, Math.max(head.lastIndexOf("\n"), 0)) + cutNote;
}

/** What the model reads for a result that did nothing. Deep Agents' strings. */
function failure(result: Failed, op: string, path: string, old = "") {
  switch (result.error) {
    case "file_not_found":
      return op === "read" || op === "edit"
        ? `Error: File '${path}' not found`
        : `Error: Path '${path}' not found`;
    case "is_directory":
      return `Error: '${path}' is a directory, not a file`;
    case "invalid_path":
      return `Error: Path traversal not allowed: ${path}`;
    case "permission_denied":
      return `Error: permission denied for ${op} on ${path}${result.message ? `: ${result.message}` : ""}`;
    case "string_not_found":
      return `Error: String not found in file: '${old}'`;
    case "string_not_unique":
      return `Error: String '${old}' appears ${(result as { occurrences?: number }).occurrences ?? "several"} times in file. Use replace_all=True to replace all instances, or provide a more specific string with surrounding context.`;
    default:
      return undefined;
  }
}

const sandbox = (runtime: Any) => runtime.use(Sandbox);

/** A path the model gives. */
const path = () =>
  z
    .string()
    .describe(
      "A path in the sandbox: relative to its root, or absolute under it.",
    );
/** A folder the model may leave out: the root. */
const folder = () => path().default(".");

export const ls = defineTool({
  name: "ls",
  description:
    "Lists the files and folders in a folder of the sandbox. A folder ends in a slash.",
  schema: z.object({ path: folder() }),
  uses: [Sandbox],
  replay: "safe",
  run: async ({ path }, runtime: Any) => {
    const result = await (await sandbox(runtime)).ls(path);
    const failed = failure(result, "ls", path);
    if (failed) return failed;
    const files = result.files ?? [];
    if (files.length === 0) return `No files found in '${path}'`;
    return cut(files.map((f) => (f.isDir ? `${f.path}/` : f.path)).join("\n"));
  },
});

export const read_file = defineTool({
  name: "read_file",
  description:
    "Reads a file from the sandbox. Assume any path the user provides is valid; reading a missing file returns an error. " +
    "By default it reads up to 100 lines from the start; use offset and limit to page through a large file. " +
    "A status header, `@@ lines A-B of T | next offset N @@`, sits above the file content, and every line after it is " +
    "the file's content, verbatim. Never include the header when editing. Always read a file before editing it.",
  schema: z.object({
    file_path: path(),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Line offset to start reading from (0-indexed)."),
    limit: z
      .number()
      .int()
      .min(1)
      .default(100)
      .describe(
        "Maximum number of lines to read. Use for pagination of large files.",
      ),
  }),
  uses: [Sandbox],
  replay: "safe",
  run: async ({ file_path, offset, limit }, runtime: Any) => {
    const result = await (
      await sandbox(runtime)
    ).read(file_path, offset, limit);
    const failed = failure(result, "read", file_path);
    if (failed) return failed;
    const total = result.totalLines ?? 0;
    if (total === 0)
      return "System reminder: File exists but has empty contents";
    if (offset >= total)
      return `Error: Line offset ${offset} exceeds file length (${total} lines)`;
    let content = result.content ?? "";
    let note = "";
    if (content.length > maxAnswer) {
      const head = content.slice(0, maxAnswer);
      content = head.slice(0, head.lastIndexOf("\n") + 1);
      note = " | truncated due to size";
    }
    const lines = content.split("\n").length - 1;
    const end = offset + lines;
    const next = end < total ? ` | next offset ${end}` : "";
    return `@@ lines ${offset + 1}-${end} of ${total}${next}${note} @@\n${content}`;
  },
});

export const write_file = defineTool({
  name: "write_file",
  description:
    "Writes content to a file in the sandbox. Creates the file, and its folder, if it does not exist; replaces it entirely if it does.",
  schema: z.object({
    file_path: path(),
    content: z
      .string()
      .describe(
        "The text content to write to the file. This parameter is required.",
      ),
  }),
  uses: [Sandbox],
  // It writes the whole file, so a second run leaves the same file as one.
  replay: "safe",
  run: async ({ file_path, content }, runtime: Any) => {
    const result = await (await sandbox(runtime)).write(file_path, content);
    return (
      failure(result, "write", file_path) ??
      `Successfully wrote to '${file_path}'`
    );
  },
});

export const edit_file = defineTool({
  name: "edit_file",
  description:
    "Performs exact string replacements in a file of the sandbox. old_string must occur exactly once, unless " +
    "replace_all is true, which replaces each one. You must read the file before editing.",
  schema: z.object({
    file_path: path(),
    old_string: z
      .string()
      .min(1)
      .describe(
        "The exact text to find and replace. Must be unique in the file unless replace_all is true.",
      ),
    new_string: z.string().describe("The text to replace it with."),
    replace_all: z
      .boolean()
      .default(false)
      .describe("Replace every occurrence of old_string."),
  }),
  uses: [Sandbox],
  // Not replay-safe: a second replace finds nothing, or replaces twice.
  run: async (
    { file_path, old_string, new_string, replace_all },
    runtime: Any,
  ) => {
    const result = await (
      await sandbox(runtime)
    ).edit(file_path, old_string, new_string, replace_all);
    return (
      failure(result, "edit", file_path, old_string) ??
      `Successfully replaced ${result.occurrences} occurrence(s) in '${file_path}'`
    );
  },
});

export const glob = defineTool({
  name: "glob",
  description:
    "Finds the files of the sandbox whose path matches a glob pattern, under a folder: `*` matches within a folder, " +
    "`**` across folders, as in `**/*.test.ts`. Paths are from the sandbox's root.",
  schema: z.object({
    pattern: z
      .string()
      .min(1)
      .describe("The glob pattern, matched against the path from `path`."),
    path: folder(),
  }),
  uses: [Sandbox],
  replay: "safe",
  run: async ({ pattern, path }, runtime: Any) => {
    const result = await (await sandbox(runtime)).glob(pattern, path);
    const failed = failure(result, "glob", path);
    if (failed) return failed;
    const files = result.files ?? [];
    if (files.length === 0)
      return `No files found matching pattern '${pattern}'`;
    return cut(files.join("\n") + (result.truncated ? cutNote : ""));
  },
});

export const grep = defineTool({
  name: "grep",
  description:
    "Search for a LITERAL text pattern across files (NOT regex), under a path, in files matching glob if given. " +
    "Gives each matching file, then each matching line with its number.",
  schema: z.object({
    pattern: z.string().min(1).describe("The text to find, as is."),
    path: folder(),
    glob: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Only files whose path from `path` matches this glob, such as `*.ts`.",
      ),
  }),
  uses: [Sandbox],
  replay: "safe",
  run: async ({ pattern, path, glob }, runtime: Any) => {
    const result = await (await sandbox(runtime)).grep(pattern, path, glob);
    const failed = failure(result, "grep", path);
    if (failed) return failed;
    const matches = result.matches ?? [];
    if (matches.length === 0)
      return `No matches found for pattern '${pattern}'`;
    const byFile = new Map<string, string[]>();
    for (const m of matches) {
      const lines = byFile.get(m.path) ?? [];
      lines.push(`  ${m.line}: ${m.text}`);
      byFile.set(m.path, lines);
    }
    const text = [...byFile]
      .map(([f, lines]) => `${f}:\n${lines.join("\n")}`)
      .join("\n");
    return cut(text + (result.truncated ? cutNote : ""));
  },
});

export const execute = defineTool({
  name: "execute",
  description:
    "Executes a shell command in the sandbox, in its root, and returns its combined stdout and stderr with the exit " +
    "code (the tail, if very large).",
  schema: z.object({
    command: z.string().min(1).describe("The shell command to run."),
  }),
  uses: [Sandbox],
  // Not replay-safe: a command can do anything.
  run: async ({ command }, runtime: Any) => {
    const backend = await sandbox(runtime);
    if (!canExecute(backend)) {
      return "Error: Execution not available. This agent's backend does not support command execution.";
    }
    const result = await backend.execute(command);
    const cutTail = result.output.length > maxAnswer;
    const output = cutTail ? result.output.slice(-maxAnswer) : result.output;
    const status =
      result.exitCode === null
        ? "[Command was killed]"
        : `[Command ${result.exitCode === 0 ? "succeeded" : "failed"} with exit code ${result.exitCode}]`;
    const truncated =
      result.truncated || cutTail
        ? "\n[Output was truncated due to size limits]"
        : "";
    return `${output}${output.endsWith("\n") || output === "" ? "" : "\n"}${status}${truncated}`;
  },
});

/** The tools that only read. */
export const readTools = [ls, read_file, glob, grep] as const;
/** The tools that read and write files. `execute` is given on its own. */
export const fileTools = [...readTools, write_file, edit_file] as const;
