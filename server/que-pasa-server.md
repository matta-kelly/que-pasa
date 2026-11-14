---
type: component
description: "que-pasa's server: a deployment's agents, reached from outside its process, after LangGraph's Agent Server. Read for what a server does, the questions it asks the deployment, its HTTP API and its operations, how it answers a refusal, a long run and a run that asks a person, how a client reads its conversations, and where it differs from LangGraph."
status: running
---
A deployment's agents, reached from outside its process: one agent, from any way in. The code is `server/`, exported as `@mku1tra/que-pasa/server`, after LangGraph's Agent Server; `define/` and `loop/` never import it.
- [[#The server]] what it does for each request, and who answers what
- [[#The HTTP API]] its routes, in LangGraph's shape and pi's words
- [[#Reading conversations]] a caller's conversations, how one stands, and its entries
- [[#The operations]] the same, for a way in in the same process
- [[#Where it differs]] from LangGraph's Agent Server

- [[que-pasa]]: the harness it is part of
- [[que-pasa-loop]]: the runs it starts, on a conversation, by a run id

---
## The server

A process on the network that starts runs for whoever calls: for each request it asks the deployment four questions, then runs the agent on the deployment's runtime.
- created with `createServer({ runtime, authenticate, agentsFor, contextFor, onError })`: the deployment opens the runtime and gives its answers as hooks
- the questions, each answered by the deployment from its control plane (its config, its vault, its login provider):
	- who is calling: `authenticate(request)`, the caller (`{ id, name? }`; the name is what the model calls them), or none (401). LangGraph's `@auth.authenticate`
	- which agents they get: `agentsFor(caller)`. LangGraph's `@auth.on`
	- what context a conversation is made with: `contextFor({ caller, agent, conversation, request })`, none when left out. A request never sets the context; a deployment that lets a client ask for something reads the request in this hook, and throws `Refused` (403) for what it does not allow
	- which login a tool acts with: `credentialFor`, given to the runtime ([[define-tool#Reaching an outside system]]); and where a person connects one: `connectUrl({ connection, caller })`, the deployment's page, given with a run's question for a login
- the model is the agent's
- its runs are attended: a person is at the other end, so a tool call that asks waits for them, and the run gives back its questions ([[que-pasa-loop#The interrupt]])
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
| `POST /conversations/{conversation}/runs/wait`, body `{ agent, runId, input, whenBusy? }` or `{ agent, runId, command: { resume } }` | `POST /threads/{id}/runs/wait`, with `multitask_strategy` or `command.resume` | how the run stands |
| `GET /conversations?agent=&limit=&cursor=` | `POST /threads/search` | `{ items: [conversation], next? }`: the caller's ([[#Reading conversations]]) |
| `GET /conversations/{conversation}` | `GET /threads/{id}` | how the conversation stands |
| `GET /conversations/{conversation}/entries?order=&minEntryId=&maxEntryId=&limit=&cursor=` | `GET /threads/{id}/state`, its messages | `{ items: [entry], next? }` |

- `conversation`: the client's key, any non-empty string, URL-encoded in the path. `runId`: the client's, so the same one again is the same run and gives back its outcome. `input`: one text message, as every agent takes
- `whenBusy`: what the input does when a run goes on, or waits, on the conversation, pi's ([[que-pasa-loop#Conversation and run]]): `reject`, the default, answers 422 `busy`; `followUp` queues it, and answers its own outcome once the runs before it end; `steer` joins it to the run going on, and answers that run's outcome. LangGraph's `multitask_strategy`: `reject` is its default, `enqueue` is `followUp`, and it has no steer
- `command.resume`: answers to the run's questions, by their ids, on the run's own `runId`, in place of `input`: LangGraph's `Command(resume)`. The run goes on at the calls that asked
- a refusal comes before anything is done, and before a run is admitted, as a status with `{ error: { code, message } }`:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request` | the body is not `{ agent, runId, input, whenBusy? }` or `{ agent, runId, command: { resume } }`; a read's query string has a field it does not take, a `limit` not 1 to 100, or a `cursor` that is not a page's `next` of the same query |
| 401 | `unauthenticated` | `authenticate` gave no caller |
| 403 | `forbidden` | a hook threw `Refused` |
| 404 | `agent_not_found` | an agent not given to the caller, or none of that name |
| 404 | `conversation_not_found` | another caller's conversation, shown as not found; on a read, also one no run made, or one of an agent the caller is no longer given |
| 409 | `other_agent`, `other_context` | the conversation was made with another agent, or another context |
| 409 | `not_interrupted` | answers to a question the run does not wait on, or to a run never started or ended |
| 422 | `busy` | a run goes on, or waits on a question, on the conversation, and the input's `whenBusy` is `reject` (LangGraph's status for its "reject" strategy) |
| 502 | `connection_failed` | a connection could not be made, or could not say who it is logged in as, at the run's start |
| 500 | `internal` | an error the server did not expect, given to `onError` |

- once admitted: 200 at once, a newline each second while the run goes on, then `{ conversation, runId, status, ... }`. Leading newlines are valid JSON, and keep a proxy, such as Cloudflare's 100-second limit, from cutting a long run (LangGraph's `waitKeepAlive`)
	- `status: "done"`, with `result`: the agent's text, or its output
	- `status: "failed"`, with `error: { code, message }`: `no_submit`, or pi's reason
	- `status: "interrupted"`, with `interrupts: [{ id, value, error? }]`: the run waits on these questions, LangGraph's `__interrupt__`. `value` is what the asker asked:
		- a login: `{ type: "connection", name, description, owner, connectUrl }`, with the deployment's page. Any answer checks again, once the person connected it
		- an approval: `{ type: "tool_approval", name, args, description, allowedDecisions }`, answered with a decision ([[que-pasa-middleware#Approval]])
		- `error`: why the last answer to it was refused
	- more statuses may come with run life, so a client checks `status`
- a client that hangs up does not stop the run: it is durable, and the same `runId` again gives back its result

## Reading conversations

What a client reads to show its conversations, such as a chat's list and a page it loads again, as LangGraph's threads: the runtime's reads ([[que-pasa-loop#Reading a conversation]]), for the caller, of the agents the deployment gives them.
- a conversation, as a client gets it: `{ conversation, agent, status, runId?, interrupts, runFailure? }`, LangGraph's thread. Its caller and context are the deployment's, and not given
	- `status`: `idle`, `busy`, `interrupted` or `error`, LangGraph's thread statuses
	- `runId` and `interrupts`: the run going on, and, when interrupted, the questions it waits on, as a run gives them (a login question with the deployment's `connectUrl`). A page loaded again shows the questions, and answers them with `command: { resume }` on that `runId`
	- `runFailure`: `{ reason, detail? }`, pi's, when `error`
- the list: the newest made first; `agent` gives only that agent's (404 `agent_not_found` when not given); `limit` 20 by default
- the entries: pi's `EntryRecord`s (`id`, `kind`, `model`, the messages, `data`), without the system entries, the instructions and tool definitions; newest first unless `order=ascending`, bounded by `minEntryId` and `maxEntryId`; `limit` 50 by default, pi's transcript page
	- a client shows them with pi's `ConversationTranscript`, its loader a fetch of this route: it pages by entry ids and ends on no `next`, as it pages pi's own
- a page: `{ items, next? }`, pi's `Page`; `next` is pi's cursor as base64url JSON, given back as `cursor` with the same query for the page after, and absent on the last page
- a read is the caller's: another caller's conversation, one no run made and one of an agent the caller is not given are the same, not found

## The operations

The same, for a way in in the same process, such as an MCP layer: each answers the deployment's questions from the request first, as the routes do.
- `agents(request)`: the caller's agents, as `{ name, description }`
- `run(request, agent, { conversation, runId, input, whenBusy } | { conversation, runId, resume }, { signal, onKeepAlive })`: the run's outcome, `{ status: "done", result }`, `{ status: "failed", error }` or `{ status: "interrupted", interrupts }`
- `conversations(request, { agent, limit, cursor })`, `conversation(request, conversation)` and `entries(request, conversation, { order, minEntryId, maxEntryId, limit, cursor })`: the reads, with pi's cursor as JSON, not as text
	- a refusal throws `ServerError`, with the route's status and code
	- `signal`: stops the run when it aborts, which then ends `failed` with `aborted`. Left out, the run goes on whatever the client does
	- `onKeepAlive`: called each second while the run goes on, for a client that must show it is alive, such as an MCP progress notification

## Where it differs

- from LangGraph: a conversation's key and a run's id are the client's, not made by the server, so a retry is the same run with no lookup
- from LangGraph: `contextFor` is the deployment's, and a request has no `context` field; LangGraph takes a client's context and lets an auth handler refuse it
- from LangGraph: another caller's conversation is refused by the run itself (it acts for one caller), not filtered by an auth handler; the answer is the same, not found
- from LangGraph: a resume is the same run, by its `runId`, not a new run on the thread; new input while a run waits goes by its `whenBusy`, where LangGraph's new input drops the waiting question
- from LangGraph: `steer` is pi's, with no LangGraph strategy; LangGraph's `interrupt` and `rollback`, which stop the run going on for the new input, are not built
- from LangGraph: the list is the caller's, newest made first, with no search by metadata or values; a conversation's messages are pi's entries, paged, not the graph's state
- not built: streaming a run, a run in the background with join, cancel, listing a conversation's runs, and crons: run life, each one more route
