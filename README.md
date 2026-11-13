# que-pasa

que-v2's harness, on pi-durable: a workspace defines its agents with `@mku1tra/que-pasa/define`, and `@mku1tra/que-pasa/loop` runs them, durably and traced. It knows no workspace. What is built: `que-pasa.md`.

## Run and check

Node runs in the dev container (`.devcontainer/devcontainer.json`), never on the host. The container starts from the dev image, `ghcr.io/matta-kelly/que-pasa-dev:main`, which `.devcontainer/Containerfile` builds with the npm cache of `package-lock.json`, and the `dev-image` workflow on main builds and pushes it. You need `just`, `podman` and `npx`; once per machine, log in with `podman login ghcr.io`, and the first `just up` pulls the dev image, then installs from its cache in seconds.

- `just up`: make or start this checkout's dev container
- `just check`: the check set, `scripts/check.sh`: notes, then types, lint, format, tests and the build. The pre-push hook and the pipeline run the same file
- `just run <command>`: run a command in the dev container, such as `just run npm install zod`
- `just down`: remove this checkout's container and its own volumes

## Run agents

```ts
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openRuntime } from "@mku1tra/que-pasa/loop";

const runtime = await openRuntime({ storage: await openNodeSqliteStorage("runs.sqlite"), models, agents: [nail] });
const first = await runtime.run(nail, input, { conversation: "cl-42/coder", runId: "1", caller: { id: "assembly" }, context });
const second = await runtime.run(nail, review, { conversation: "cl-42/coder", runId: "2", caller: { id: "assembly" }, context });
await runtime.close();
```

A conversation keeps its history across runs: the second run's model has the first's messages. Each run is one input to its own result, usage and trace; a conversation takes one run at a time, and every run on it gives the same agent, caller and context.

One runtime per process owns its SQLite file. After a crash, open it again with the same agents: unfinished runs go on, and `run` with the same `runId` gives back the result.

A tool gets what it acts on from its conversation, as a resource the host provides. The file and command tools of `@mku1tra/que-pasa/sandbox` act in the `Sandbox` the host gives each conversation:

```ts
import { provide } from "@mku1tra/que-pasa/loop";
import { Sandbox, execute, fileTools, podman, view } from "@mku1tra/que-pasa/sandbox";

const coder = defineAgent({ name: "coder", model, instructions, tools: [...fileTools, execute] });
const runtime = await openRuntime({
  storage, models, agents: [coder],
  resources: [
    provide(Sandbox, ({ conversation }) =>
      podman({ name: `box-${conversation.replaceAll("/", "-")}`, image: "node:22", mounts: [{ source: worktree, target: "/work" }] }),
    ),
  ],
});
```

A provider resolves from the conversation as its first run made it, so every run on it, also one that resumes after a crash, gets the same sandbox. `view(backend, { read, write })` limits a conversation to some files. What each backend's wall stops: `sandbox/que-pasa-sandbox.md`.

An agent's middleware are optional behaviours on its loop. `memory` gives an agent files it always has in its context, loaded once when the conversation is made and kept in it, so every run on it, also one that resumes, has the same memory:

```ts
import { memory } from "@mku1tra/que-pasa/middleware";
import { local } from "@mku1tra/que-pasa/sandbox";

const reviewer = defineAgent({
  name: "reviewer", model, instructions, tools,
  middleware: [memory({ backend: local({ root: workspace }), sources: ["memory/craft.md"] })],
});
```

What middleware is, and how memory works: `middleware/que-pasa-middleware.md`.

Each run is traced as OpenTelemetry GenAI spans through `@opentelemetry/api`. To keep them, register an SDK (a tracer provider, an exporter, and an async context manager). To add what only the host knows, call `runtime.run()` inside a span of its own. `captureContent: true` on `openRuntime` adds message content.

## Use it from another project

Install it from npm: `npm install @mku1tra/que-pasa zod`. zod is a peer dependency: the project brings it.

## Release

A land is a version when its commits ask for one: crate reads their types (Conventional Commits) on the server, tags main `v<version>`, and copies the tag to GitHub ([crate](https://github.com/matta-kelly/crate#release)). While que-pasa is at 0.x, a breaking change bumps minor, and `feat`, `fix` and `perf` bump patch. `.github/workflows/publish.yml` runs the check set, sets `package.json`'s version from the tag, and publishes on npm by trusted publishing (no token, with provenance). `package.json`'s version in git is not kept: the tag is the version. A ruleset lets only crate's deploy key, or an admin of the repo, make a version tag. A version npm has is not published again. A published version cannot change: npm unpublishes only within 72 hours.

## Ship

A change lands on main through `git land`.
