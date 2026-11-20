---
type: component
description: "que-pasa's MCP surface: the Model Context Protocol on que-pasa's server, so an MCP client (Claude Code, an IDE, another agent) reaches a deployment's agents as tools. Read for its route, how an agent becomes a tool, how a call becomes a run that nobody attends and what a call that needs a person gives back, how a call ends, and where it differs from LangGraph's MCP endpoint."
status: running
---
The Model Context Protocol on que-pasa's server: an MCP client reaches the agents a caller is given as tools, and nothing else. The code is `server/mcp/`, mounted at `/mcp` by `createServer`, on the official MCP SDK (`@modelcontextprotocol/server`). It runs on the same runtime, conversations, run ids and checks as the LangGraph routes ([[que-pasa-server]]) and the chat ([[que-pasa-chat]]), so an agent acts the same whichever way it was reached.
- [[#The route]] what a request to `/mcp` goes through
- [[#An agent as a tool]] what a client lists
- [[#A call as a run]] one run, nobody to answer, and its result
- [[#Where it differs]] from LangGraph's MCP endpoint

- [[que-pasa-server]]: the server it is part of, and its checks
- [[que-pasa-loop]]: the runs it starts, a run nobody attends, and how a run stops
- [[que-pasa-chat]]: the surface for a person in a browser, who can answer what a run asks

---
## The route

`POST /mcp`, stateless: each request stands alone, as the protocol's 2026-07-28 revision is, and the server keeps nothing between requests.
- the checks, before the protocol, in this order
	- the origin: a request whose `Origin` is not the server's own is refused, 403, the protocol's guard against DNS rebinding. A client that is not a browser sends none
	- the caller: `authenticate`, as every route: none, 401 `unauthenticated`
	- the agents: `agentsFor(caller)`, the tools of this request
- the protocol: the MCP SDK's handler (`createMcpHandler`), with a server made for this request
	- a 2026-07-28 client, and a 2025-era client, in the SDK's stateless serving: one request, one exchange
	- a response is an SSE stream, so progress reaches the client while a run goes on (`responseMode: "sse"`)
	- `GET` and `DELETE`: 405, as there is no stream to take up and no session to end
- `serverInfo`: que-pasa's package name and version, as a client shows the server it reached

## An agent as a tool

Each agent the caller is given is one tool, LangGraph's assistant as a tool.
- name: the agent's name, kebab-case, a valid tool name
- description: the agent's, what it does, for a model to choose by
- input: `{ input }`, one text, as every agent takes
- output: an agent with an `output` gives its schema as the tool's `outputSchema`
- a tool list is the caller's now: a grant changed shows from the next request. An agent the caller is not given is an unknown tool, the protocol's error

## A call as a run

A call is one run, on a conversation of its own, which nobody attends. Its outcome is the tool's result.
- the run: one id, made for the call, is the conversation's key and the run's `runId`. The conversation is kept in the caller's history, so a chat's list and the LangGraph reads show what was done over MCP
	- the same request again is a new call, so a new run: MCP has no key that outlives a call, and the protocol has a client send a call again as a new request. A tool's effect happens once by its own keys ([[que-pasa-loop#The idea]])
- nobody attends it, as nobody can answer a question inside an MCP call: a run that would ask stops before the step that asks acts, and the call says what is needed ([[que-pasa-loop#The interrupt]])
	- a missing login: refused before anything is kept, by the credential gate of a run nobody attends, with the deployment's `connectUrl` as a full link: "No login for crm (connect it at …). Connect it, then call again. Nothing ran."
	- an approval: the run fails `needs_answer` before the gated tool acts, and the call says what it asked, by the question's description. The run reads failed in the history
- progress: a call that carries a progress token gets `notifications/progress` each second while the run goes on, so a client that times out a quiet call (Claude Code's idle limit is 5 minutes) waits for it
- its end, the tool's result
	- done: the agent's text; an agent with an `output` gives it as `structuredContent`, and the same as JSON text. The images the run's tools made follow, as MCP's image content, base64, in the order they were made ([[que-pasa-files]])
	- failed: an `isError` result with why, which the model reads and tells the person: a question it stopped on, as above, or `The run failed (<reason>): <message>`
	- refused by the deployment (`Refused` from `contextFor`): an `isError` result with its message
- cancelled: the client closes the call, or goes away, as the protocol treats both as a cancel. The run stops, as a person's stop does ([[que-pasa-loop#Conversation and run]]): kept `stopped`, and the tool's `runtime.signal` aborts

## Where it differs

- from LangGraph's MCP endpoint: the same shape (an agent as a tool, a call a run on a conversation of its own, no sessions, JSON-RPC errors only for the protocol's), with these differences
	- a call's conversation is kept, in the caller's history; LangGraph deletes the thread when the call ends
	- a question fails the call with what is needed; LangGraph asks it with elicitation, and refuses a client that cannot ask
	- a call has no `context`: `contextFor` is the deployment's, as for every surface
	- a response is always SSE, so progress reaches the client; LangGraph answers JSON
- not built
	- resumable calls, MCP's Tasks extension: the SDK serves none, and few clients speak it
	- elicitation, which asks a question inside a client that supports it
	- a `conversation` field, which goes on with a conversation, such as one a chat started
	- OAuth discovery (`WWW-Authenticate` with resource metadata): the deployment's sign-in fronts the server, such as Cloudflare Access
	- a tool description that says the agent asks for approvals: a middleware does not say which tools it gates
