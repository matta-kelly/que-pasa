import { spawnSync } from "node:child_process";

/** The image the podman tests run: small, with BusyBox, so the shell backend is checked on no more than POSIX. */
export const image = "docker.io/library/alpine:3.20.3";

/** Whether podman is here: the dev image has none, so the check skips them; the publish job's runner has it, so a release runs them. */
export const hasPodman =
  spawnSync("podman", ["--version"], { stdio: "ignore" }).status === 0;
