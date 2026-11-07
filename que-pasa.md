---
type: service
description: "que-pasa, que-v2's harness: a company writes its agents once in a workspace, and que-pasa runs them, durably and traced. It knows no company. Read for what que-pasa is made of: the workspace, the run, the host, and its seams."
status: planned
---
que-v2's harness: a company writes its agents once in a workspace, and que-pasa runs them, durably and traced. It knows no company.
- [[#Workspace]] what a company writes: the base
- [[#Run]] an agent in motion, for one caller
- [[#Host]] how a workspace is served
- [[#Seams]] what crosses to the outside

- [[que-v2-design]]: the design it follows
- [[que]]: the harness it replaces
- `README.md`: how to run and check it, and how a project uses it

---
## Workspace

What a company writes, in its own repo, with que-pasa's `define`: one per company. A workspace as a whole (`defineWorkspace`) is not built: today a host lists its agents itself.
- agents (`defineAgent`): name, model (`provider:model-id`), instructions, its tools, and an output schema. With no output, it answers in text
- tools (`defineTool`): name, description, zod schema, `run(input, runtime)`, the connection it names, and `replay: "safe"` when a call a crash cut off may run again. A tool gets `runtime.caller` and `runtime.context`, the JSON the host gave the run
- skills: packaged know-how an agent loads when a task matches. Not built
- connections: logins to outside services, owned by a user or by the agent. A tool names one; resolving it is not built
- tests: eval cases, beside what they check. Not built
- teams: who gets which agents. Not built

## Run

An agent in motion: one agent, one input, one caller. Nobody writes a run; que-pasa makes it, in `loop/` on pi-durable, whose generation task is the loop itself.
- starts: `runtime.run(agent, input, { runId, caller, model, context, ... })`. One conversation, made in one commit with its run document (run id, agent, model, caller, context). The same run id again is the same run
- continued by a new input, for chat and for evals with a simulated user: not built
- moves: model call, tool calls, until it answers, or submits its output (a `submit` tool with the output schema; a bad one goes back to the model, an answer in text is reminded twice)
- shaped by middleware (approval, summarize, limits): not built
- survives a crash: one runtime per process owns its storage (SQLite); nothing of a run is held in memory. Mid model request, the request is tried again; a tool cut off mid-call does not run again unless it is `replay: "safe"`; after the submit, the result is kept (`loop/crash.test.ts` kills a real process at each point)
- ends: `run()` gives back the output, or the answer as text, and its usage (`onUsage`) and conversation (`onMessages`). `signal` stops it
- leaves a trace: OpenTelemetry GenAI spans, live (`loop/trace.ts`). An `invoke_agent` span per process that works on the run, a `chat` span per model call, an `execute_tool` span per tool call. Message content only with `captureContent`

## Host

How a workspace is served: a process that runs its agents.
- today a host wires `loop/` itself: storage, models, its agents, the OTel SDK, and calling `run()` again for runs a restart left. Assembly is one
- a standard host, which does that wiring by convention for any workspace (storage in a data folder, models and trace export from env, re-attach on start), and invocation (start a run, continue one): not built
- delivery, on the host: chat, MCP. Not built

## Seams

What crosses between que-pasa and the outside.
- a company's repo: imports `que-pasa/define` and `que-pasa/loop`, built to `dist/`, from que-pasa's folder (`file:`, `install-links=true`). zod is a peer
- a host: gives storage, models and agents; gets results, usage and conversations
- observability: spans go out through `@opentelemetry/api` only. The host owns the SDK and where spans go; it records what only it knows on its own span and calls `run()` inside it, and every segment of the run, also after a crash, is in that trace
- evals (eval2): read traces; cases live in the workspace's tests; they start runs as a host would, with their case ids on their own span
- target systems (Odoo and others): reached by tools, with a connection's login. Not built

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