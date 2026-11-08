#!/usr/bin/env bash
# A stub, until da-hammer writes the commands: scripts/dev-image.sh's interface, which is its two lines
# that another repo changes and the names of its commands. It does nothing and exits 2, so the tests in
# scripts/dev-image.test.sh reach their own assertions. Replace the body; keep the interface.
set -euo pipefail

name=${DEV_IMAGE:-ghcr.io/matta-kelly/que-pasa-dev}
inputs=(.devcontainer/devcontainer.json .devcontainer/Containerfile package-lock.json)

exit 2
