#!/usr/bin/env bash
# The smoke check of que-pasa's dev image (.crate/Containerfile), run on the image before any
# push (crate dev-image ensure). The image owes it this: the checkout installs from its npm cache
# with no network, and it holds no checkout file. It installs into a copy in the container's /tmp,
# never into the checkout.
# Usage: scripts/dev-image-smoke.sh <image>. Exit 0 and `dev image smoke: ok` last when the image is
# good; non-zero, naming the step, when not. The engine is ${ENGINE:-podman}.
set -uo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
engine=${ENGINE:-podman}
image=${1:-}
[ -n "$image" ] || {
  echo "usage: scripts/dev-image-smoke.sh <image>" >&2
  exit 2
}

failed_at() {
  echo "dev image smoke failed at: $1" >&2
  exit 1
}

# offline: copies the checkout into the container's /tmp and installs it there, offline.
offline() {
  "$engine" run --rm --network none -v "$root:/src:ro" "$image" bash -c \
    'mkdir -p /tmp/smoke && tar -C /src --exclude=node_modules --exclude=.git -cf - . | tar -C /tmp/smoke -xf - && cd /tmp/smoke && npm ci --offline --no-audit --no-fund'
}

offline || failed_at "the offline install of package-lock.json"
"$engine" run --rm "$image" sh -c 'test ! -e /tmp/bake' || failed_at "no checkout file in the image"
echo "dev image smoke: ok"
