import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Options } from "./s3.ts";

/** Garage, an S3-compatible server that checks each request's signature, as a bucket to test the S3 store on. */
export const garageImage = "docker.io/dxflrs/garage:v2.1.0";

const accessKeyId = "GK000000000000000000000000";
const secretAccessKey = "1".repeat(64);

function run(args: string[]) {
  const done = spawnSync("podman", args, { encoding: "utf8" });
  if (done.status !== 0)
    throw new Error(`podman ${args.join(" ")}: ${done.stderr || done.stdout}`);
  return done.stdout.trim();
}

/**
 * A Garage of one node, its bucket `files` and a key that may read and write it, on a port of this host: the S3
 * options to reach it, and how to remove it.
 */
export async function startGarage(): Promise<S3Options & { stop: () => void }> {
  const folder = mkdtempSync(join(tmpdir(), "que-pasa-garage-"));
  writeFileSync(
    join(folder, "garage.toml"),
    [
      'metadata_dir = "/var/lib/garage/meta"',
      'data_dir = "/var/lib/garage/data"',
      'db_engine = "sqlite"',
      "replication_factor = 1",
      'rpc_bind_addr = "[::]:3901"',
      'rpc_public_addr = "127.0.0.1:3901"',
      `rpc_secret = "${"0".repeat(64)}"`,
      "[s3_api]",
      's3_region = "garage"',
      'api_bind_addr = "[::]:3900"',
    ].join("\n"),
  );
  const name = `que-pasa-garage-${process.pid}`;
  run([
    "run",
    "-d",
    "--name",
    name,
    "-p",
    "127.0.0.1::3900",
    "-v",
    `${join(folder, "garage.toml")}:/etc/garage.toml:ro`,
    "--security-opt",
    "label=disable",
    garageImage,
  ]);
  const stop = () => {
    spawnSync("podman", ["rm", "-f", "-t", "0", name], { stdio: "ignore" });
    rmSync(folder, { recursive: true, force: true });
  };
  try {
    const garage = (...args: string[]) =>
      run(["exec", name, "/garage", ...args]);
    let node = "";
    for (let tries = 0; node === "" && tries < 50; tries += 1) {
      try {
        node = garage("node", "id", "-q").split("@")[0]!;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    garage("layout", "assign", "-z", "dc1", "-c", "1G", node);
    garage("layout", "apply", "--version", "1");
    garage("bucket", "create", "files");
    garage(
      "key",
      "import",
      "--yes",
      "-n",
      "test",
      accessKeyId,
      secretAccessKey,
    );
    garage(
      "bucket",
      "allow",
      "--read",
      "--write",
      "files",
      "--key",
      accessKeyId,
    );
    const port = run(["port", name, "3900"]).split(":").at(-1);
    return {
      endpoint: `http://127.0.0.1:${port}`,
      bucket: "files",
      region: "garage",
      accessKeyId,
      secretAccessKey,
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}
