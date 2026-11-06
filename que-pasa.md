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

- the repo: a dev container, and one check (`just check`: notes, then types, lint, format and tests). The pre-push hook and the pipeline run the same `scripts/check.sh`
- `define/`: the two primitives a workspace writes its agents with, after LangChain's `tool()` and `createAgent`. Each is checked when it is defined, and fixed after
	- `defineTool`: name (snake_case), description, schema (zod), `run(input, runtime)`, and the name of the connection it reads, if any
	- `defineAgent`: name (kebab-case), model (`provider:model-id`), instructions, its tools (no two of one name), and an output schema. With no output, it answers in chat text
	- the runtime: one shape for every agent, `runtime.context.caller`

## Not built

The parts, each a folder:
- `define/`: `defineConnection` and `defineTeam`
- `loop/`: how an agent runs, on pi-durable
- `middleware/`: approval, summarize, limits
- `connections/`: the credential store, resolved by the run's caller
- `sandbox/`: where a run executes: a worktree, a container
- `delivery/`: chat, MCP

A workspace (connections, tools, skills, tests, agents, teams: [[que-v2-design#Design]]) is not in que-pasa. It is a deployment, in the company's own repo, written against `define/`: landl's for landl, assembly for the factory.
