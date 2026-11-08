/**
 * A backend: the place where a run's files are and its commands run, behind one interface. Two abilities, as in
 * LangChain Deep Agents' backend protocol: files (`FileBackend`), and commands on top of files (`SandboxBackend`).
 * Every path is the backend's own: relative to its root, or absolute under it. Every path a result gives is relative to
 * the root. A backend gives its errors back in the result, and throws only when it cannot run at all.
 */

/** Why an operation did nothing. Deep Agents' file errors, and the two of an edit. */
export type FileError =
  | "file_not_found"
  | "is_directory"
  | "invalid_path"
  | "permission_denied"
  | "string_not_found"
  | "string_not_unique";

/** What every result can say: that the operation did nothing, and why. `message` says more, for the model. */
export type Failed = { error?: FileError; message?: string };

export type FileInfo = { path: string; isDir: boolean };
export type LsResult = Failed & { files?: FileInfo[] };
export type ReadResult = Failed & {
  /** The lines asked for, each with its newline. */
  content?: string;
  /** How many lines the file has. */
  totalLines?: number;
};
export type WriteResult = Failed & { path?: string };
export type EditResult = Failed & { path?: string; occurrences?: number };
export type GlobResult = Failed & { files?: string[]; truncated?: boolean };
export type GrepMatch = { path: string; line: number; text: string };
export type GrepResult = Failed & {
  matches?: GrepMatch[];
  truncated?: boolean;
};
export type ExecuteResult = {
  /** stdout and stderr, as they came. */
  output: string;
  /** null when the command was killed by a signal. */
  exitCode: number | null;
  /** The output kept only its tail. */
  truncated: boolean;
};

/** Files: read, write and search them. */
export interface FileBackend {
  /** The folder every path is under. */
  readonly root: string;
  /** What a folder holds, or the file itself. */
  ls(path: string): Promise<LsResult>;
  /** `limit` lines of a file, after the first `offset`. */
  read(path: string, offset: number, limit: number): Promise<ReadResult>;
  /** A file, whole, made with its folder if it has none. It replaces what was there. */
  write(path: string, content: string): Promise<WriteResult>;
  /** Replace `old` with `next` in a file: it must occur once, unless `all`. */
  edit(
    path: string,
    old: string,
    next: string,
    all: boolean,
  ): Promise<EditResult>;
  /** The files under a folder whose path from that folder matches a glob. */
  glob(pattern: string, path: string): Promise<GlobResult>;
  /** The lines of the files under a path that hold a text, as is (not a pattern), in files matching `glob` if given: by path, then line. */
  grep(pattern: string, path: string, glob?: string): Promise<GrepResult>;
}

/** Files, and commands: a backend that can run a shell command. */
export interface SandboxBackend extends FileBackend {
  /** Names this sandbox, such as its container. */
  readonly id: string;
  /** Run a shell command in the root. The signal kills it. */
  execute(
    command: string,
    options?: { signal?: AbortSignal },
  ): Promise<ExecuteResult>;
}

/** Whether a backend can run commands. */
export function canExecute(backend: FileBackend): backend is SandboxBackend {
  return typeof (backend as Partial<SandboxBackend>).execute === "function";
}
