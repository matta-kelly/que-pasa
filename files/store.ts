import type { ImageType } from "../define/index.ts";

/** A file as a store keeps it: its bytes, its type, and its name. */
export type StoredFile = {
  data: Uint8Array;
  mediaType: ImageType;
  name: string;
};

/**
 * Where a deployment keeps the images its tools make: a bucket, behind two calls. A conversation keeps only each
 * file's link; the bytes are here, by key.
 */
export interface FileStore {
  /** Keep a file at `key`. One there already is replaced. */
  put(key: string, file: StoredFile): Promise<void>;
  /** The file at `key`, or undefined when none is there. */
  get(key: string): Promise<StoredFile | undefined>;
}

/**
 * The key of a conversation's file: one folder per conversation, by pi's id, never the client's key, which is any
 * string and is used again by a new conversation after a delete. The one place the layout lives.
 */
export function fileKey(conversationId: string | number, fileId: string) {
  return `conversations/${String(conversationId)}/${fileId}`;
}

/** A store in memory, for tests: gone when the process ends. */
export function memoryFiles(): FileStore {
  const files = new Map<string, StoredFile>();
  return {
    put: async (key, file) => {
      files.set(key, { ...file, data: file.data.slice() });
    },
    get: async (key) => {
      const file = files.get(key);
      return file && { ...file, data: file.data.slice() };
    },
  };
}
