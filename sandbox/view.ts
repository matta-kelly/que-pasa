import { posix } from "node:path";
import type { FileBackend, GrepMatch } from "./backend.ts";
import { fromRoot, isUnder } from "./paths.ts";

/** The files a view holds: paths from the backend's root, or absolute under it. */
export type ViewPaths = {
  /** The files it may read. */
  read: readonly string[];
  /** The files it may write: it may read them too. */
  write: readonly string[];
};

/**
 * A backend over a backend, limited to some files: to its tools, a path outside the view does not exist, and a write
 * outside its write files is refused. It has no execute, since a shell reaches any path. It checks names, so it is a
 * wall only over a backend that is one, such as a container whose mounts hold no more than the view's folder.
 *
 * Deep Agents' path rules answer a path outside them as denied; a view answers it as missing, so the model keeps to its
 * task and does not probe.
 */
export function view(backend: FileBackend, paths: ViewPaths): FileBackend {
  const { root } = backend;
  const checked = (list: readonly string[]) =>
    list.map((p) => {
      const at = fromRoot(root, p);
      if (!at) throw new Error(`view: "${p}" is not a file under ${root}`);
      return at;
    });
  const writes = new Set(checked(paths.write));
  const files = [...new Set([...checked(paths.read), ...writes])];

  /** A path of the view: one of its files, or a folder on the way to one. */
  const sees = (at: string) => files.some((f) => f === at || isUnder(f, at));
  /** A path the view resolves, or undefined when it is outside the root. */
  const at = (path: string) => fromRoot(root, path);
  const missing = { error: "file_not_found" } as const;
  const invalid = { error: "invalid_path" } as const;
  /** The view's files under a folder whose path from it matches a glob: its own list, never the folder's. */
  const under = (folder: string, glob?: string) =>
    files.filter((f) => {
      // A search leaves out .git, as a backend's does.
      if (!isUnder(f, folder) || f.split("/").includes(".git")) return false;
      const from =
        f === folder
          ? posix.basename(f)
          : folder
            ? f.slice(folder.length + 1)
            : f;
      return glob === undefined || posix.matchesGlob(from, glob);
    });
  /** Which of the files are there: a write file can be one not made yet. */
  const present = async (list: string[]) => {
    const there = await Promise.all(
      list.map(async (f) => {
        const listed = await backend.ls(f);
        return listed.files?.some((e) => e.path === f && !e.isDir) ?? false;
      }),
    );
    return list.filter((_, i) => there[i]);
  };
  const refused = (path: string) => ({
    error: "permission_denied" as const,
    message: `${path} is not a file this view may write: it may write ${[...writes].join(", ") || "none"}`,
  });

  return {
    root,
    async ls(path) {
      const p = at(path);
      if (p === undefined) return invalid;
      if (!sees(p)) return missing;
      const listed = await backend.ls(path);
      return listed.files
        ? { files: listed.files.filter((f) => sees(f.path)) }
        : listed;
    },
    async read(path, offset, limit) {
      const p = at(path);
      if (p === undefined) return invalid;
      return sees(p) ? backend.read(path, offset, limit) : missing;
    },
    async write(path, content) {
      const p = at(path);
      if (p === undefined) return invalid;
      return writes.has(p) ? backend.write(path, content) : refused(path);
    },
    async edit(path, old, next, all) {
      const p = at(path);
      if (p === undefined) return invalid;
      return writes.has(p) ? backend.edit(path, old, next, all) : refused(path);
    },
    async glob(pattern, path) {
      const p = at(path);
      if (p === undefined) return invalid;
      if (!sees(p)) return missing;
      return { files: (await present(under(p, pattern))).sort() };
    },
    async grep(pattern, path, glob) {
      const p = at(path);
      if (p === undefined) return invalid;
      if (!sees(p)) return missing;
      // Each of its files on its own, so files outside the view are never read.
      const matches: GrepMatch[] = [];
      for (const f of (await present(under(p, glob))).sort()) {
        const found = await backend.grep(pattern, f);
        matches.push(...(found.matches ?? []));
      }
      return { matches };
    },
  };
}
