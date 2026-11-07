---
type: service
description: "que-pasa, que-v2's harness: a company writes its agents once in a workspace, and que-pasa runs them, durably and traced. It knows no company. Read for what it holds to, and what it is made of: the workspace, the loop, the host, and its seams."
status: planned
---
que-v2's harness: a company writes its agents once in a workspace, and que-pasa runs them, durably and traced. It knows no company.
- [[#Principles]] what que-pasa holds to, and why
- [[#Workspace]] what a company writes: the base
- [[#Loop]] an agent in motion, for one caller
- [[#Host]] how a workspace is served
- [[#Seams]] what crosses to the outside

- [[que-v2-design]]: the design it follows
- [[que]]: the harness it replaces
- `README.md`: how to run and check it, and how a project uses it

---
## Principles

Three ideas decide what que-pasa builds, and what it leaves out.
- agents are the deliverable: a company's people are given agents, not tools. An agent definition is what ships, and a package can deliver agents
- evals are the design: every agent is developed against cases and proven by them. So every run leaves a trace, and a case is just a run
- the inner loop is king, and context is the product: harness engineering is context engineering. Good context is the smallest set of high-signal tokens that gets the result; more in the window often makes the agent worse. The measure is accuracy per token. The loop itself: [[que-pasa-loop#The idea]]

## Workspace

What a company writes, in its own repo, with que-pasa's `define`: one per company. A workspace as a whole (`defineWorkspace`) is not built: today a host lists its agents itself.
- agents (`defineAgent`): name, model (`provider:model-id`), instructions, its tools, and an output schema. With no output, it answers in text
- tools (`defineTool`): name, description, zod schema, `run(input, runtime)`, the connection it names, and `replay: "safe"` when a call a crash cut off may run again. A tool gets `runtime.caller` and `runtime.context`, the JSON the host gave the run
- skills: packaged know-how an agent loads when a task matches. Not built
- connections: logins to outside services, owned by a user or by the agent. A tool names one; resolving it is not built
- tests: eval cases, beside what they check. Not built
- teams: who gets which agents. Not built

## Loop

An agent in motion: one agent, one input, one caller, made by `loop/` on pi-durable. In full: [[que-pasa-loop]].
- a run's life: it starts from an input, moves through model and tool calls, and ends with an answer or a submit. Continuing with a new input is not built
- what keeps it right: durability, so it survives a crash; middleware (approval, limits) is not built
- what it leaves: its result, usage, conversation and trace

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

