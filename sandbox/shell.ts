import { posix } from "node:path";
import type {
  EditResult,
  ExecuteResult,
  FileInfo,
  GlobResult,
  GrepMatch,
  GrepResult,
  LsResult,
  ReadResult,
  SandboxBackend,
  WriteResult,
} from "./backend.ts";
import { asArg, fromRoot } from "./paths.ts";
import type { Ran, Script } from "./process.ts";

/** Runs one script in the backend's root: `sh -c <script> sh <args…>`, with its stdin. */
export type Exec = (call: Script) => Promise<Ran>;

/** How a script says why it did nothing. Any other failure is the backend's, and throws. */
const missing = 3;
const directory = 4;

/** The most matches grep gives back. */
export const maxMatches = 1000;
/** How many files one grep call reads. */
const batch = 200;

const invalid = { error: "invalid_path" } as const;

/** A path as the backend gives it in a result: from the root, with no `./`. */
const clean = (p: string) => posix.normalize(p).replace(/^\.\//, "");

/** A script's failure that is none of the ones it says: the backend's own, such as a read-only file system. */
function failed(what: string, ran: Ran): never {
  throw new Error(
    `${what}: exit ${ran.code ?? "killed"}: ${(ran.stderr || ran.stdout).trim().slice(-400)}`,
  );
}

/**
 * A whole sandbox backend in POSIX `sh`, on one primitive that runs a script in the root (Deep Agents' `BaseSandbox`).
 * A path is always a positional argument and content always goes over stdin: nothing a model gives is part of a
 * script. It needs no other runtime in the sandbox: `find`, `awk`, `grep`, `cat`, `mkdir` and `dirname`, which
 * BusyBox has too.
 */
export function shellBackend({
  id,
  root,
  exec,
}: {
  id: string;
  root: string;
  exec: Exec;
}): SandboxBackend {
  /** Every file under a path, from the root, `.git` left out. undefined when the path is not there. */
  async function filesUnder(at: string): Promise<string[] | undefined> {
    const ran = await exec({
      script: `[ -e "$1" ] || exit ${missing}; find "$1" -name .git -prune -o -type f -print0`,
      args: [asArg(at)],
    });
    if (ran.code === missing) return undefined;
    if (ran.code !== 0) failed("glob", ran);
    const names = ran.stdout.split("\0").filter(Boolean);
    // A cut output starts mid-name: that one is dropped.
    if (ran.truncated) names.shift();
    return names.map(clean);
  }

  /** The files under a path whose path from it matches a glob. */
  async function matching(at: string, pattern: string) {
    const files = await filesUnder(at);
    return files?.filter((f) => {
      const from =
        f === at ? posix.basename(f) : at ? f.slice(at.length + 1) : f;
      return posix.matchesGlob(from, pattern);
    });
  }

  return {
    id,
    root,

    async ls(path): Promise<LsResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const ran = await exec({
        script: `if [ -d "$1" ]; then
  find "$1" -mindepth 1 -maxdepth 1 -exec sh -c 'for f; do if [ -d "$f" ]; then printf "d%s\\0" "$f"; else printf "f%s\\0" "$f"; fi; done' sh {} +
elif [ -e "$1" ]; then printf "f%s\\0" "$1"
else exit ${missing}; fi`,
        args: [asArg(at)],
      });
      if (ran.code === missing) return { error: "file_not_found" };
      if (ran.code !== 0) failed("ls", ran);
      const files: FileInfo[] = ran.stdout
        .split("\0")
        .filter(Boolean)
        .map((entry) => ({
          path: clean(entry.slice(1)),
          isDir: entry[0] === "d",
        }))
        .sort((a, b) => a.path.localeCompare(b.path));
      return { files };
    },

    async read(path, offset, limit): Promise<ReadResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const ran = await exec({
        script: `[ -e "$1" ] || exit ${missing}; [ -d "$1" ] && exit ${directory}; awk -v o="$2" -v l="$3" 'NR > o && NR <= o + l { print } END { printf "%d", NR }' "$1"`,
        args: [asArg(at), String(offset), String(limit)],
      });
      if (ran.code === missing) return { error: "file_not_found" };
      if (ran.code === directory) return { error: "is_directory" };
      if (ran.code !== 0) failed("read", ran);
      // The lines, then the file's line count, with no newline after it.
      const last = ran.stdout.lastIndexOf("\n");
      return {
        content: ran.stdout.slice(0, last + 1),
        totalLines: Number(ran.stdout.slice(last + 1)),
      };
    },

    async write(path, content): Promise<WriteResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const ran = await exec({
        script: `[ -d "$1" ] && exit ${directory}; mkdir -p -- "$(dirname -- "$1")" && cat > "$1"`,
        args: [asArg(at)],
        stdin: content,
      });
      if (ran.code === directory) return { error: "is_directory" };
      if (ran.code !== 0) failed("write", ran);
      return { path: at };
    },

    async edit(path, old, next, all): Promise<EditResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const read = await exec({
        script: `[ -e "$1" ] || exit ${missing}; [ -d "$1" ] && exit ${directory}; cat -- "$1"`,
        args: [asArg(at)],
      });
      if (read.code === missing) return { error: "file_not_found" };
      if (read.code === directory) return { error: "is_directory" };
      if (read.code !== 0) failed("edit", read);
      const occurrences = read.stdout.split(old).length - 1;
      if (occurrences === 0) return { error: "string_not_found" };
      if (occurrences > 1 && !all)
        return { error: "string_not_unique", occurrences };
      // The function form: a `$` in the new text is text, never a replacement pattern.
      const text = all
        ? read.stdout.split(old).join(next)
        : read.stdout.replace(old, () => next);
      const wrote = await exec({
        script: `cat > "$1"`,
        args: [asArg(at)],
        stdin: text,
      });
      if (wrote.code !== 0) failed("edit", wrote);
      return { path: at, occurrences: all ? occurrences : 1 };
    },

    async glob(pattern, path): Promise<GlobResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const files = await matching(at, pattern);
      if (!files) return { error: "file_not_found" };
      return { files: files.sort() };
    },

    async grep(pattern, path, glob): Promise<GrepResult> {
      const at = fromRoot(root, path);
      if (at === undefined) return invalid;
      const files = glob ? await matching(at, glob) : await filesUnder(at);
      if (!files) return { error: "file_not_found" };
      // No line holds a newline, so a text with one is in no file.
      if (pattern.includes("\n")) return { matches: [] };
      const matches: GrepMatch[] = [];
      for (
        let i = 0;
        i < files.length && matches.length <= maxMatches;
        i += batch
      ) {
        const some = files.slice(i, i + batch);
        const ran = await exec({
          script: `p="$1"; shift; grep -nHF -e "$p" -- "$@"`,
          args: [pattern, ...some],
        });
        // 1: no match. 2: a file it could not read, such as one gone since the listing; the others still count.
        if (ran.code !== 0 && ran.code !== 1 && ran.code !== 2)
          failed("grep", ran);
        // A line is "<file>:<n>:<text>", and a file's name can hold ":": the longest file of the batch that starts it.
        const named = [...some].sort((a, b) => b.length - a.length);
        for (const line of ran.stdout.split("\n")) {
          const file = named.find((f) => line.startsWith(`${f}:`));
          if (!file) continue;
          const rest = line.slice(file.length + 1);
          const colon = rest.indexOf(":");
          const n = Number(rest.slice(0, colon));
          if (colon < 1 || !Number.isInteger(n)) continue;
          matches.push({ path: file, line: n, text: rest.slice(colon + 1) });
        }
      }
      const truncated = matches.length > maxMatches;
      return {
        matches: matches.slice(0, maxMatches),
        ...(truncated ? { truncated } : {}),
      };
    },

    async execute(command, options = {}): Promise<ExecuteResult> {
      const ran = await exec({
        script: `exec 2>&1; eval "$1"`,
        args: [command],
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return {
        output: ran.stdout + ran.stderr,
        exitCode: ran.code,
        truncated: ran.truncated,
      };
    },
  };
}
