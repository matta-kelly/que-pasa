/** The person or program a run acts for. Every run carries one: no tool or agent passes it on. */
export type Caller = { id: string };

/** A run as it was started, read from its run document: what a resource and a middleware's `beforeAgent` get. */
export type RunOf = {
  runId: string;
  caller: Caller;
  /** Absent when the run was given none. */
  context?: Json;
};

import type { Resource } from "./resource.ts";

/** A JSON value: what a run keeps in storage, so it survives a restart. */
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What a tool gets from its run, besides its input: the caller, the context the run was given (LangChain's runtime
 * context), and the resources the host provides for the run. The context is JSON, because the run keeps it, and a run
 * that resumes after a restart gives its tools the same one, so they get the same resources.
 */
export type Runtime<C extends Json | undefined = undefined> = {
  caller: Caller;
  context: C;
  /** The run's value of a resource the tool declares in `uses`. Any other resource throws. */
  use<T>(resource: Resource<T>): Promise<T>;
};
