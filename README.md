# que-pasa

que-v2's harness: it knows no company. A company's workspace defines its agents with `que-pasa/define`, and `que-pasa/loop` runs them. What is built: `que-pasa.md`.

## Run and check

Node runs in the dev container (`.devcontainer/devcontainer.json`), never on the host. You need `just`, `podman` and `npx`.

- `just up`: make or start this checkout's dev container
- `just check`: the check set, `scripts/check.sh`: notes, then types, lint, format, tests and the build. The pre-push hook and the pipeline run the same file
- `just run <command>`: run a command in the dev container, such as `just run npm install zod`
- `just down`: remove this checkout's container and its own volumes

## Use it from another project

Install it from its folder, as npm packs it: `"que-pasa": "file:../que-pasa"`, with `install-links=true` in the project's `.npmrc`. It installs `dist/`, so build first: `just run npm run build`, or `just check`. zod is a peer dependency: the project brings it.

## Ship

A change lands on main through `git land`.
