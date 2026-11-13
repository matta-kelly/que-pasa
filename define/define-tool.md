---
type: component
description: "A que-pasa tool: a function an agent can call, written once in a workspace, which gets what it acts on (a sandbox, a login) from its run as a resource and never holds it. Read for what a tool is, how it reaches an outside system safely, through a resource or a connection, how a person approves a call, and how a run calls it."
status: running
---
A function an agent can call: written once in a workspace, so any agent in it can be given it. The code is `defineTool`, in `define/tool.ts`.
- [[#What a tool is]] its definition, and what it gets from a run
- [[#Reaching an outside system]] its resources, and what keeps it safe
- [[#Approval]] whether a person says yes before it runs
- [[#How a run calls it]] in the loop, across a crash, and in the trace

- [[que-pasa]]: the harness it is part of
- [[que-pasa-loop]]: the loop that calls it

---
## What a tool is

A tool is a name, a description, the input it takes and what it does; it gets who the run is for from the run, never from the model.
- its definition (`defineTool`)
	- name: what the model calls it by, snake_case, at most 64 characters
	- description: what it does and when to call it; the model reads it to choose
	- schema: the input the model must give, a zod object
	- `run(input, runtime)`: what it does
	- uses: the resources it asks its run for, if any (see [[#Reaching an outside system]])
	- `replay: "safe"`: a call a crash cut off may run again (see [[#How a run calls it]])
- what it gets from a run: `runtime.caller`, who the run acts for, `runtime.context`, the JSON the host gave the run, and `runtime.use(resource)`, the run's value of a resource it uses
	- both come from the run's document, never from the tool's arguments, so the model cannot say whom it acts for
	- an agent calling another agent passes the caller through the run, not through a tool's arguments. Not built
- an agent is given its tools explicitly, and can call those and no others

## Reaching an outside system

A tool reaches what it acts on through a resource, which the host gives each conversation; the tool never holds it.
- resource (`defineResource`): something a tool needs that the host gives each conversation, such as a sandbox ([[que-pasa-sandbox]]), or a login
	- a tool names the resources it uses in `uses`, and asks for one with `runtime.use(resource)`; any other throws
	- the host provides each one when it opens the runtime: `provide(resource, (conversation) => value)`, from the conversation's key, caller and context. A tool that uses one the host does not provide fails the runtime's open, never a run
	- the value is resolved once per run in a process, from the conversation as its first run made it: every run on it, also one that resumes in a new process, gets the same one
- connection (`defineConnection`, `define/connection.ts`): a resource that links to one outside service through a login, after LangChain's connections and que v1's connectors
	- its owner: `user`, each caller's own login, so the agent acts as them with their rights; or `shared`, one login for the deployment, which its control plane lets some callers use
	- its `credential`: the login's shape (zod), and `connect`, which turns a login into the connection a tool acts through, such as a logged-in client. The tool gets the connection with `runtime.use`, never the login, and no login enters the model's context, the storage or a trace
	- a tool lists it in `uses`, as any resource; an agent's connections are the ones its tools use
	- the deployment hands over the logins, from its control plane: `openRuntime({ credentialFor })`, for a connection and a caller. A tool that uses a connection, on a runtime with none, fails the runtime's open
	- the guard: before a tool's code runs, its call checks the caller has a login for each connection the tool uses
		- a run someone attends: a missing `user` login is asked for, with the interrupt ([[que-pasa-loop#The interrupt]]): "connect it", which the server gives with the deployment's page ([[que-pasa-server]]). Once answered it checks again, and asks again while the login is still missing
		- a missing `shared` login: the model is told it has no access, and nobody is asked, as the caller cannot fix it
		- a run nobody attends: the credential gate at its start, as LangChain's before the first model turn, checks every login its agent's tools use, and refuses the run before anything of it is kept (`ConnectionsMissing`), as nobody could connect one later. It asks for every connection the tools use, also one this run would not: a chosen cost for one simple rule
	- a login is asked for when a run starts, and when a call first needs it in a process; never kept. A login the service refuses: the connection's client, or the tool, throws `LoginRejected`, the run drops the connection, and the next call asks the deployment again
	- its `whoami`, optional: who the connection is logged in as (an id, a name, an email), so "me" and "mine" mean something to the model. A run asks at its start, for each login there, or once the person connects it; keeps the answer in its document, and its system prompt says it, after the middleware's sections and before the instructions: who the agent acts for (the caller's id, and name when the host gives one), and for each connection who it is logged in as and whose login that is, so a shared login is never taken for the caller. A `whoami` that fails at the start refuses the run (`connection_failed`), as a run that started without it would read "my" wrong
- permissions are held at the tool and at the target system, never trusted to the agent
	- hiding a tool keeps an agent on task; the login, or the sandbox's wall, keeps it safe

## Approval

A tool that changes data can need a person's yes before it runs: `humanInTheLoop`, a middleware ([[que-pasa-middleware#Approval]]).
- the agent lists the tools it gates, by name; the tool itself is unchanged
- a gated call asks before its tool's code runs, and the run waits, across a crash, until the answer comes: approve, edit, reject or respond
- who decides, and how the question reaches them, is the deployment's: the server gives it as `interrupted`

## How a run calls it

The loop gives each tool to pi as a pi tool, and pi records each call in the run's log.
- pi checks the model's arguments against the tool's JSON Schema (the input shape, so a field with a default is optional); zod parses them; `run` gets the runtime
- what it gives back goes to the model as text: a string as it is, anything else as JSON. A tool that throws gives the model an error result
- around its code: the check of its connections, then the agent's middleware, outermost first ([[que-pasa-middleware]]); any of them may ask a person first, and the call waits
- after a crash
	- a call that had not started its tool's code runs again: a question it asked is found, and it waits again, or goes on with the answer
	- a tool cut off mid-call does not run again: the model gets an `interrupted` result, and decides what to do. que-pasa keeps a marker just before the tool's code runs, and to pi every tool is replay-safe, so a waiting call can wait again
	- a `replay: "safe"` tool runs again, with the run's own caller and context, at most five times in a row (pi's restart limit); then the model gets an error result
- the trace: an `execute_tool <tool>` span per call, with `error.type` on an error result, and an event per question asked and answer taken. Its arguments and result only with `captureContent`
- the `submit` tool is the loop's own, for an agent with an output: no agent tool may take its name
