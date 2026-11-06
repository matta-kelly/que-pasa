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

- the repo: a dev container, and one check (`just check`: notes, types, lint, format). The pre-push hook and the pipeline run the same `scripts/check.sh`

## Not built

The parts, each a folder:
- `define/`: `defineAgent`, `defineTool`, `defineConnection`, `defineTeam`, the types a workspace is written against
- `loop/`: how an agent runs, on pi-durable
- `middleware/`: approval, summarize, limits
- `connections/`: the credential store, resolved by the run's caller
- `sandbox/`: where a run executes: a worktree, a container
- `delivery/`: chat, MCP

A workspace (connections, tools, skills, tests, agents, teams: [[que-v2-design#Design]]) is not in que-pasa. It is a deployment, in the company's own repo, written against `define/`: landl's for landl, assembly for the factory.
