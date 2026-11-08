import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { SandboxBackend } from "./backend.ts";
import { run, type Ran } from "./process.ts";
import { shellBackend } from "./shell.ts";

/** A folder of the host in the container. */
export type Mount = { source: string; target: string; readOnly?: boolean };

/** One container, as the host sets it: what it runs, what it sees, and what bounds it. */
export type PodmanOptions = {
  /** The container's name: one per sandbox, so a process that starts again finds it. */
  name: string;
  image: string;
  /** The host folders it sees. Nothing else of the host is in it. */
  mounts: readonly Mount[];
  /** Its root: every path is under it. */
  workdir?: string;
  /** "none" by default: no network. */
  network?: string;
  /** The user commands run as, such as "1000:1000". */
  user?: string;
  /** Such as "4g". */
  memory?: string;
  /** Such as 3. */
  cpus?: number;
  /** Any other `podman run` options, such as `--userns=keep-id`. */
  runArgs?: readonly string[];
};

/** The label that holds a hash of the options a container was made with. */
const label = "que-pasa.sandbox";

/** podman's exit code for a container that is not there. */
const noContainer = 125;

/** A Podman container that outlives the process, as a backend. */
export type Podman = SandboxBackend & {
  /** Remove the container. The next call makes it again. */
  close(): Promise<void>;
};

/**
 * A Podman container as a backend: every operation execs into it, so its mounts, its network and its limits are the
 * wall. It is made on its first call and kept: started again if it stopped, made again if it is gone, so a run that
 * resumes after a restart works with no host step. One made with other options is refused, never used.
 */
export function podman(options: PodmanOptions): Podman {
  const { name, image, mounts, workdir = "/work" } = options;
  if (!posix.isAbsolute(workdir))
    throw new Error(`podman: the workdir must be absolute, not "${workdir}"`);
  const config = createHash("sha256")
    .update(
      JSON.stringify([
        image,
        mounts,
        workdir,
        options.network ?? "none",
        options.user ?? null,
        options.memory ?? null,
        options.cpus ?? null,
        options.runArgs ?? [],
      ]),
    )
    .digest("hex")
    .slice(0, 16);

  const podmanOf = async (
    args: string[],
    stdin?: string,
    signal?: AbortSignal,
  ) =>
    run("podman", args, {
      ...(stdin === undefined ? {} : { stdin }),
      ...(signal === undefined ? {} : { signal }),
    });
  const must = (what: string, ran: Ran) => {
    if (ran.code !== 0)
      throw new Error(
        `podman ${what} ${name}: exit ${ran.code}: ${(ran.stderr || ran.stdout).trim().slice(-400)}`,
      );
    return ran.stdout.trim();
  };

  /** The container's label and whether it runs, or undefined when there is none. */
  async function inspect() {
    const ran = await podmanOf([
      "container",
      "inspect",
      "--format",
      `{{index .Config.Labels "${label}"}} {{.State.Running}}`,
      name,
    ]);
    if (ran.code !== 0) return undefined;
    const [made, running] = ran.stdout.trim().split(" ");
    return { made, running: running === "true" };
  }

  /** Keep it, start it, or make it: and refuse one made with other options. */
  async function ensure() {
    let found = await inspect();
    if (!found) {
      const made = await podmanOf([
        "run",
        "--detach",
        "--name",
        name,
        "--label",
        `${label}=${config}`,
        "--network",
        options.network ?? "none",
        ...(options.user ? ["--user", options.user] : []),
        ...(options.memory ? ["--memory", options.memory] : []),
        ...(options.cpus ? ["--cpus", String(options.cpus)] : []),
        ...(options.runArgs ?? []),
        ...mounts.flatMap((m) => [
          "--volume",
          `${m.source}:${m.target}${m.readOnly ? ":ro" : ""}`,
        ]),
        "--workdir",
        workdir,
        image,
        "sleep",
        "infinity",
      ]);
      if (made.code === 0) return;
      // Another process made it first: it is checked as any found one.
      found = await inspect();
      if (!found) must("run", made);
    }
    if (found!.made !== config) {
      throw new Error(
        `podman: the container "${name}" was made with other options: remove it, or give this sandbox another name`,
      );
    }
    if (!found!.running) must("start", await podmanOf(["start", name]));
  }

  let ready: Promise<void> | undefined;
  const ensured = () => {
    ready ??= ensure().catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

  const backend = shellBackend({
    id: name,
    root: workdir,
    async exec({ script, args = [], stdin, signal }) {
      const call = async () => {
        await ensured();
        return podmanOf(
          [
            "exec",
            ...(stdin === undefined ? [] : ["--interactive"]),
            "--workdir",
            workdir,
            name,
            "sh",
            "-c",
            script,
            "sh",
            ...args,
          ],
          stdin,
          signal,
        );
      };
      const ran = await call();
      // Gone since it was made, such as by a host restart: made again, once.
      if (ran.code === noContainer && !(await inspect())) {
        ready = undefined;
        return call();
      }
      return ran;
    },
  });

  return {
    ...backend,
    async close() {
      ready = undefined;
      must(
        "rm",
        await podmanOf(["rm", "--force", "--ignore", "--time", "0", name]),
      );
    },
  };
}
