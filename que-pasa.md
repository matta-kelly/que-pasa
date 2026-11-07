---
type: service
description: "que-pasa, que-v2's harness: it knows no company. A workspace's agents are written against its types, and it runs them. Read for what que-pasa is, what is built, and where each part goes."
status: planned
---
que-v2's harness: it knows no company. A company's workspace defines its agents against que-pasa's types, and que-pasa runs them.
- [[#Built]] what exists
- [[#Not built]] the parts in the design that do not exist yet

- [[que-v2-design]]: the design it follows
- [[que]]: the harness it replaces
- `README.md`: how to run and check it

---
## Built

- the repo: a dev container, and one check (`just check`: notes, then types, lint, format, tests and the build). The pre-push hook and the pipeline run the same `scripts/check.sh`
- `define/`: the two primitives a workspace writes its agents with, after LangChain's `tool()` and `createAgent`. Each is checked when it is defined, and fixed after
	- `defineTool`: name (snake_case), description, schema (zod), `run(input, runtime)`, the name of the connection it reads, if any, and `replay: "safe"` when a call a crash cut off may run again
	- `defineAgent`: name (kebab-case), model (`provider:model-id`), instructions, its tools (no two of one name), and an output schema. With no output, it answers in chat text
	- the runtime a tool gets: `runtime.caller`, who the run acts for, and `runtime.context`, what the host gave the run (LangChain's runtime context), typed by the agent's `C`. The context is JSON, because the run keeps it
- `loop/`: a runtime that runs agents to their results on pi-durable, and keeps each run across a crash
	- `openRuntime({ storage, models, agents })`: one pi harness per process, on the storage the host picks (`openNodeSqliteStorage(file)` to keep runs, `MemoryStorage` to keep none). Each agent is its own extension, named `agent-<name>`, so a run that resumes finds its code. Runs a crash left unfinished go on at once
	- `runtime.run(agent, input, { runId, caller, model, context, signal, onUsage, onMessages })` runs one agent on one input to its result. `model` runs it on another model than the agent's, such as a fallback for a retry. `runId` is the host's id for the run: the same id again is the same run, which goes on from where it is or gives back its result, with the input, caller, model and context it was started with
	- a run is one conversation, made in one commit with its agent's model, instructions and extension, and its run document (`que-pasa.run`: run id, agent, model, caller, context). A session document per run id (`que-pasa.run-index`) finds it again. Its input goes in with the run id as pi's `requestId`, so it goes in once
	- no run state is held in memory: tools read the caller and context from the run document, the submitted result is the submit tool's result in the transcript, and the reminders are counted in the transcript
	- each tool is a pi tool: pi checks the arguments against its JSON Schema (the input shape, so a field with a default is optional), zod parses them, and `run` gets the runtime
	- an agent with an output gets a `submit` tool with that schema. A submit that fails the schema goes back to the model to try again; a good one ends the run, with no other model call. An agent that answers in text is reminded twice, then the run fails. LangChain's `toolStrategy`
	- an agent with no output gives back its answer as text
	- `signal` stops the run: the conversation is aborted, and `run` rejects with the signal's reason
	- `onUsage` gets the tokens and cost this run spent, once, answered or not: per `provider/model-id`, and per tool
	- `onMessages` gets the run's whole conversation, once, answered or not, as pi-ai's messages in order: the input, each assistant message with its tool calls, usage and stop reason, each tool result, the reminders, and the submit. Not the system prompt, which is the agent's instructions
	- after a crash, what pi does and the runtime keeps (`loop/crash.test.ts` kills a real process at each point):
		- mid model request: the request is tried again, and the run goes on
		- mid tool: a tool left as it is does not run again, and the model gets an `interrupted` result; a `replay: "safe"` tool runs again, with the run's own context. One cut off five times (pi's restart limit) stops, and the model gets an error result
		- after the submit: the result is kept, and the run gives it back with no model call
## Not built

The parts, each a folder:
- `define/`: `defineConnection` and `defineTeam`
- `loop/`: a conversation of more than one input, for chat
- `middleware/`: approval, summarize, limits
- `connections/`: the credential store, resolved by the run's caller
- `sandbox/`: where a run executes: a worktree, a container
- `delivery/`: chat, MCP

A workspace (connections, tools, skills, tests, agents, teams: [[que-v2-design#Design]]) is not in que-pasa. It is a deployment, in the company's own repo, written against `define/`: landl's for landl, assembly for the factory.


---
## Actual persisting doc ig

*My take: in their docs, durability isn’t a separate pillar from your approval gates and idempotency. It’s what ties them together.*

- Evals as a central design paradigm
- Agents (definitions) are the deliverable
	- *Package / Extension --> Delivering agents (packages can be a component)*
- Inner Loop: DA KING
	- Context is the product
		- Good context engineering means finding the smallest set of high-signal tokens that gets the result you want. More stuff in the window often makes the agent worse.
#### Inner Loop: *how the model sees and acts*

The Inner loop is king: *harness engineering is always just context engineering*

- Name of the game: how can we most efficiently provide the model with the sufficient context to solve the give question. 
	- *Performance / Accuracy per token*
	- Environment setup & *Inner loop*
- The agent is a ***Stateless reducer***  
	- A reducer is a function that takes “everything so far” plus “one new thing” and returns the new “everything so far.” 
		- A running total is a reducer: `total = total + next_number`.
	- “Stateless” means the agent itself remembers nothing between calls. 
		- All memory lives in the log you pass in. Same log in, same decision out.
	- Think of a chess game. You don’t need the players’ brains to know where things stand. Give anyone the move list and they can rebuild the board and pick the next move.
- **Approval gates and idempotency aren’t two checklist items. They’re one thing: durable execution.** An approval gate is durability holding state while a human decides. Idempotency is durability’s own requirement in LangGraph’s docs. Your “no double orders” gap is the unfinished part of that one pillar, not a separate one.

All it is
```
log = [first_event]
while True:
    context = build(log)          # context engineering
    action  = model(context)      # the only "AI" line
    if action.done: break
    result  = run(action)         # your code, your rules
    log.append(action, result)
```

The nuance worth keeping: 
- one framing is that context engineering asks what you show the agent, while harness engineering asks what the system prevents, measures and fixes. 
- Same loop, two jobs: `build` vs `run`.


### Add:

- concept of durability and resuming in our build out, where can things fail, how do we maintain this
- all in all what are the durability invariants we are trying to uphold, how do we maintain this reliably and simply