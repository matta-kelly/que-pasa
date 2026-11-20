# que-pasa

[![npm](https://img.shields.io/npm/v/@mku1tra/que-pasa)](https://www.npmjs.com/package/@mku1tra/que-pasa) [![license](https://img.shields.io/npm/l/@mku1tra/que-pasa)](LICENSE)

A durable agent harness for TypeScript. Define agents and tools once; que-pasa runs them so they survive crashes, wait for people, and are traced, and serves them to chat apps, MCP clients and your own code.

It follows LangChain's model (agents, tools, middleware, LangGraph's threads and runs) and runs on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable), which keeps every step of a run in storage.

## Features

- **Durable runs**: a run killed mid-step goes on from where it stopped when its process starts again. The same run id is always the same run, so a retry never runs twice.
- **Conversations**: history across runs, with follow-ups queued or steered into the run going on, and a stop that holds.
- **Human in the loop**: a tool call can stop for a person's approval, or for a login, and go on once answered.
- **Tools that reach the world safely**: per-person logins through connections, so a tool gets a client and never a credential, and sandboxed file and shell tools (local or Podman).
- **Middleware**: memory files, skills, and approvals, after LangChain's.
- **Three ways in, on the same runs**: an HTTP API after LangGraph's Agent Server, the Vercel AI SDK's chat protocol, and MCP.
- **Tracing**: OpenTelemetry GenAI spans for every run, model request and tool call.

## Install

```sh
npm install @mku1tra/que-pasa zod
```

## Quick start

```ts
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { defineAgent, defineTool } from "@mku1tra/que-pasa/define";
import { openRuntime } from "@mku1tra/que-pasa/loop";
import { z } from "zod";

const findOrder = defineTool({
  name: "find_order",
  description: "Find an order by its number.",
  schema: z.object({ number: z.string() }),
  run: async ({ number }) => orders.get(number),
});

const support = defineAgent({
  name: "support",
  model: "anthropic:claude-sonnet-5-5",
  instructions: "Answer questions about orders.",
  tools: [findOrder],
});

const models = createModels();
models.setProvider(anthropicProvider()); // reads ANTHROPIC_API_KEY

const runtime = await openRuntime({
  storage: await openNodeSqliteStorage("runs.sqlite"),
  models,
  agents: [support],
});

const outcome = await runtime.run(support, "Where is order 1042?", {
  conversation: "customer-7",
  runId: "1",
  caller: { id: "customer-7" },
});
// { status: "done", result: "Order 1042 shipped on ..." }
```

Run `runtime.run` again with the same `runId`, in this process or one started after a crash, and it gives back the same result without running again.

## Serve agents

`createServer` puts a deployment's agents on the network. The deployment answers who is calling and which agents they get:

```ts
import { serve } from "@hono/node-server";
import { createServer } from "@mku1tra/que-pasa/server";

const server = createServer({
  runtime,
  authenticate: (request) => callerOf(request), // undefined answers 401
  agentsFor: (caller) => agentsOf(caller),
});
serve({ fetch: server.fetch, port: 8080 });
```

Every way in shares the same runs, conversations and checks:

| Way in | For | Path |
|---|---|---|
| HTTP API | scripts, services, other agents | `/agents`, `/conversations`, `/conversations/{id}/runs/wait`, after LangGraph's Agent Server |
| Chat | a browser chat on `useChat`, assistant-ui or AI Elements: streaming, approvals, resume after reload, stop | `/chat` |
| MCP | Claude Code, IDEs and other MCP clients: each agent is a tool | `/mcp` |

A React chat needs only the endpoint:

```tsx
const chat = useChat<ChatMessage>({
  transport: new DefaultChatTransport({ api: "/chat", body: { agent: "support" } }),
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
});
```

## Packages

| Import | What it holds |
|---|---|
| `@mku1tra/que-pasa/define` | `defineAgent`, `defineTool`, `defineConnection`, `defineResource` |
| `@mku1tra/que-pasa/loop` | `openRuntime`: runs, conversations, stops, reads |
| `@mku1tra/que-pasa/middleware` | `memory`, `skills`, `humanInTheLoop`, `compaction` |
| `@mku1tra/que-pasa/sandbox` | file and shell tools, local and Podman backends, views |
| `@mku1tra/que-pasa/files` | the file store for the images tools make: memory, folder and S3-compatible |
| `@mku1tra/que-pasa/server` | `createServer`: the HTTP API, chat and MCP |

## Documentation

The design notes live beside the code:

- [Overview](que-pasa.md): what que-pasa is, and how its parts fit
- [The loop](loop/que-pasa-loop.md): conversations, runs, interrupts, crash recovery, and the invariants each test holds
- [Tools](define/define-tool.md): resources, connections and logins, approvals
- [Middleware](middleware/que-pasa-middleware.md): memory, skills, approvals, compaction
- [Sandbox](sandbox/que-pasa-sandbox.md): backends, and what each one's wall stops
- [Files](files/que-pasa-files.md): where the images tools make are kept, and how they are served
- [Server](server/que-pasa-server.md): the HTTP API, refusals, long runs
- [Chat](server/chat/que-pasa-chat.md) and [MCP](server/mcp/que-pasa-mcp.md): the two surfaces

## Development

The toolchain runs in a container made by [crate](https://github.com/matta-kelly/crate), so the host needs only `just`, `podman` and crate.

```sh
just up      # make or start the workspace
just check   # notes, types, lint, format, tests, build, and the packed exports
just run npm install <package>
```

Changes land on `main` through a merge queue that runs `just check`. Versions follow Conventional Commits: a version tag is made from the commit types, and CI publishes it to npm with provenance.

## License

[MIT](LICENSE)
