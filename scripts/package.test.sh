#!/usr/bin/env bash
# The test of the package another project installs: each export in package.json, from the packed tarball.
# It packs dist/ as `npm publish` would, unpacks it in a temp folder, and links this repo's node_modules for its
# dependencies. Each export's `types` file must be in the tarball, and its `default` must import, by the package's
# own name, so the exports map resolves as it does for a project that installs it.
# Run it after the build: npm run build && scripts/package.test.sh. Exit 1 if an export does not resolve.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd -P)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

tarball=$(cd "$repo" && npm pack --silent --pack-destination "$T")
tar -xzf "$T/$tarball" -C "$T"
ln -s "$repo/node_modules" "$T/package/node_modules"

cat >"$T/package/exports.test.mjs" <<'JS'
import { existsSync, readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
let failed = 0;
for (const [path, target] of Object.entries(pkg.exports)) {
  const name = pkg.name + path.slice(1);
  try {
    if (!existsSync(target.types)) throw new Error(`no ${target.types} in the tarball`);
    const module = await import(name);
    if (Object.keys(module).length === 0) throw new Error("it exports nothing");
    console.log(`ok ${name}`);
  } catch (error) {
    failed = 1;
    console.log(`not ok ${name}: ${error.message}`);
  }
}
process.exit(failed);
JS
cd "$T/package" && node exports.test.mjs
