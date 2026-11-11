import type { FileBackend } from "./backend.ts";
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
  const mine = new Set(files);

  /** A path of the view: one of its files, or a folder on the way to one. */
  const sees = (at: string) => files.some((f) => f === at || isUnder(f, at));
  /** A path the view resolves, or undefined when it is outside the root. */
  const at = (path: string) => fromRoot(root, path);
  const missing = { error: "file_not_found" } as const;
  const invalid = { error: "invalid_path" } as const;
  /** A path the backend gave back that is one of the view's files. */
  const own = (path: string) => mine.has(path);
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
    async download(paths) {
      // One backend call for the paths the view sees; each other path answers as read does.
      const seen = paths.filter((path) => {
        const p = at(path);
        return p !== undefined && sees(p);
      });
      const got = seen.length > 0 ? await backend.download(seen) : [];
      return paths.map((path) => {
        const p = at(path);
        if (p === undefined) return { path, ...invalid };
        if (!sees(p)) return { path, ...missing };
        return got[seen.indexOf(path)]!;
      });
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
    // A search runs once on the backend, and the view keeps its own files: Deep Agents filters its path rules' results
    // the same way. The backend's limit counts files outside the view too, so a cut result says it is cut.
    async glob(pattern, path) {
      const p = at(path);
      if (p === undefined) return invalid;
      if (!sees(p)) return missing;
      const found = await backend.glob(pattern, path);
      return found.files ? { ...found, files: found.files.filter(own) } : found;
    },
    async grep(pattern, path, glob) {
      const p = at(path);
      if (p === undefined) return invalid;
      if (!sees(p)) return missing;
      const found = await backend.grep(pattern, path, glob);
      return found.matches
        ? { ...found, matches: found.matches.filter((m) => own(m.path)) }
        : found;
    },
  };
}
