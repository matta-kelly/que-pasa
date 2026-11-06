# que-pasa

que-v2's harness: it knows no company. A company's workspace defines its agents against que-pasa's types, and que-pasa runs them. Nothing of the harness is built yet: see `que-pasa.md`.

## Run and check

Node runs in the dev container (`.devcontainer/devcontainer.json`), never on the host. You need `just`, `podman` and `npx`.

- `just up`: make or start this checkout's dev container
- `just check`: the check set, `scripts/check.sh`: notes, then types, lint and format. The pre-push hook and the pipeline run the same file
- `just run <command>`: run a command in the dev container, such as `just run npm install zod`
- `just down`: remove this checkout's container and its own volumes

## Ship

A change lands on main through `git land`.
