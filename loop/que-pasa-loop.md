---
type: component
description: "que-pasa's loop: an agent in motion on pi-durable, durable and traced: a conversation that keeps its history across runs, and a run, one input to its result, which can stop at a tool call to ask a person. Read for the idea it follows, what is a conversation's and what is a run's, the states a run moves through, the interrupt, the invariants that hold in every state and what holds each, and what a run leaves."
status: running
---
An agent in motion: a conversation of one agent and one caller, and its runs, each one input to its result. Nobody writes a run; `loop/` makes it, on pi-durable, whose generation task is the loop itself.
- [[#The idea]] the agent is a stateless reducer over a durable log
- [[#Conversation and run]] what lives across runs, and what is one run's
- [[#States]] what a run moves through, and what moves it
- [[#The interrupt]] a tool call that stops to ask a person, and goes on with the answer
- [[#Invariants]] what holds in every state, and what holds it
- [[#After a crash]] what each crash point does, and what still holds
- [[#What it leaves]] its result, usage, conversation and trace

- [[que-pasa]]: the harness it is part of
- [[decision-model]]: gates, routes and verifiers in the loop as decision model calls. Not built

---
## The idea

The agent is a stateless reducer over a durable log, so the log is the run.
- stateless reducer: a function that takes everything so far plus one new thing, and returns the new everything so far. A running total is one: `total = total + next`
	- the agent remembers nothing between calls: all memory lives in the log passed in. Same log in, same decision out
	- as in chess: give anyone the move list and they can rebuild the board and pick the next move
- the loop is all it is, with two jobs: `build`, what the model is shown (context engineering), and `run`, what the system does, prevents, measures and fixes (harness engineering)
	- the inner loop is king, and harness engineering is always context engineering: how to give the model enough context to solve the task, most efficiently
	- context is the product: good context is the smallest set of high-signal tokens that gets the result. More in the window often makes the agent worse. The measure is accuracy per token

```
log = [first_event]
while True:
    context = build(log)          # context engineering
    action  = model(context)      # the only "AI" line
    if action.done: break
    result  = run(action)         # your code, your rules
    log.append(action, result)
```

- durable execution: a log kept so that a run goes on from where it stopped. Approval gates and idempotency are not two items but this one pillar: an approval gate is durability holding state while a person decides, and idempotency is what durability needs to replay safely
- in que-pasa the log is pi-durable's conversation, kept in the host's storage, and each run adds to it. `build` is the agent's instructions, its tools, and what its middleware adds to the system prompt; `run` is its tools and the resources the host gives them

## Conversation and run

A conversation is pi's conversation, and a run is pi's submission: LangGraph's thread and run, in pi's words. What the history and the resources depend on is the conversation's; what one input needs is the run's.
- conversation: the history of one agent for one caller, made by its first run and kept, by the host's key (`conversation`)
	- agent, caller and context: given by every run, and the same, or the run is refused: the history and the resources resolved from the context must match
	- middleware state: each `beforeAgent` runs once, when the conversation is made, as Deep Agents' memory loads once per thread
	- resources: resolved from the conversation, so a sandbox lives as long as its history
	- one run at a time: the run going on is the run of the input that started pi's run, which a steer may join
	- an input while a run goes on, or waits on a question: what it does is its run's `whenBusy`, pi's, chosen by whoever sends it, as LangGraph's `multitask_strategy`
		- `reject`, the default: refused, `busy`, naming the run going on
		- `followUp`: queued; it starts when the runs before it end, one run per input, in order (LangGraph's `enqueue`). A run that fails does not strand the ones behind it (pi's `afterFailedRun: "continue"`)
		- `steer`: joins the run going on at its next step, after the current tool round; its outcome is that run's. It starts no run of its own
		- on an idle conversation every input starts a run at once
- run: one input on a conversation to its result, by its id in the conversation (`runId`, pi's `requestId`)
	- model: the run's, or the agent's, for a run that starts at once: set on the conversation in the commit that admits it, so the model and the input land together. pi has no model per input, so a run that waits or joins runs on the conversation's model when it starts, the model of the run before it, and gives none (`model` only with `reject`); its document says which
	- attended: whether someone attends it, to answer what its calls ask (`attended`, set by whoever starts it; nobody by default; the server's runs are attended). Kept in the commit that admits it
	- questions: what its calls asked, and the answers, kept on the conversation by the question's id, with the run that asked: one run waits at a time, and a steer that joined it sees the same. A run that starts at once starts with none
	- result: read from its own submission, its answer entry and the submit result that answers it, never the conversation's last answer
	- usage: what the conversation spent from the run's start, before its first model request, to the next run's start, or to now. A queued run is admitted while another goes on, so its admission is not its start; a steer that joined spent nothing of its own
	- trace: its own, tagged with the conversation's key and its run id
- not built: stopping the run going on for a new input (LangGraph's `interrupt` and `rollback`), a run in the background with join and cancel by its id, a `beforeAgent` per run, and reading a conversation from another process

## States

A run moves from admitted to settled, through model calls and tool calls; pi moves it, and que-pasa's runtime starts it and reads its end.

| State | Holds | Moves on when | Moved by |
|---|---|---|---|
| admitted | its conversation, made by its first run in one commit with its document and middleware state; its input, in with the run id as `requestId`, with its model and run document, in one commit | pi takes the input | `runtime.run` |
| generating | a model request | the model answers: with tool calls to tooling, without to settled, or reminded to generating | pi's generation task |
| tooling | the round's tool calls | each has a result: to generating, or to settled when every result ends the run (the submit); a call that asks, to waiting | pi's tool tasks |
| waiting | the questions its calls asked, kept; each call that asked, held before its tool's code | every question is answered: to tooling. Nobody attends: to settled, failed | `runtime.run` with `{ resume }`; for a run nobody attends, the call |
| settled | its answer or its failure; the run's result is read from its submission | (terminal) | pi; `runtime.run` reads it |

- settled, as: answered (text), submitted (the output), or failed: `no_submit` after two reminders, `needs_connection` or `needs_answer` for a question in a run nobody attends, or pi's reason (`aborted`, `model_error`, `restart_limit` and the others)
- a conversation's next run: admitted once the run before it has settled, and generating with the whole history
- middleware ([[que-pasa-middleware]]): `beforeAgent` runs once before the conversation is made, `systemPrompt` before each request in generating, and `wrapToolCall` around each call in tooling, where approval asks. Summarize and limits: not built
	- a gate, a route or a verifier in it can be a decision model call: a decision model picks one option from a fixed set, after a check that its answers stay the same when the order of the choices changes or the input is given again. Not built

## The interrupt

A tool call that stops before its tool's code runs to ask a person, and goes on at that call with the answer: LangGraph's `interrupt()` and `Command(resume)`, held by que-pasa, as pi-durable has no wait for an answer from outside (its tasks wait only on tasks, or until a time).
- asked by: the call's check of its tool's connections (a missing login: "connect it"), and a middleware's `wrapToolCall` (`request.interrupt(value, answer?)`, such as an approval)
	- only before the tool's code runs: after it starts, `interrupt` throws. So nothing has happened when a call waits, whatever the tool's `replay`
	- a question's id: `<call id>:<asker>:<n>`, the n-th question of that asker in the call, so a rerun asks by the same id
- kept: each question, and then its answer, on the conversation. The wait itself is in memory: a call that reruns after a restart finds its question, and waits again or goes on with its answer
	- a crash while a call waits counts toward pi's restart limit (5); a clean close does not
- answered: `runtime.run(agent, { resume: { [id]: answer } }, { ...same runId })`, in one commit, by the run that asked or a steer that joined it; an answer to a question the run does not wait on is refused, `not_interrupted`
	- an answer that does not fit the asker's `answer` schema is refused by the call: kept as the question's `error`, and the question is asked again by the same id
- given back: `run()` gives `interrupted`, with the questions, once the run waits and every running call of its round has asked; the same run id again gives the same questions
- a run nobody attends: the call keeps its question and stops the run before its tool acts; the run fails, `needs_connection` for a login and `needs_answer` for anything else, with the questions. A steer that joined it fails the same, with the same questions: pi settles every input of a run with one outcome, and a question keeps every run of pi's run when it was asked
- input while a run waits: as while it goes on, by its `whenBusy`. A steer joins it and gives back the same questions; a follow-up starts once the run is answered and ends. Not built: dropping the question for a new input

## Invariants

What holds in every state of every run. Each is held by construction, and checked by a test.

| Invariant | Held by | Checked by |
|---|---|---|
| one conversation per key, of one agent, caller and context | the conversation index, a session document per key; the conversation document, written once, in the commit that makes it; every run checked against it | `runtime.test.ts`: another agent, caller or context refused |
| one run per run id in a conversation: the same id again is the same run, never a second | the input in with the run id as pi's `requestId`, looked up before it is admitted | `runtime.test.ts`: the same run id again, one model call |
| one run at a time on a conversation, and each input either refused, queued in order, or joined to the run going on | pi's inbox: the input admitted with its `whenBusy`, follow-ups one at a time; the run going on found from pi's run, never from the last admitted | `busy.test.ts`: refused, followed up, steered; `crash.test.ts`: a follow-up queued, killed, both run once, in order |
| no run state in memory: a new process can go on with any run | the conversation's and the run's documents; the result and the reminders in the transcript | `crash.test.ts`: every crash point, in a new process |
| a finished step is never done twice | pi's checkpoint per step; a marker kept just before a tool's code runs, so a tool not marked `replay: "safe"` that started never runs again | `crash.test.ts`: mid tool, mid model request, after the submit |
| a call waits only before its tool acts, so a wait is safe to take up again whatever the tool's replay | `interrupt` refused once the tool started; to pi every que-pasa tool is replay-safe, so a waiting call reruns, and que-pasa keeps the tool's own rule | `crash.test.ts`: killed while a call waits, then answered: the tool runs once |
| a person is asked once: a question answered is never asked again | the question and its answer kept in the run's document, by an id the rerun asks by again | `crash.test.ts`: killed after the answer, before the tool ran: it goes on, asking nobody |
| a run keeps what it was started with: input and model | the run document and the model, written once, in the commit that admits the run | `runtime.test.ts`, `crash.test.ts`: a run started again keeps its model, also mid a conversation's second run |
| a conversation keeps the middleware state it was made with: its system prompt is the same in every run and every process | each `beforeAgent` result kept in a `MiddlewareDoc`, in the commit that makes the conversation; a section renders from it, never from memory | `crash.test.ts`: the memory file changed, and the resumed process's model gets the text the run started with |
| a tool's code runs only with a login for each connection it uses | the call's check before the tool's code: a run someone attends asks for a missing one; a shared login the caller may not use gives the model no access | `runtime.test.ts`: asked, answered while still missing, asked again, then connected |
| a run nobody attends starts only when its caller has every login its agent's tools use, as nobody could connect one later | the credential gate in `runtime.run`, before anything of the run is kept; a run admitted already skips it. It asks for every connection the tools use, also one this run would not: a chosen cost for one simple rule | `runtime.test.ts`: a caller with no login refused, then the same run once connected |
| the model knows who it acts as in each service, the same in every process | each connection's `whoami`, asked at the run's start for each login there, or once the person connects it, and kept in the run's document; a section renders it from there | `runtime.test.ts`: asked once for a run started twice; said after a connection is connected |
| a login is never kept | a connection resolves from `credentialFor` in the process, as any resource; never in a document, the transcript or a span; one the service refuses (`LoginRejected`) is dropped, and the next call asks again | `runtime.test.ts`, `trace.test.ts`: the login in no message and no span, with content captured; a refused login asked for again; `crash.test.ts`: the new process asks for it again |
| a conversation's tools get the same resources in every process | a provider resolves from the conversation document, never from memory; once per run in a process | `crash.test.ts`: the resumed process resolves from the stored context |
| a run's result, usage and trace are its own, not the conversation's | the result read from the run's submission; the usage from what the conversation had spent at each run's start, kept before its first model request; a segment per run | `runtime.test.ts`, `trace.test.ts`, `busy.test.ts`: two runs on one conversation, also a follow-up queued behind the first |
| the result is the run's last submit that passed the schema | the submit tool parses with zod before it keeps the result; a failed parse goes back to the model; the reminder counts only the run's own entries | `runtime.test.ts`: a bad submit, then a good one; a second run reminded though the first submitted |
| every segment of a run is in one trace | the run document keeps the span the run started in, or its first segment | `crash.test.ts`: the resumed segment under the host's span |
| tracing never fails a run | each hook's tracing runs guarded; an error goes to OpenTelemetry's `diag` | the whole suite runs with and without an SDK |

## After a crash

One runtime per process owns its storage: `openRuntime({ storage, models, agents, resources, credentialFor, captureContent })`, with `openNodeSqliteStorage(file)` to keep conversations, or `MemoryStorage` to keep none. Each agent is its own extension, named `agent-<name>`, so a run that resumes finds its code; runs a crash left go on at once.

| Crash point | What pi does | What holds |
|---|---|---|
| before the conversation's commit | nothing is stored | `run(runId)` makes the conversation fresh |
| after the conversation's commit, before the run's | the conversation, its document and middleware state are kept | `run(runId)` finds it and admits the input, once |
| mid model request | a failed attempt, tried again | the run goes on; no finished call is repeated |
| while a call waits on a question | the call runs again | it finds its question kept, and waits again; the answer, given to the new process, goes on at that call |
| after an answer, before the tool ran | the call runs again | it goes on with the kept answer, asking nobody |
| mid tool | the call runs again; its tool had started | the model gets an `interrupted` result; the tool does not run again |
| mid tool, `replay: "safe"` | the tool runs again, with its conversation's context | five crashes in a row (pi's restart limit) stop it, and the model gets an error result |
| after the submit | the run is settled | `run(runId)` gives back the result, with no model call |
| a follow-up queued, mid the run before it | the queue is kept; the run goes on, then the follow-up starts | each runs once, in order; `run(runId)` of either gives its result |

`loop/crash.test.ts` kills a real process at each point and opens the SQLite file again in a new one.

## What it leaves

A run gives back its outcome, its usage, its conversation and its trace.
- its outcome, as LangGraph's `invoke`: `{ status: "done", result }`, the output its submit gave or its answer as text, or `{ status: "interrupted", interrupts }`, the questions it waits on, each `{ id, value, error? }`. `signal` stops a run: the conversation is aborted, and `run` rejects with the signal's reason
	- a refusal before the run is admitted: `RunRefused`, with its reason: `other_agent`, `other_caller`, `other_context`, `busy`, `needs_connection` (`ConnectionsMissing`, with the connections the caller has no login for, for a run nobody attends), `connection_failed`, or `not_interrupted` (answers to a question the run does not wait on). Nothing of the run is kept
	- `onStarted`: called once the run is admitted, or found admitted, and its answers kept; after it, `run` gives the outcome or `RunFailed`, never `RunRefused`. The server waits for it to answer 200 ([[que-pasa-server]])
	- a run that ended with no result: `RunFailed`, with pi's reason, `no_submit`, or `needs_connection` and `needs_answer` with the `interrupts` a run nobody attends stopped on
- its usage: `onUsage`, once, when it ends, answered or not: what the run spent, tokens and cost per `provider/model-id`, and per tool. Not while it waits
- its conversation: `onMessages`, once, when it ends, answered or not, as pi-ai's messages in order, up to the run's end: every run's input, each assistant message with its tool calls, each tool result, the reminders and the submits. Not the system prompt
- its trace (`loop/trace.ts`): OpenTelemetry spans in the GenAI conventions (semconv 1.43.0), made live from pi's hooks, through `@opentelemetry/api` only
	- `invoke_agent <agent>`: one per run, per process that works on it, each run its own trace. Agent name, `gen_ai.agent.version` (a hash of instructions, middleware, tools, output and model), `gen_ai.conversation.id` = the conversation's key, `que_pasa.run.id` = the run id, model and provider, `enduser.id` = the caller, `que_pasa.resumed`, the run's usage at its end, and error status with `error.type` when it failed. An event per reminder
	- `chat <model>` per model request, and `execute_tool <tool>` per tool call, with `error.type` on an error result, such as `interrupted`, and an event per question its call asked (`que_pasa.interrupt`) and per answer it went on with (`que_pasa.resume`), each with `que_pasa.interrupt.id`
	- a run that waits keeps its segment open: it has not ended
	- message content only with `captureContent: true`
	- `run()` returns after its segment has ended, so a host's span around it holds the whole run
