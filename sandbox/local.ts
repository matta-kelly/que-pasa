import { isAbsolute } from "node:path";
import type { SandboxBackend } from "./backend.ts";
import { run } from "./process.ts";
import { shellBackend } from "./shell.ts";

/**
 * A folder on the host as a backend: files and commands run as the host's own user. No wall: a path is checked
 * against the root, but a symlink, or any command, reaches the whole host. For the host's own trusted work, and tests.
 */
export function local({ root }: { root: string }): SandboxBackend {
  if (!isAbsolute(root))
    throw new Error(`local: the root must be absolute, not "${root}"`);
  return shellBackend({
    id: `local:${root}`,
    root,
    exec: ({ script, args = [], stdin, signal }) =>
      run("sh", ["-c", script, "sh", ...args], {
        cwd: root,
        ...(stdin === undefined ? {} : { stdin }),
        ...(signal === undefined ? {} : { signal }),
      }),
  });
}
