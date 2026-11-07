/** The person or program a run acts for. Every run carries one: no tool or agent passes it on. */
export type Caller = { id: string };

/** A JSON value: what a run keeps in storage, so it survives a restart. */
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What a tool gets from its run, besides its input: the caller, and the context the run was given (LangChain's
 * runtime context). The context is the host's, per run, such as the sandbox an attempt's tools exec into. It is JSON,
 * because the run keeps it, and a run that resumes after a restart gives its tools the same one.
 */
export type Runtime<C extends Json | undefined = undefined> = {
  caller: Caller;
  context: C;
};
