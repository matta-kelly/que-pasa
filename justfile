# que-pasa commands. Node runs in the dev container, never on the host.

root := justfile_directory()

# List the commands
default:
    @just --list

# Run the check set: notes, then types, lint and format. The pre-push hook and the pipeline run the same file.
check: up
    git -C "{{root}}" config core.hooksPath .githooks
    podman exec -u node -w "{{root}}" "$(just _container)" scripts/check.sh

# Run a command in the dev container, from the repo folder: `just run npm install zod`
run +command: up
    @podman exec -it -u node -w "{{root}}" "$(just _container)" {{command}}

# The maker: this checkout's dev container, from .devcontainer/devcontainer.json through the dev container
# CLI. VS Code's "Reopen in Container" makes the same call, so both paths find one container by the CLI's
# own label. No setting is passed here: the file holds them all, the CPU cap among them.
up:
    #!/usr/bin/env bash
    set -euo pipefail
    c=$(just _container)
    if [ -n "$c" ]; then
        podman start "$c" >/dev/null
        exit 0
    fi
    # A failed install exits non-zero and leaves its container behind: remove it, so a later command makes
    # a container and runs the install instead of reusing this one.
    if ! npx --yes @devcontainers/cli@0.90.0 up --workspace-folder "{{root}}" --docker-path podman; then
        podman ps -aq --filter "label=devcontainer.local_folder={{root}}" | xargs -r podman rm -f >/dev/null
        exit 1
    fi

# Remove this checkout's dev container and its own volumes, and nothing else: no service another
# workspace uses (workspace#Bar). The volume names are readable from the container's mounts only while
# it exists, so read them before removing it.
down:
    #!/usr/bin/env bash
    set -euo pipefail
    c=$(just _container)
    if [ -n "$c" ]; then
        for v in $(podman inspect --format '{{{{range .Mounts}}{{{{if eq .Type "volume"}}{{{{.Name}} {{{{end}}{{{{end}}' "$c"); do
            podman volume rm -f "$v" >/dev/null 2>&1 || true
        done
        podman rm -f "$c" >/dev/null
    fi
    # The workspace's network, its pod and its route, after the container that joins the network.
    scripts/workspace.sh down "{{root}}"

# The id of this checkout's container, by the label the CLI sets by default. Nothing reads the name the
# CLI gives it.
_container:
    @podman inspect --format '{{{{.Id}}' $(podman ps -aq --filter "label=devcontainer.local_folder={{root}}" | head -1) 2>/dev/null || true
