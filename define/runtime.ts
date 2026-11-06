/** The person or program a run acts for. Every run carries one: no tool or agent passes it on. */
export type Caller = { id: string };

/**
 * What a tool gets from its run, besides its input: the caller, and the context the run was given (LangChain's
 * runtime context). The context is the host's, per run, such as the sandbox an attempt's tools exec into.
 */
export type Runtime<C = unknown> = { caller: Caller; context: C };
