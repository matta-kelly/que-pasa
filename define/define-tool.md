---
type: component
description: "A que-pasa tool: a function an agent can call, written once in a workspace, which reads its login through a connection and never holds one. Read for what a tool is, how it reaches an outside system safely, how a run calls it, and what is not built: connections and approvals."
status: running
---
A function an agent can call: written once in a company's workspace, so any agent in it can be given it. The code is `defineTool`, in `define/tool.ts`.
- [[#What a tool is]] its definition, and what it gets from a run
- [[#Reaching an outside system]] its connection, and what keeps it safe
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
	- connection: the name of the connection it reads, if any
	- `replay: "safe"`: a call a crash cut off may run again (see [[#How a run calls it]])
- what it gets from a run: `runtime.caller`, who the run acts for, and `runtime.context`, the JSON the host gave the run
	- both come from the run's document, never from the tool's arguments, so the model cannot say whom it acts for
	- an agent calling another agent passes the caller through the run, not through a tool's arguments. Not built
- an agent is given its tools explicitly, and can call those and no others

## Reaching an outside system

A tool reaches an outside system (Odoo and others) with a connection's login, and the target system decides what that login may do.
- a tool names the connection it needs and reads it by name at call time, with the credential of the run's caller or of the agent. Not built
- a tool never holds a credential, and no credential enters the model's context
- permissions are held at the tool and at the target system, never trusted to the agent
	- hiding a tool keeps an agent on task; the login keeps it safe

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
