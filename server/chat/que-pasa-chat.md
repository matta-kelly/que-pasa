---
type: component
description: "que-pasa's chat surface: the AI SDK's chat protocol on que-pasa's server, so a browser chat on useChat, assistant-ui or AI Elements reaches an agent with no glue. Read for its routes, how a run becomes the AI SDK's messages, how its stream follows a run, replays it after a reload and goes on after an approval, and where it differs from the AI SDK's own servers."
status: running
---
The AI SDK's chat protocol on que-pasa's server: a browser chat reaches an agent with `useChat({ transport: new DefaultChatTransport({ api: "<server>/chat", body: { agent } }) })`, and nothing else. The code is `server/chat/`, mounted at `/chat` by `createServer`; it runs on the same runtime, conversations, run ids and checks as the LangGraph routes ([[que-pasa-server]]), and is a view of what pi keeps, never a second store.
- [[#The routes]] the ones `useChat` calls, and the two an app adds
- [[#A run as messages]] the user and assistant message of a run, from pi's entries
- [[#The stream]] the message as it changes, a replay, and a continuation
- [[#Where it differs]] from the AI SDK's own servers

- [[que-pasa-server]]: the server it is part of, and its checks
- [[que-pasa-loop]]: the runs it shows, how a run stops, and the reads it is made from

---
## The routes

Each one asks the server's questions first (who is calling, which agents they get) and refuses as the server does, with `{ error: { code, message } }` before any stream starts.

| Route | AI SDK | Does |
|---|---|---|
| `POST /chat` | `DefaultChatTransport`'s send | the last message counts: a user message starts its run; an assistant message answers what its run asks. Streams the run's assistant message |
| `GET /chat/{id}/stream` | `reconnectToStream`, `useChat({ resume: true })` | the run going on, replayed from its start, then live; 204 when none goes on |
| `GET /chat/{id}/messages?limit=&cursor=` | the app's load, for `useChat({ messages })` | `{ messages, next? }`: a page of runs, the newest first, each its user and assistant message, in the order they came |
| `POST /chat/{id}/stop`, body `{ runId }` | the stop endpoint the AI SDK's docs have an app add | stops the run ([[que-pasa-loop#Conversation and run]]): `{ stopped }`. `useChat`'s `stop()` only leaves the stream |

- the chat's `id` is the conversation's key; a user message's `id`, which `useChat` makes, is its run's `runId`, so a message sent again is the same run, never a second
- the body: `DefaultChatTransport`'s `{ id, messages, trigger, messageId }`, and what the frontend adds in `body`: `agent`, which a new conversation needs, and `whenBusy`, `reject` (the default, 422 `busy`) or `followUp`
- the client's history is not trusted: the server keeps the conversation, so of what a client sends only the last message counts, and an approval is taken only for a question the run waits on (409 `not_interrupted` otherwise)
- an approval: `addToolApprovalResponse({ id, approved, reason })`, sent back by `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses`. Approved is LangChain's `approve`; denied is `reject`, with the reason. A login's question takes the same, so the same two buttons answer every question que-pasa asks. Richer answers, an edit or a response, go on `command.resume` ([[que-pasa-server#The HTTP API]])
- refused besides the server's: `regenerate-message`, 400 `regenerate_not_supported` (a conversation keeps its history, and a new message goes after it); a user message with parts other than text, 400 (an agent's input is one text); a new conversation with no `agent`, 400; a stop of a run never admitted, 404 `run_not_found`

## A run as messages

A run is two messages: its input as the user message, by its `runId`, and everything the agent did for it as one assistant message, `<runId>:answer`, after `useChat`'s `UIMessage` (`ChatMessage`, exported for `useChat<ChatMessage>()`). The assistant message is one pure function of the run's entries, its questions, and pi's live state while it goes on.
- each model response: a step, `step-start`, then its text (`text`), its thinking (`reasoning`) and its tool calls (`dynamic-tool`), in order
- a tool call: `input-available`, then its result, `output-available` with the tool's text, or `output-error`
- a question on a call: `approval-requested`, with the question's id as the approval's, its value as the descriptor, and its description as the reason; answered, `approval-responded`; then the result with the decision on it, and `output-denied` for a call the person rejected
- a steer, a message that joined the run while it went on: a `data-steer` part where it joined, `{ text }`, by the steer's run id
	- the AI SDK's own `steering-message` part is experimental and newer than the `ai` que-pasa pins (7.0.157), and a client reading a chunk it does not know fails: a data part is read by every version
- a note, a message put in the conversation that started no run ([[que-pasa-loop#Conversation and run]]): a `data-note` part where it was placed, `{ text }`, by its note id; in the run it was placed in, or, placed while the conversation was idle, in the run before it. The chat sends none: a chat message is a run; a note comes from the HTTP API or the operations
- a compaction, pi's summary of the conversation's older part ([[que-pasa-loop#Conversation and run]]): a `data-compaction` part where it was placed, `{ summary }`, by its entry's id; by hand, by an agent's trigger, or pi's own. The chat asks for none: a compaction comes from the HTTP API, the operations, or the middleware
- the response being written, while the run goes on: a step after the others, from pi's `pi.live`, which pi commits every 100 ms
- not shown: the system entries, a harness's reminders to the model, and a response pi retried (its error entry), as the stream removes it
- a run still queued: its user message only, from pi's inbox

## The stream

The AI SDK's UI message stream, written with `ai`'s own `createUIMessageStream` and `createUIMessageStreamResponse` (SSE, `x-vercel-ai-ui-message-stream: v1`, a keep-alive comment after 15 quiet seconds, under Cloudflare's 100-second limit).
- how it follows a run: `runtime.watch` gives each change of the conversation; each one gives the run's assistant message again, and the stream sends what changed since the last: a `text-delta` for grown text, a tool's next state, a new step
	- a step being written that pi replaced, as on a retry, is dropped with `reset-step`, then sent again; a part before that step never changes, as entries never do
- from what the client holds: from nothing, a full replay, as `useChat`'s resume expects (`resumeStreamIsReplay`); after an approval, from the message the client has, which the stream continues
- how it ends: the run done, `finish`; waiting on questions, its approval requests, then `finish`; failed, `error` with why; stopped, `abort`
- a client that goes away ends its stream, never the run: the same `GET /chat/{id}/stream` takes it up again, in any process, as the run is pi's, read back from storage
- so the stream, a replay, and a page loaded again are the same message: one function of what pi keeps

## Where it differs

- from the AI SDK's own servers: the server keeps the conversation, in pi, and takes only the last message; the AI SDK's examples rebuild it from the messages the client sends, and sign approvals to trust them
- from the AI SDK's resumable streams: no Redis and no stored stream; a stream is rebuilt from pi's entries and live state, so a reconnect needs nothing the run does not keep anyway
- from the AI SDK's `stop()`: a stop is a run's, by its id, kept before pi aborts it, so a stop that comes late never stops a newer run
- from LangGraph's Agent Server: no CORS. A browser app on another origin reaches the server through a proxy of its own, which calls it as the deployment's sign-in allows, such as with an Access token
- not built: files in a message (an agent's input is text), regenerating a message, and an agent's output as a typed part (it is the `submit` call's result)
