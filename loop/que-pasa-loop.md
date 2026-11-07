---
type: component
description: "que-pasa's loop: an agent in motion, one agent, one input, one caller, run on pi-durable, durable and traced. Read for how a run lives, what keeps it right across a crash, and what it leaves behind."
status: running
---
An agent in motion: one agent, one input, one caller. Nobody writes a run; `loop/` makes it, on pi-durable, whose generation task is the loop itself.
- [[#A run's life]] it starts, moves and ends
- [[#What keeps it right]] durability, and middleware
- [[#What it leaves]] its result, usage, conversation and trace

- [[que-pasa]]: the harness it is part of

---
## A run's life

A run starts from an input, moves through model and tool calls, and ends with an answer or a submit.
- starts: `runtime.run(agent, input, { runId, caller, model, context, signal, onUsage, onMessages })`
	- a run is one conversation, made in one commit with its agent's model, instructions and extension, and its run document (`que-pasa.run`: run id, agent, model, caller, context). A session document per run id (`que-pasa.run-index`) finds it again
	- `runId` is the host's id for the run: the same id again is the same run, which goes on from where it is or gives back its result, with the input, caller, model and context it was started with. Its input goes in with the run id as pi's `requestId`, so it goes in once
	- `model` runs it on another model than the agent's, such as a fallback for a retry
- moves: pi calls the model, then the tools it asked for, until it answers
	- each tool is a pi tool: pi checks the arguments against its JSON Schema (the input shape, so a field with a default is optional), zod parses them, and the tool's `run` gets the caller and context from the run document
- ends
	- an agent with an output gets a `submit` tool with that schema. A submit that fails the schema goes back to the model; a good one ends the run, with no other model call. An agent that answers in text is reminded twice, then the run fails. LangChain's `toolStrategy`
	- an agent with no output gives back its answer as text
	- `signal` stops it: the conversation is aborted, and `run` rejects with the signal's reason
- continued by a new input, for chat and for evals with a simulated user: not built

## What keeps it right

A run survives a crash, and middleware will shape it.
- durability: `openRuntime({ storage, models, agents, captureContent })` opens one pi harness per process, on the storage the host picks (`openNodeSqliteStorage(file)` to keep runs, `MemoryStorage` to keep none)
	- each agent is its own extension, named `agent-<name>`, so a run that resumes finds its code. Runs a crash left unfinished go on at once
	- nothing of a run is held in memory: tools read the caller and context from the run document, the submitted result is the submit tool's result in the transcript, and the reminders are counted there
	- after a crash (`loop/crash.test.ts` kills a real process at each point): mid model request, the request is tried again; mid tool, a tool does not run again and the model gets an `interrupted` result, unless it is `replay: "safe"`, which runs again with the run's own context, at most five times (pi's restart limit); after the submit, the result is kept and given back with no model call
- middleware (approval, summarize, limits): not built

## What it leaves

A run gives back its result, its usage, its conversation and its trace.
- its result: the output the submit gave, or the answer as text
- its usage: `onUsage`, once, answered or not: tokens and cost per `provider/model-id`, and per tool
- its conversation: `onMessages`, once, answered or not, as pi-ai's messages in order: the input, each assistant message with its tool calls, each tool result, the reminders and the submit. Not the system prompt, which is the agent's instructions
- its trace (`loop/trace.ts`): OpenTelemetry spans in the GenAI conventions (semconv 1.43.0), made live from pi's hooks, through `@opentelemetry/api` only
	- `invoke_agent <agent>`: one per process that works on the run. Agent name, `gen_ai.agent.version` (a hash of instructions, tools, output and model), `gen_ai.conversation.id` = the run id, model and provider, `enduser.id` = the caller, `que_pasa.resumed`, the run's usage at its end, and error status with `error.type` when it failed (pi's reason, or `no_submit`). An event per reminder
	- `chat <model>` per model request, and `execute_tool <tool>` per tool call, with `error.type` on an error result, such as `interrupted`
	- message content only with `captureContent: true`
	- the run keeps the host's span it was started in (or its first segment), so every segment, also one that resumes in a new process, is in one trace. `run()` returns after its segment has ended
