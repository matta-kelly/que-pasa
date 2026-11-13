# que-pasa commands. Node runs in the workspace's tools member, never on the host: crate makes the workspace from
# crate.toml.

# List the commands
default:
    @just --list

# Run the check set: notes, then types, lint and format. The pre-push hook and the server's check run the same file.
check: up
    git -C "{{justfile_directory()}}" config core.hooksPath .githooks
    crate run scripts/check.sh

# Run a command in the workspace, from the repo folder: `just run npm install zod`
run +command: up
    @crate run {{command}}

# Make this checkout's workspace, or start what stopped. A second up changes nothing.
up:
    @crate up

# Remove this checkout's workspace: its containers, volumes and network.
down:
    @crate down
