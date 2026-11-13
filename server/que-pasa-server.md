---
type: component
description: "que-pasa's server: a deployment's agents, reached from outside its process, after LangGraph's Agent Server. Read for what a server does, the questions it asks the deployment, its HTTP API and its operations, how it answers a refusal and a long run, and where it differs from LangGraph."
status: running
---
A deployment's agents, reached from outside its process: one agent, from any way in. The code is `server/`, exported as `@mku1tra/que-pasa/server`, after LangGraph's Agent Server; `define/` and `loop/` never import it.
- [[#The server]] what it does for each request, and who answers what
- [[#The HTTP API]] its routes, in LangGraph's shape and pi's words
- [[#The operations]] the same, for a way in in the same process
- [[#Where it differs]] from LangGraph's Agent Server

- [[que-pasa]]: the harness it is part of
- [[que-pasa-loop]]: the runs it starts, on a conversation, by a run id

---
## The server

A process on the network that starts runs for whoever calls: for each request it asks the deployment four questions, then runs the agent on the deployment's runtime.
- created with `createServer({ runtime, authenticate, agentsFor, contextFor, onError })`: the deployment opens the runtime and gives its answers as hooks
- the questions, each answered by the deployment from its control plane (its config, its vault, its login provider):
	- who is calling: `authenticate(request)`, the caller, or none (401). LangGraph's `@auth.authenticate`
	- which agents they get: `agentsFor(caller)`. LangGraph's `@auth.on`
	- what context a conversation is made with: `contextFor({ caller, agent, conversation, request })`, none when left out. A request never sets the context; a deployment that lets a client ask for something reads the request in this hook, and throws `Refused` (403) for what it does not allow
	- which login a tool acts with: `credentialFor`, given to the runtime ([[define-tool#Reaching an outside system]]); and where a person connects one: `connectUrl({ connection, caller })`, the deployment's page
- the model is the agent's
- what each part owns:
	- que-pasa: the routes, the checks, the run, the answer
	- the deployment: its answers, its way in (such as L&L's MCP layer, beside the server's routes), and serving `fetch` on its box (`@hono/node-server`, a Worker)
- one agent from every way in: Slack, MCP, a phone or an app all become the same call (this caller, this agent, this conversation, this input), so the agent and its tools act the same whichever way it was reached

## The HTTP API

`server.fetch(request)`: a Web-standard handler, on Hono, as LangGraph's JS server.

| Route | LangGraph | Answers |
|---|---|---|
| `GET /ok` | `GET /ok` | `{ ok: true }`, with no login: the deployment's health check |
| `GET /agents` | `POST /assistants/search` | `{ agents: [{ name, description }] }`: the caller's |
| `POST /conversations/{conversation}/runs/wait`, body `{ agent, runId, input }` | `POST /threads/{id}/runs/wait` | how the run ended |

- `conversation`: the client's key, any non-empty string, URL-encoded in the path. `runId`: the client's, so the same one again is the same run and gives back its result. `input`: one text message, as every agent takes
- a refusal comes before the run is admitted, as a status with `{ error: { code, message } }`:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | the body is not `{ agent, runId, input }` |
| 401 | `unauthenticated` | `authenticate` gave no caller |
| 403 | `forbidden` | a hook threw `Refused` |
| 404 | `agent_not_found` | an agent not given to the caller, or none of that name |
| 404 | `conversation_not_found` | another caller's conversation, shown as not found |
| 409 | `other_agent`, `other_context` | the conversation was made with another agent, or another context |
| 422 | `busy` | a run goes on on the conversation (LangGraph's status for its "reject" strategy) |
| 500 | `internal` | an error the server did not expect, given to `onError` |

- once admitted: 200 at once, a newline each second while the run goes on, then `{ conversation, runId, status, ... }`. Leading newlines are valid JSON, and keep a proxy, such as Cloudflare's 100-second limit, from cutting a long run (LangGraph's `waitKeepAlive`)
	- `status: "done"`, with `result`: the agent's text, or its output
	- `status: "failed"`, with `error: { code, message }`: `no_submit`, or pi's reason
	- `status: "needs_connection"`, with `connections: [{ name, description, owner, connectUrl }]`: the run did not start, as its caller has no login for these. Once they connect, the same `runId` runs
	- more statuses come with run life, such as a run that waits for an approval, so a client checks `status`
- a client that hangs up does not stop the run: it is durable, and the same `runId` again gives back its result

## The operations

The same two, for a way in in the same process, such as an MCP layer: each answers the deployment's questions from the request first, as the routes do.
- `agents(request)`: the caller's agents, as `{ name, description }`
- `run(request, agent, { conversation, runId, input }, { signal, onKeepAlive })`: the run's outcome, `{ status: "done", result }`, `{ status: "failed", error }` or `{ status: "needs_connection", connections }`
	- a refusal throws `ServerError`, with the route's status and code
	- `signal`: stops the run when it aborts, which then ends `failed` with `aborted`. Left out, the run goes on whatever the client does
	- `onKeepAlive`: called each second while the run goes on, for a client that must show it is alive, such as an MCP progress notification

## Where it differs

- from LangGraph: a conversation's key and a run's id are the client's, not made by the server, so a retry is the same run with no lookup
- from LangGraph: `contextFor` is the deployment's, and a request has no `context` field; LangGraph takes a client's context and lets an auth handler refuse it
- from LangGraph: another caller's conversation is refused by the run itself (it acts for one caller), not filtered by an auth handler; the answer is the same, not found
- not built: streaming a run, a run in the background with join, cancel, reading a conversation, and crons: run life, each one more route
