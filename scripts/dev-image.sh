#!/usr/bin/env bash
# que-pasa's dev image in ghcr: one per hash of its inputs, built once wherever it is first needed,
# and pulled by the dev container and CI.
#   hash    the hash of the inputs at HEAD: 16 lowercase hex
#   ref     <name>@<digest> of <name>:<hash> if it exists, else of <name>:main
#   ensure  build, smoke and push <name>:<hash> only when ghcr lacks it, point <name>:main at
#           <name>:<hash>, and print its ref. Any change may run it: each set of inputs is built once,
#           wherever it is first needed
#   promote point <name>:main at <name>:<hash>, and print its ref
#   local   put <name>:<hash> in this machine's store: its copy, else a pull, else a build and a
#           smoke with no push; print the tag
# The registry login is the caller's (`podman login ghcr.io`, which skopeo reads too).
# Env: DEV_IMAGE (the name), ENGINE (podman), DEV_IMAGE_SMOKE (the smoke, given the image).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
cd "$root"

# The two lines another repo changes.
name=${DEV_IMAGE:-ghcr.io/matta-kelly/que-pasa-dev}
inputs=(.devcontainer/devcontainer.json .devcontainer/Containerfile package-lock.json)

engine=${ENGINE:-podman}
smoke=${DEV_IMAGE_SMOKE:-$root/scripts/dev-image-smoke.sh}

usage() {
  echo "usage: scripts/dev-image.sh hash|ref|ensure|promote|local" >&2
  exit 2
}

# Git's tree entries hold each file's blob hash and path, so one commit gives one hash on every
# machine. `git ls-tree` prints nothing for a missing path, so each is checked first.
input_hash() {
  local f entry
  for f in "${inputs[@]}"; do
    entry=$(git ls-tree HEAD -- "$f")
    [ -n "$entry" ] || {
      echo "dev-image: no $f at HEAD" >&2
      exit 1
    }
  done
  git ls-tree -r HEAD -- "${inputs[@]}" | sha256sum | cut -c1-16
}

# digest <tag>: the manifest's digest, or non-zero when ghcr lacks the tag.
digest() { skopeo inspect --format '{{.Digest}}' "docker://$name:$1" 2>/dev/null; }

ref() {
  local h d
  h=$(input_hash)
  if d=$(digest "$h"); then
    echo "$name@$d"
  elif d=$(digest main); then
    echo "$name@$d"
  else
    echo "dev-image: neither $name:$h nor $name:main exists" >&2
    exit 1
  fi
}

# drop <tag>: take a tag out of this machine's store, whether or not it is there.
drop() { "$engine" image rm "$1" >/dev/null 2>&1 || true; }

# build_to <tag>: build to <tag>-candidate and smoke that, then move it to <tag>. The move is the
# last step, so no <tag> reaches this machine's store unless its smoke passed. The candidate tag is
# dropped either way. A failed step exits non-zero before the next.
build_to() {
  local candidate=$1-candidate built=0
  "$engine" build -f .devcontainer/Containerfile -t "$candidate" . &&
    "$smoke" "$candidate" &&
    "$engine" tag "$candidate" "$1" &&
    built=1
  drop "$candidate"
  [ "$built" = 1 ]
}

# Also when nothing was built: a main that goes back to old inputs gets their image back.
promote() {
  local h d
  h=$(input_hash)
  digest "$h" >/dev/null || {
    echo "dev-image: $name:$h is not in ghcr: run ensure first" >&2
    exit 1
  }
  skopeo copy --preserve-digests "docker://$name:$h" "docker://$name:main" >&2
  d=$(digest "$h")
  echo "$name@$d"
}

ensure() {
  local h
  h=$(input_hash)
  if digest "$h" >/dev/null; then
    echo "$name:$h exists: not built" >&2
  else
    build_to "$name:$h" >&2
    "$engine" push "$name:$h" >&2
  fi
  promote
}

local_() {
  local h
  h=$(input_hash)
  if ! "$engine" image exists "$name:$h" && ! "$engine" pull "$name:$h" >/dev/null 2>&1; then
    build_to "$name:$h" >&2
  fi
  echo "$name:$h"
}

case ${1:-} in
hash) input_hash ;;
ref) ref ;;
ensure) ensure ;;
promote) promote ;;
local) local_ ;;
*) usage ;;
esac
