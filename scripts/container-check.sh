#!/usr/bin/env bash
# The integration tests for que-pasa's dev image (.devcontainer/Containerfile) and its dev container
# (.devcontainer/devcontainer.json). They drive the real engine and the real dev container CLI, so they run
# on the host: `scripts/container-check.sh`, `scripts/container-check.sh <name>...` for some of them, and
# `scripts/container-check.sh --list` to list them. Some of them remove this checkout's container and its
# volumes, so do not run them under a session that uses them.
#
# They are not a step of scripts/check.sh: that file runs inside the dev container, where the engine is
# not, and its steps stay as they are. Where they cannot run they say why and exit 0: a machine with no
# engine (the pipeline's runner), or a container.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
engine=${ENGINE:-podman}
# The label the CLI sets on this checkout's container. Nothing here reads the name the CLI gives it.
label="devcontainer.local_folder=$root"
# The version the machine has. The CLI names the container's volumes, so the tests hold one version, not
# whatever a later one would answer.
CLI=(npx --yes @devcontainers/cli@0.90.0)
# The dev image the file names: ghcr's tag, which the dev-image workflow moves on main.
DEV_IMAGE_REF=ghcr.io/matta-kelly/que-pasa-dev:main
# A fresh worktree's `just up` must be done, installed from the dev image's cache, within this many
# seconds. A little over twice the probe's 26.4 s for que's whole `up`; the pull is once per machine per
# image, and is not in it.
BOUND=60
# The image the dev image is built from. It has no npm cache, so the smoke's offline install fails on it.
NODE_IMAGE=mcr.microsoft.com/devcontainers/javascript-node:22
# The dev image's tests build this tag once per run, and the run removes it at the exit.
DEV_IMAGE=localhost/que-pasa-dev:check

skip() {
  echo "SKIP: $*"
  exit 0
}

[ ! -e /run/.containerenv ] && [ ! -e /.dockerenv ] ||
  skip "inside a container, where $engine is not; run the container tests on the host"
for cmd in "$engine" just jq npx; do
  command -v "$cmd" >/dev/null 2>&1 ||
    skip "the container tests need $cmd on the host; the pipeline runs scripts/check.sh with no engine"
done

cleanup() {
  "$engine" image rm -f "$DEV_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# --- the machine, read ---

# The id of this checkout's container, or empty. Read by the label the CLI sets by default, so nothing
# here depends on the CLI's name for it.
cid() {
  "$engine" ps -a --filter "label=$label" --format '{{.ID}}' | head -1
}

field() {
  "$engine" inspect --format "$2" "$1"
}

# The configuration the CLI reads from the file, with ${containerWorkspaceFolder} substituted. Prints the
# CLI's JSON on stdout, and nothing when the file does not read: the CLI's own log is on stderr.
config() {
  "${CLI[@]}" read-configuration --workspace-folder "$root" --docker-path "$engine" 2>/dev/null
}

# The volume the file names for the workspace's node_modules, as the CLI resolves ${devcontainerId}.
# The CLI substitutes that id only while a container for the folder exists.
file_volume() {
  config |
    jq -r --arg target "target=$root/node_modules" \
      '.configuration.mounts[]? | select(contains($target)) | capture("source=(?<source>[^,]+)").source' |
    head -1
}

# Remove what this checkout holds, however it was made, so a test starts on a bare folder. A container
# first, whose mounts say which volumes are this checkout's; then the volume the file names, in case a
# container is already gone.
clean() {
  local id v
  for id in $("$engine" ps -aq --filter "label=$label"); do
    for v in $(field "$id" '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}'); do
      "$engine" volume rm -f "$v" >/dev/null 2>&1 || true
    done
    "$engine" rm -f "$id" >/dev/null 2>&1 || true
  done
  v=$(file_volume 2>/dev/null || true)
  if [ -n "$v" ]; then "$engine" volume rm -f "$v" >/dev/null 2>&1 || true; fi
}

# --- assertions ---

fail() {
  printf '  %s\n' "$*" >&2
  return 1
}

assert_eq() {
  [ "$1" = "$2" ] && return 0
  fail "$3: expected [$1], got [$2]"
}

assert_ne() {
  [ "$1" != "$2" ] && return 0
  fail "$3: expected a value other than [$1]"
}

assert_contains() {
  case $1 in *"$2"*) return 0 ;; esac
  fail "$3: expected to contain [$2], got [$1]"
}

# --- the dev image ---

# Given the checkout, when the dev image is built, then the smoke passes on it: the offline install of
# package-lock.json from the baked npm cache works with no network, and its last line says so.
test_the_dev_image_passes_its_smoke() {
  cd "$root" || return 1
  local out code last
  assert_eq 0 "$image_rc" "the dev image builds from .devcontainer/Containerfile" || return 1
  out=$(scripts/dev-image-smoke.sh "$DEV_IMAGE" 2>&1)
  code=$?
  last=$(tail -n 1 <<<"$out")
  assert_eq 0 "$code" "the smoke passes on the dev image: $out" || return 1
  assert_eq "dev image smoke: ok" "$last" "the smoke's last line says the image is ok" || return 1
}

# Given the base image with no npm cache, when the smoke runs on it, then it exits non-zero and names
# the offline install of package-lock.json, so a cache that is missing fails the build, not a later run.
test_the_smoke_fails_an_image_with_no_cache() {
  cd "$root" || return 1
  local out code
  out=$(scripts/dev-image-smoke.sh "$NODE_IMAGE" 2>&1)
  code=$?
  assert_ne 0 "$code" "the smoke fails on an image with no npm cache: $out" || return 1
  assert_contains "$out" "the offline install of package-lock.json" \
    "the smoke names the offline install of package-lock.json" || return 1
}

# Given the built image, when it is inspected, then GitHub's job container can write the workspace (no
# user, or root), the npm cache is at /opt/npm-cache and preferred offline, and the source label is
# que-pasa's repo.
test_the_dev_image_has_its_paths_and_runs_as_root() {
  cd "$root" || return 1
  local user env label
  assert_eq 0 "$image_rc" "the dev image builds from .devcontainer/Containerfile" || return 1
  user=$("$engine" inspect --format '{{.Config.User}}' "$DEV_IMAGE")
  [ -z "$user" ] || [ "$user" = root ] || {
    fail "the image's user: expected empty or root, got [$user]"
    return 1
  }
  env=$("$engine" inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$DEV_IMAGE")
  assert_contains "$env" "npm_config_cache=/opt/npm-cache" "the image's env has the npm cache at /opt/npm-cache" || return 1
  assert_contains "$env" "npm_config_prefer_offline=true" "the image's env prefers the offline cache" || return 1
  label=$("$engine" inspect --format '{{index .Config.Labels "org.opencontainers.image.source"}}' "$DEV_IMAGE")
  assert_eq "https://github.com/matta-kelly/que-pasa" "$label" "the image's source label is que-pasa's repo" || return 1
}

# --- the dev container's file ---

# Given the file, when the CLI reads it, then it names the dev image and pulls it first: the CLI never
# pulls a tag it has, and runs initializeCommand on the host before it resolves the image.
test_the_file_names_the_dev_image_and_pulls_it_first() {
  local code conf image init
  conf=$(config)
  code=$?
  assert_eq 0 "$code" "the CLI reads .devcontainer/devcontainer.json" || return 1
  image=$(jq -r '.configuration.image // empty' <<<"$conf")
  assert_eq "$DEV_IMAGE_REF" "$image" "the file names the dev image" || return 1
  init=$(jq -r '.configuration.initializeCommand // empty' <<<"$conf")
  assert_contains "$init" "podman pull $DEV_IMAGE_REF" "initializeCommand pulls the dev image first" || return 1
}

# Given the dev image pulled and this checkout clean, when `just up` runs, then the container is up within
# the bound, from the dev image's digest, with the install's node_modules and tsc in it: the install reads
# the image's cache, so a fresh worktree fetches almost nothing.
#
# It removes this checkout's container and its volumes, so do not run it under a session that uses them.
test_a_fresh_container_is_up_from_the_dev_image_within_the_bound() {
  cd "$root" || return 1
  local out code id started elapsed want got
  out=$("$engine" pull "$DEV_IMAGE_REF" 2>&1)
  code=$?
  assert_eq 0 "$code" "the dev image pulls: $out" || return 1
  clean
  started=$(date +%s%3N)
  out=$(just up 2>&1)
  code=$?
  elapsed=$(($(date +%s%3N) - started))
  assert_eq 0 "$code" "a fresh just up makes the container: $out" || return 1
  id=$(cid)
  [ -n "$id" ] || {
    fail "just up left no container for the folder"
    return 1
  }
  if [ "$elapsed" -gt $((BOUND * 1000)) ]; then
    fail "a fresh container took ${elapsed}ms: the bound is ${BOUND}s"
    return 1
  fi
  want=$("$engine" image inspect --format '{{.Digest}}' "$DEV_IMAGE_REF") || return 1
  got=$(field "$id" '{{.ImageDigest}}')
  assert_eq "$want" "$got" "the container's image is the dev image's digest" || return 1
  out=$("$engine" exec -u node -w "$root" "$id" test -f node_modules/.package-lock.json 2>&1)
  code=$?
  assert_eq 0 "$code" "the container has node_modules/.package-lock.json from the install: $out" || return 1
  out=$("$engine" exec -u node -w "$root" "$id" npx tsc --version 2>&1)
  code=$?
  assert_eq 0 "$code" "npx tsc --version exits 0 in the container as node: $out" || return 1
}

# --- the runner ---

TESTS=(
  test_the_dev_image_passes_its_smoke
  test_the_smoke_fails_an_image_with_no_cache
  test_the_dev_image_has_its_paths_and_runs_as_root
  test_the_file_names_the_dev_image_and_pulls_it_first
  test_a_fresh_container_is_up_from_the_dev_image_within_the_bound
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${TESTS[@]}"
  exit 0
fi

selected=("${TESTS[@]}")
if [ "$#" -gt 0 ]; then
  selected=("$@")
fi

# The image under test is built once per run, and only when a case needs it. Its tests read this
# result, so a build that fails fails those cases at their first assertion.
image_rc=0
needs_image=0
for name in "${selected[@]}"; do
  case "$name" in
  test_the_dev_image_* | test_the_smoke_*) needs_image=1 ;;
  esac
done
if [ "$needs_image" = 1 ]; then
  "$engine" build -f "$root/.devcontainer/Containerfile" -t "$DEV_IMAGE" "$root" || image_rc=$?
fi

failed=()
for name in "${selected[@]}"; do
  if ! declare -F "$name" >/dev/null; then
    echo "no such test: $name" >&2
    exit 2
  fi
  echo "== $name"
  if (cd "$root" && "$name"); then
    echo "   ok"
  else
    failed+=("$name")
  fi
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo "failed: ${#failed[@]} of ${#selected[@]}"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi
echo
echo "all ${#selected[@]} container tests passed"
