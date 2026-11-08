import { posix } from "node:path";

/**
 * A path as a tool gives it, as a path from the root: "" for the root itself. undefined for a path the backend refuses:
 * one that leaves the root (by `..`, or absolute and not under it), starts with `~`, or holds a control character,
 * which a line-based listing cannot carry.
 */
export function fromRoot(root: string, path: string): string | undefined {
  const given = path.trim();
  // A control character, such as a newline: no file of a backend is named with one.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(given) || given.startsWith("~"))
    return undefined;
  let p = given === "" ? "." : given;
  if (posix.isAbsolute(p)) {
    const top = posix.normalize(root).replace(/\/+$/, "");
    const at = posix.normalize(p).replace(/\/+$/, "");
    if (at === top) return "";
    if (!at.startsWith(`${top}/`)) return undefined;
    p = at.slice(top.length + 1);
  }
  const n = posix.normalize(p).replace(/\/+$/, "");
  if (n === ".." || n.startsWith("../")) return undefined;
  return n === "." ? "" : n;
}

/** A path from the root as a shell argument: "." for the root. */
export const asArg = (p: string) => p || ".";

/** Whether `path` is `folder` or under it; every path is under the root (""). */
export const isUnder = (path: string, folder: string) =>
  folder === "" || path === folder || path.startsWith(`${folder}/`);
