import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { imageTypes } from "../define/index.ts";
import type { FileStore, StoredFile } from "./store.ts";

/** What a folder keeps beside a file's bytes: `<key>.json`. */
type Meta = Pick<StoredFile, "mediaType" | "name">;

/**
 * A store in a folder on disk: a bucket for one server, such as a deployment's own volume, or local development. A
 * file's bytes are at `<root>/<key>`, its type and name at `<root>/<key>.json`. Each is written to a temporary name,
 * then renamed, so a crash never leaves half a file; the bytes go last, so a file with bytes is whole.
 */
export function folderFiles({ root }: { root: string }): FileStore {
  const base = resolve(root);

  /** The path of a key, which must stay under the root. */
  function pathOf(key: string) {
    const path = resolve(base, key);
    if (!path.startsWith(base + sep))
      throw new RangeError(`file key "${key}": it is outside the store`);
    return path;
  }

  async function atomically(path: string, data: Uint8Array | string) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, path);
  }

  return {
    put: async (key, { data, mediaType, name }) => {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true });
      await atomically(
        `${path}.json`,
        JSON.stringify({ mediaType, name } satisfies Meta),
      );
      await atomically(path, data);
    },
    get: async (key) => {
      const path = pathOf(key);
      let data: Buffer;
      try {
        data = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      const meta = JSON.parse(await readFile(`${path}.json`, "utf8")) as Meta;
      if (!(imageTypes as readonly string[]).includes(meta.mediaType))
        throw new Error(
          `file "${key}": its type "${meta.mediaType}" is not an image's`,
        );
      return {
        data: new Uint8Array(data),
        mediaType: meta.mediaType,
        name: meta.name,
      };
    },
  };
}
