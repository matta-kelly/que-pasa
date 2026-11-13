---
type: component
description: "que-pasa's middleware: optional behaviours on an agent's loop, after LangChain's middleware, built on pi-durable's documents, prompt sections and que-pasa's tool calls, with memory on it, after Deep Agents' MemoryMiddleware, and approval, after LangChain's HumanInTheLoopMiddleware. Read for what a middleware is, how each LangChain hook maps onto pi-durable, what memory loads and when, how approval asks, and where it differs from LangChain and Deep Agents."
status: running
---
An optional behaviour on an agent's loop: a name and hooks, after LangChain's middleware. The primitive is `defineMiddleware` in `define/`; the loop runs its hooks; the middleware que-pasa ships are `middleware/`, exported as `@mku1tra/que-pasa/middleware`.
- [[#The primitive]] a name, a state, and hooks
- [[#The hooks on pi-durable]] each LangChain hook, and the durable part it is built on
- [[#Memory]] files an agent always has in its context
- [[#Approval]] a person decides on a tool call before it runs
- [[#Where it differs]] from LangChain and Deep Agents

- [[que-pasa]]: the harness it is part of
- [[que-pasa-loop]]: the loop the hooks run in, and the invariant that a conversation keeps its middleware's state
- [[que-pasa-sandbox]]: the backend memory reads its files through

---
## The primitive

- middleware: an optional behaviour on an agent's loop, given in the agent's `middleware` list, in order
- name: kebab-case, one per agent, the key of what it keeps
- state: what it keeps for a conversation, as JSON, so the conversation keeps it in storage and every run on it, also one that resumes in a new process, has the same
- hooks, each optional:
	- `beforeAgent(conversation)`: LangChain's `before_agent`. Once per conversation, when its first run makes it, from the conversation as it is made (`conversation`, `caller`, `context`). What it gives back is its state
	- `systemPrompt(state)`: what LangChain's `wrap_model_call` does when it appends to the system message. Before each model request, from the state the conversation keeps. Its state is null when it has no `beforeAgent`, or the conversation was made before the agent had it
	- `wrapToolCall(request, handler)`: LangChain's `wrap_tool_call`. Around each call of the agent's tools, outermost first: it may ask a person with `request.interrupt(value, answer?)` before it calls `handler` ([[que-pasa-loop#The interrupt]]), call `handler(args)` with other arguments, or give a result of its own, a `ToolMessage` (`{ content, status }`), and not call it. `request` holds the call's `name`, `args`, `id`, `caller` and `context`
- not built: LangChain's `before_model`, `after_model` and `after_agent`. They come as more optional hooks on the same type, with no break

## The hooks on pi-durable

| LangChain | What it does | pi-durable | que-pasa |
|---|---|---|---|
| `before_agent` → a state update | runs at the start, may load data | a document written in the commit that makes the conversation | `beforeAgent(conversation)`, its result kept in `MiddlewareDoc` |
| state (`memory_contents`) | what a middleware keeps | a conversation document family | `MiddlewareDoc`, one per middleware, by its name |
| `wrap_model_call` → `append_to_system_message` | adds to the system prompt on each call | a prompt section of the agent's extension, rendered from committed documents before each request | `systemPrompt(state)`, a section keyed `middleware-<name>` |
| `before_model`, `after_model` | change the request, read the answer | `beforeRequest`, `afterResponse` | not built |
| `wrap_tool_call` | around each tool call: approval, limits | que-pasa's tool call, which pi runs as one replay-safe call: a question kept in the run's document, a marker before the tool's code | `wrapToolCall(request, handler)` |
| `interrupt()`, `Command(resume)` | stop, ask a person, go on with the answer | none: its tasks wait only on tasks, or until a time | `request.interrupt(value, answer?)`, answered by `runtime.run(agent, { resume })` |
| `after_agent` | at the end | `afterRun` | not built |

- durable by construction: `beforeAgent` runs once, before the commit that makes the conversation, and that commit keeps what it gave. A section reads only what is kept. So every run on the conversation, also one that resumes in a new process or after a source changed, sees what it was made with
- a `beforeAgent` that throws fails the run before anything is kept: `run(runId)` again makes the conversation fresh
- pi sends a section again only when its text changes, so a middleware's section keeps the provider's prompt cache warm
- the system prompt is each middleware's section, in the agent's order, then the agent's instructions, which pi renders last
- a trace's `gen_ai.system_instructions`, with content captured, holds the same parts in the same order; the agent's version hashes its middleware names

## Memory

`memory({ backend, sources, systemPrompt })` (`middleware/memory.ts`): files an agent always has in its context, a port of Deep Agents' `MemoryMiddleware`.
- `backend`: where the files are, a `FileBackend`, such as `local({ root: <workspace> })`. It reads them with `download`
- `sources`: their paths, loaded in this order
- `systemPrompt`: the prompt the memory goes in, at `{agent_memory}`. Deep Agents' by default. One without the slot is refused at definition
- `beforeAgent`: downloads the sources, as UTF-8 text. A source that is not there is left out, as Deep Agents does; any other error, or a file that is not UTF-8, fails the run
- `systemPrompt`: each source as its path, a blank line and its text, with its HTML comments left out (authoring notes), joined by blank lines. "(No memory loaded)" when none was there
- in a workspace: the files are in `memory/`, an agent picks them in its `.ts`, and its role's note links them, so the note shows what the agent loads ([[que-pasa#Workspace]])

## Approval

`humanInTheLoop({ interruptOn })` (`middleware/human-in-the-loop.ts`): a person decides on a call of a gated tool before it runs, a port of LangChain's `HumanInTheLoopMiddleware` in its per-call mode.
- `interruptOn`: the gated tools, by name, each to `true` for every decision, or to `{ allowedDecisions, description }`. The other tools run as they are. A tool with no decision allowed is refused at definition
- the question, LangChain's `ToolApprovalRequest`: `{ type: "tool_approval", name, args, description, allowedDecisions }`. The description is LangChain's by default: "Tool execution requires approval", the tool and its arguments
- the answer, one of the allowed decisions, LangChain's:
	- `{ type: "approve" }`: the call runs
	- `{ type: "edit", editedAction: { name, args } }`: the call runs with these arguments, which the tool's schema checks; the name must stay the tool's
	- `{ type: "reject", message? }`: the tool does not run, and the model gets an error result, LangChain's words, with the message as the reason
	- `{ type: "respond", message }`: the tool does not run, and the model gets the message as its result
	- any other answer is refused, and the question asked again with why
- a run nobody attends fails at a gated call, `needs_answer`, before the tool acts
- who decides, and how the question reaches them, is the deployment's: the server gives it as `interrupted` ([[que-pasa-server]])

## Where it differs

- from LangChain: a hook's state is the conversation's, in pi-durable's storage, not a graph's state. `before_agent` runs once per conversation, not on each run: Deep Agents' memory and skills skip their load when the thread has it, so the result is the same. A `beforeAgent` per run is not built
- from LangChain: `systemPrompt` is the one part of `wrap_model_call` built: it adds to the system prompt and does not wrap the call. A whole wrap is not built
- from Deep Agents: memory is read only. Its prompt keeps Deep Agents' `<agent_memory>` block and its guidance on trust, and leaves out the guidance to save to memory with `edit_file`
- from Deep Agents: the memory section comes before the agent's instructions, since pi renders instructions last. Deep Agents appends memory after its base prompt
- from Deep Agents: `add_cache_control` is not needed: pi keeps an unchanged section cached by itself
- from LangChain: approval asks per call, as its `per_call` mode, not once per model turn for every gated call (its `batched` mode). A run gives back every question it waits on together, so a person sees a turn's calls at once
- from LangChain: a `wrapToolCall` asks only before it calls `handler`; after the tool starts, `interrupt` throws. LangGraph reruns a node from its top on every resume; que-pasa goes on at the waiting call, and reruns it up to its question only after a restart, so what a call does before it asks must be safe to do again, and the tool has not run
