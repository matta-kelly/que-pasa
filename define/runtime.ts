/** The person or program a run acts for. Every run carries one: no tool or agent passes it on. */
export type Caller = { id: string };

/** What a tool gets from its run, besides its input. The same shape for every agent. */
export type Runtime = { context: { caller: Caller } };
