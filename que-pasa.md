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
	- `defineTool`: name (snake_case), description, schema (zod), `run(input, runtime)`, and the name of the connection it reads, if any
	- `defineAgent`: name (kebab-case), model (`provider:model-id`), instructions, its tools (no two of one name), and an output schema. With no output, it answers in chat text
	- the runtime a tool gets: `runtime.caller`, who the run acts for, and `runtime.context`, what the host gave the run (LangChain's runtime context), typed by the agent's `C`
- `loop/`: `run(agent, input, { caller, models, context, signal, onUsage, onMessages })` runs one agent to its result, on pi-durable
	- each tool is a pi tool: pi checks the arguments against its JSON Schema, zod parses them, and `run` gets the runtime
	- an agent with an output gets a `submit` tool with that schema. A submit that fails the schema goes back to the model to try again; a good one ends the run, with no other model call. An agent that answers in text is reminded twice, then the run fails. LangChain's `toolStrategy`
	- an agent with no output gives back its answer as text
	- `signal` stops the run: the conversation is aborted, and `run` rejects with the signal's reason
	- `onUsage` gets the tokens and cost the run spent, once, answered or not: per `provider/model-id`, and per tool
	- `onMessages` gets the run's whole conversation, once, answered or not, as pi-ai's messages in order: the input, each assistant message with its tool calls, usage and stop reason, each tool result, the reminders, and the submit. Not the system prompt, which is the agent's instructions
	- one run, in memory: nothing is kept after it ends, so a run cut off is not resumed

## Not built

The parts, each a folder:
- `define/`: `defineConnection` and `defineTeam`
- `loop/`: a run that is kept and resumed (pi-durable storage), and a conversation of more than one input
- `middleware/`: approval, summarize, limits
- `connections/`: the credential store, resolved by the run's caller
- `sandbox/`: where a run executes: a worktree, a container
- `delivery/`: chat, MCP

- the package: another project installs que-pasa from its folder (`file:`, with `install-links=true`) and imports `que-pasa/define` and `que-pasa/loop`, built to `dist/` by `npm run build`, which the check runs. zod is a peer: one copy, the project's

A workspace (connections, tools, skills, tests, agents, teams: [[que-v2-design#Design]]) is not in que-pasa. It is a deployment, in the company's own repo, written against `define/`: landl's for landl, assembly for the factory.
