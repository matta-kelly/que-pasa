---
type: service
description: "que-pasa, que-v2's harness: agents are written once in a workspace, and que-pasa runs them, durably and traced, so each can be proven against cases. It knows no workspace. Read for what que-pasa is made of: the workspace, the loop, the host, and its seams."
status: planned
---
que-v2's harness. Agents are written once, in a workspace; que-pasa runs each of them for whoever calls it, keeps every run across a crash, and records what it did, so every agent can be proven against cases. It knows no workspace.
- [[#Workspace]] what is written in a workspace, and what it delivers: its agents
- [[#Loop]] what an agent does when it runs
- [[#Host]] how a workspace's agents are reached
- [[#Seams]] what crosses to the outside

It takes LangChain's model and builds it on pi: their docs and paradigms are the guide, and only their parts, which run on LangSmith alone, are left out.
- [Fleet](https://docs.langchain.com/langsmith/fleet/comparison): tools and shared [skills](https://docs.langchain.com/langsmith/fleet/skills) belong to the workspace; agents are built from them, and shared to run, clone or edit
- an agent acts for the end user (an Assistant) or as itself (a Claw) ([Harrison Chase](https://x.com/hwchase17/status/2034680451017973903))
- a [connection](https://docs.langchain.com/langsmith/python/managed-deep-agents-connections) holds a credential owned by the user or by the agent, and the runtime resolves the caller
- [create_agent](https://docs.langchain.com/oss/python/langchain/agents.md): an agent is a small core, plus middleware

- [[que-v2]]: the issue it is built for, and its open questions
- [[que]]: the harness it replaces. que builds each person's agent at runtime from the plugins they can reach, one tool per op; que-pasa gives a workspace's tools to each team as agents made for its work, with access on top
- `README.md`: how to run and check it, and how a project uses it

---
## Workspace

What is written in a workspace's own repo, with que-pasa's `define`: its agents, everything they are built from and proven by, and who may use them: the index of what its agents are built from. Its people are given its agents, not its tools, so access is set once per agent, and a person picks among their agents: no router stands in front of them. The factory is a workspace too, whose agents act as themselves and are started by events and code. A workspace as a whole (`defineWorkspace`) is not built: today a host lists its agents itself.

```
<repo>/
└── workspace/
    ├── connections.ts          each connection, and who owns its login
    ├── tools/
    │   └── <service>/          the tools that read one connection
    │       └── <tool>.ts
    ├── memory/
    │   └── <file>.md           context the model always reads
    ├── skills/
    │   └── <skill>/SKILL.md
    ├── tests/                  eval cases, beside the capability they check
    ├── agents/
    │   ├── <agent>.ts          picks its tools, memory and skills from this workspace
    │   └── <agent>.md          its instructions
    └── teams.ts                each team: its members, and the agents it is given
```

- agents (`defineAgent`): what is delivered. A package can deliver agents
	- its core: a name (kebab-case), a model (`provider:model-id`), instructions, the tools it may call and no others, and the shape of its result. With none, it answers in text
	- it acts as the caller, with each person's own login, or as itself, with its own. Not built: today every tool gets the caller, and connections are not resolved
	- context scope and lifecycle are settings, not kinds of agent: a chat agent keeps one conversation, a worker one task, an ephemeral one one call. A conversation keeps its history across runs ([[que-pasa-loop#Conversation and run]]); a host picks the scope by its conversation key
	- middleware ([[que-pasa-middleware]]): optional behaviours on its loop, each separate, in LangChain's shape. Built: the primitive, with the hooks memory needs, and memory. Approval, summarize and call limits are not built
- what an agent is built from
	- tools (`defineTool`): [[define-tool]]. A function an agent can call, written once, so any agent in the workspace can be given it. It gets what it acts on from its conversation as a resource, a sandbox or a login, and never holds it
		- ready-made: the file and command tools of [[que-pasa-sandbox]], which act in the sandbox the host gives each conversation
	- memory: files the model always reads, loaded once when a conversation is made and kept in it, picked by `memory({ backend, sources })` in the agent's middleware, after Deep Agents' `MemoryMiddleware`. A file of `memory/` can serve any agent; the role's note links what its agent loads. Read only: the agent does not edit it
	- skills: packaged know-how for one kind of task, a folder with `SKILL.md` (the Agent Skills format). The agent sees each skill's name and description at start, and reads the rest when a task matches. Not built
	- connections: a resource that links to one outside service, whose login the workspace names. Not built
		- owned by a user: each person authorizes their own account once, and the run that first needs it pauses and asks
		- owned by the agent: one credential, used for every caller
- what an agent is proven by: tests, eval cases beside the capability they check. Every agent is developed against its cases and proven by them. Not built
- who is given which agents: teams, a group of people and the agents they are given. Everyone in a team can run its agents; one person is a team of one. Not built

## Loop

[[que-pasa-loop]]: what an agent does when it runs: a conversation of one agent and one caller, and its runs, each one input. The agent remembers nothing; its conversation is a log, kept durably, so a run goes on after a crash and leaves a full record.
- a conversation carries its caller: tools read it from the conversation, and no tool or agent passes the user along. The caller can be a person, or a program: a service, or the agent itself
- a person, a schedule, an event or code starts a run. Today `run()` waits for the run's end; a run started and left to go on, to be picked up later by its run id, for a schedule or an event, is not built
- a run's life: it starts from an input, moves through model and tool calls, and ends with an answer or a submit. The conversation's next run starts from a new input, with the whole history
- what keeps it right: durability, so a finished step is never done twice; middleware, whose state a conversation keeps, so every run on it, also one that resumes, has what it was made with. Approval and limits are not built
- what it leaves: its result, usage, conversation, and its trace, which is what evals read

## Host

How a workspace's agents are reached: a process that runs them.
- today a host wires `loop/` itself: storage, models, its agents, the resources their tools use (such as each conversation's sandbox), the OTel SDK, and starting again the runs a restart left. Assembly is one
- server ([[que-pasa-server]]): a host that starts runs for callers outside its process, after LangGraph's Agent Server. It asks the deployment who is calling, which agents they get and what context a conversation has, then runs the agent. Its HTTP API lists the caller's agents and runs an input on a conversation; its operations serve a way in in the same process. L&L is its first deployment
- a standard host, which does that wiring by convention for any workspace: not built
	- storage in the deployment's data folder, and models from env
	- traces: it starts the OpenTelemetry SDK, which reads OTel's own `OTEL_*` variables, so a deployment points its traces at Langfuse, a collector or any backend with no code. With none set, OTLP JSON files in a known folder of the data folder: the one part que-pasa writes
	- starting again, on start, the runs a restart left
	- invocation: run one agent of the workspace on an input, or a next run on a conversation, so a person, or a simulated user in an eval, can drive several turns
- delivery: how a person reaches their agents, on the host: chat, MCP, a phone. One agent definition serves every delivery, and a delivery changes nothing in it: an agent holds nothing about how it is reached. Each delivery is its deployment's, on the server: L&L's MCP layer is one

## Seams

What crosses between que-pasa and the outside.
- a workspace's repo, and a host, import `@mku1tra/que-pasa/define`, `/loop`, `/middleware`, `/sandbox` and `/server`, by its published version on npm. zod is a peer
- a host gives storage, models, agents and resources, and gets results, usage and conversations
- a server ([[que-pasa-server]]): que-pasa ships the routes, the checks and the run; the deployment answers who is calling, which agents they get and what context a conversation has, from its own control plane, and serves it on its box
- a sandbox ([[que-pasa-sandbox]]): que-pasa ships the backends, the view and the tools; the host gives each conversation its backend, and sets the policy: image, mounts, network, read-only, view
- spans go out through `@opentelemetry/api` only. The host owns the SDK and where spans go; it records what only it knows on its own span and calls `run()` inside it. Every segment of a run, also after a crash, is in that trace
- evals (eval2): que-pasa gives them traces and runs; grading is theirs
	- they read standard OTLP: files for local and offline work, an endpoint for online grading
	- a case lives in the workspace's tests; running one is a run started through invocation, as any host would, with the case and experiment ids on the host's own span
	- scores and labels are eval2's own records, keyed by trace and span id, and can go out as `gen_ai.evaluation.result` events through the same export
	- seeding a case's starting state is per domain (Odoo, a repo), and stays outside que-pasa
- target systems (Odoo and others) are reached by tools, with a connection's login. Not built
