#!/usr/bin/env bash
# The integration tests for que-pasa's dev image (.devcontainer/Containerfile). They drive the real
# engine, so they run on the host: `scripts/container-check.sh`, `scripts/container-check.sh <name>...`
# for some of them, and `scripts/container-check.sh --list` to list them.
#
# They are not a step of scripts/check.sh: that file runs inside the dev container, where the engine is
# not, and its steps stay as they are. Where they cannot run they say why and exit 0: a machine with no
# engine (the pipeline's runner), or a container.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
engine=${ENGINE:-podman}
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
command -v "$engine" >/dev/null 2>&1 ||
  skip "the container tests need $engine on the host; the pipeline runs scripts/check.sh with no engine"

cleanup() {
  "$engine" image rm -f "$DEV_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

# --- the runner ---

TESTS=(
  test_the_dev_image_passes_its_smoke
  test_the_smoke_fails_an_image_with_no_cache
  test_the_dev_image_has_its_paths_and_runs_as_root
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
