import { spawn } from "node:child_process";

/** What a process gave back. */
export type Ran = {
  /** null when it was killed by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Its output was cut to its tail. */
  truncated: boolean;
};

/** One call of a script: its arguments are `$1`…, and its input goes over stdin, so neither is read by the shell. */
export type Script = {
  script: string;
  args?: readonly string[];
  stdin?: string;
  signal?: AbortSignal;
};

/** The most of each stream a process keeps: its tail, where a failure is. */
export const keep = 1_000_000;

/** Keep the last `keep` characters of a stream. */
function tail() {
  let text = "";
  let cut = false;
  return {
    add(chunk: Buffer) {
      text += chunk.toString("utf8");
      if (text.length > keep) {
        text = text.slice(-keep);
        cut = true;
      }
    },
    get text() {
      return text;
    },
    get cut() {
      return cut;
    },
  };
}

/**
 * Run a command to its end. It never rejects on a non-zero exit, only when it cannot start or the signal aborts it,
 * which kills it.
 */
export function run(
  command: string,
  args: readonly string[],
  {
    stdin,
    signal,
    cwd,
  }: { stdin?: string; signal?: AbortSignal; cwd?: string } = {},
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      ...(cwd === undefined ? {} : { cwd }),
      ...(signal === undefined ? {} : { signal }),
    });
    const out = tail();
    const err = tail();
    child.stdout?.on("data", out.add);
    child.stderr?.on("data", err.add);
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: out.text,
        stderr: err.text,
        truncated: out.cut || err.cut,
      }),
    );
    if (child.stdin) {
      // A script that exits before it reads its input closes the pipe: that is its answer, not an error.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });
}
