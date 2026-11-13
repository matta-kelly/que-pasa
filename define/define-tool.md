---
type: component
description: "A que-pasa tool: a function an agent can call, written once in a workspace, which gets what it acts on (a sandbox, a login) from its run as a resource and never holds it. Read for what a tool is, how it reaches an outside system safely, how a run calls it, and what is not built: connections and approvals."
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
- a connection is a resource that holds a login: the conversation's caller's, or the agent's own. A tool never holds a credential, and none enters the model's context. Not built: no connection resolves a login yet
- permissions are held at the tool and at the target system, never trusted to the agent
	- hiding a tool keeps an agent on task; the login, or the sandbox's wall, keeps it safe

## Approval

A tool that changes data can need a yes before it runs. Not built.
- an approval is middleware on the tool, and names who approves: the caller, or a named person
- a run waiting for the yes is durability holding state while a person decides: the run keeps, across a crash, until the answer comes
- where it would sit: pi's `beforeTool` hook, which can block a call

## How a run calls it

The loop gives each tool to pi as a pi tool, and pi records each call in the run's log.
- pi checks the model's arguments against the tool's JSON Schema (the input shape, so a field with a default is optional); zod parses them; `run` gets the runtime
- what it gives back goes to the model as text: a string as it is, anything else as JSON. A tool that throws gives the model an error result
- after a crash
	- a tool cut off mid-call does not run again: the model gets an `interrupted` result, and decides what to do
	- a `replay: "safe"` tool runs again, with the run's own caller and context, at most five times in a row (pi's restart limit); then the model gets an error result
- the trace: an `execute_tool <tool>` span per call, with `error.type` on an error result. Its arguments and result only with `captureContent`
- the `submit` tool is the loop's own, for an agent with an output: no agent tool may take its name
