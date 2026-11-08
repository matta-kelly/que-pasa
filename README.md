# que-pasa

que-v2's harness, on pi-durable: a workspace defines its agents with `@mku1tra/que-pasa/define`, and `@mku1tra/que-pasa/loop` runs them, durably and traced. It knows no workspace. What is built: `que-pasa.md`.

## Run and check

Node runs in the dev container (`.devcontainer/devcontainer.json`), never on the host. You need `just`, `podman` and `npx`.

- `just up`: make or start this checkout's dev container
- `just check`: the check set, `scripts/check.sh`: notes, then types, lint, format, tests and the build. The pre-push hook and the pipeline run the same file
- `just run <command>`: run a command in the dev container, such as `just run npm install zod`
- `just down`: remove this checkout's container and its own volumes

## Run agents

```ts
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime } from "@mku1tra/que-pasa/loop";

const runtime = await openRuntime({ storage: await openNodeSqliteStorage("runs.sqlite"), models, agents: [nail] });
const result = await runtime.run(nail, input, { runId: attempt.id, caller: { id: "assembly" }, context });
await runtime.close();
```

One runtime per process owns its SQLite file. After a crash, open it again with the same agents: unfinished runs go on, and `run` with the same `runId` gives back the result.

Each run is traced as OpenTelemetry GenAI spans through `@opentelemetry/api`. To keep them, register an SDK (a tracer provider, an exporter, and an async context manager). To add what only the host knows, call `runtime.run()` inside a span of its own. `captureContent: true` on `openRuntime` adds message content.

## Use it from another project

Install it from npm: `npm install @mku1tra/que-pasa zod`. zod is a peer dependency: the project brings it.

## Release

Set the version in `package.json`, commit, land, and push its tag, `v<version>`. `.github/workflows/publish.yml` runs the check set and publishes on npm by trusted publishing (no token, with provenance). A ruleset lets only an admin of the repo make a version tag. A version npm has is not published again. A published version cannot change: npm unpublishes only within 72 hours.

## Ship

A change lands on main through `git land`.
