---
type: component
description: "que-pasa's loop: an agent in motion, one agent, one input, one caller, run on pi-durable, durable and traced. Read for the idea it follows, the states a run moves through, the invariants that hold in every state and what holds each, and what a run leaves."
status: running
---
An agent in motion: one agent, one input, one caller. Nobody writes a run; `loop/` makes it, on pi-durable, whose generation task is the loop itself.
- [[#The idea]] the agent is a stateless reducer over a durable log
- [[#States]] what a run moves through, and what moves it
- [[#Invariants]] what holds in every state, and what holds it
- [[#After a crash]] what each crash point does, and what still holds
- [[#What it leaves]] its result, usage, conversation and trace

- [[que-pasa]]: the harness it is part of

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
- in que-pasa the log is pi-durable's conversation, kept in the host's storage. `build` is the agent's instructions and tools; `run` is its tools, and, not built, middleware

## States

A run moves from admitted to settled, through model calls and tool calls; pi moves it, and que-pasa's runtime starts it and reads its end.

| State | Holds | Moves on when | Moved by |
|---|---|---|---|
| admitted | its conversation and run document, made in one commit; its input, in with the run id as `requestId` | pi takes the input | `runtime.run` |
| generating | a model request | the model answers: with tool calls to tooling, without to settled, or reminded to generating | pi's generation task |
| tooling | the round's tool calls | each has a result: to generating, or to settled when every result ends the run (the submit) | pi's tool tasks |
| settled | its answer or its failure; the run's result is read from the transcript | (terminal) | pi; `runtime.run` reads it |

- settled, as: answered (text), submitted (the output), or failed: `no_submit` after two reminders, or pi's reason (`aborted`, `model_error`, `restart_limit` and the others)
- continued by a new input, from settled back to generating, for chat and for evals with a simulated user: not built
- middleware between generating and tooling (approval, summarize, limits): not built

## Invariants

What holds in every state of every run. Each is held by construction, and checked by a test.

| Invariant | Held by | Checked by |
|---|---|---|
| one run per run id: the same id again is the same run, never a second | the run index, a session document per run id; the input in with the run id as pi's `requestId` | `runtime.test.ts`: the same run id twice, one model call |
| no run state in memory: a new process can go on with any run | the caller, context and model in the run document; the result and the reminders in the transcript | `crash.test.ts`: every crash point, in a new process |
| a finished step is never done twice | pi's checkpoint per step; a tool not marked `replay: "safe"` never runs again | `crash.test.ts`: mid tool, mid model request, after the submit |
| a run keeps what it was started with: input, caller, model, context | the run document, written once, in the commit that makes the run | `runtime.test.ts`: a run started again with another model |
| the result is the last submit that passed the schema | the submit tool parses with zod before it keeps the result; a failed parse goes back to the model | `runtime.test.ts`: a bad submit, then a good one |
| every segment of a run is in one trace | the run document keeps the span the run started in, or its first segment | `crash.test.ts`: the resumed segment under the host's span |
| tracing never fails a run | each hook's tracing runs guarded; an error goes to OpenTelemetry's `diag` | the whole suite runs with and without an SDK |

## After a crash

One runtime per process owns its storage: `openRuntime({ storage, models, agents, captureContent })`, with `openNodeSqliteStorage(file)` to keep runs, or `MemoryStorage` to keep none. Each agent is its own extension, named `agent-<name>`, so a run that resumes finds its code; runs a crash left go on at once.

| Crash point | What pi does | What holds |
|---|---|---|
| before the run's commit | nothing is stored | `run(runId)` starts it fresh |
| after the run's commit, before its input is in | the conversation and run document are kept | `run(runId)` finds them and puts the input in, once |
| mid model request | a failed attempt, tried again | the run goes on; no finished call is repeated |
| mid tool | the model gets an `interrupted` result | the tool does not run again |
| mid tool, `replay: "safe"` | the tool runs again, with the run's own context | five crashes in a row (pi's restart limit) stop it, and the model gets an error result |
| after the submit | the run is settled | `run(runId)` gives back the result, with no model call |

`loop/crash.test.ts` kills a real process at each point and opens the SQLite file again in a new one.

## What it leaves

A run gives back its result, its usage, its conversation and its trace.
- its result: the output the submit gave, or the answer as text. `signal` stops a run: the conversation is aborted, and `run` rejects with the signal's reason
- its usage: `onUsage`, once, answered or not: tokens and cost per `provider/model-id`, and per tool
- its conversation: `onMessages`, once, answered or not, as pi-ai's messages in order: the input, each assistant message with its tool calls, each tool result, the reminders and the submit. Not the system prompt, which is the agent's instructions
- its trace (`loop/trace.ts`): OpenTelemetry spans in the GenAI conventions (semconv 1.43.0), made live from pi's hooks, through `@opentelemetry/api` only
	- `invoke_agent <agent>`: one per process that works on the run. Agent name, `gen_ai.agent.version` (a hash of instructions, tools, output and model), `gen_ai.conversation.id` = the run id, model and provider, `enduser.id` = the caller, `que_pasa.resumed`, the run's usage at its end, and error status with `error.type` when it failed. An event per reminder
	- `chat <model>` per model request, and `execute_tool <tool>` per tool call, with `error.type` on an error result, such as `interrupted`
	- message content only with `captureContent: true`
	- `run()` returns after its segment has ended, so a host's span around it holds the whole run
