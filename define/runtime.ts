/** The person or program a conversation acts for. Every run gives one: no tool or agent passes it on. */
export type Caller = { id: string };

/**
 * A conversation as its first run made it, read from its document: what a resource and a middleware's `beforeAgent`
 * get. Every run on it gives the same caller and context.
 */
export type ConversationOf = {
  /** The host's key for the conversation. */
  conversation: string;
  caller: Caller;
  /** Absent when it was given none. */
  context?: Json;
};

import type { Resource } from "./resource.ts";

/** A JSON value: what a run keeps in storage, so it survives a restart. */
export type Json =
  string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * What a tool gets from its run, besides its input: the caller, the context its conversation was given (LangChain's
 * runtime context), and the resources the host provides for the conversation. The context is JSON, because the
 * conversation keeps it, and a run that resumes after a restart gives its tools the same one, so they get the same
 * resources.
 */
export type Runtime<C extends Json | undefined = undefined> = {
  caller: Caller;
  context: C;
  /** The conversation's value of a resource the tool declares in `uses`. Any other resource throws. */
  use<T>(resource: Resource<T>): Promise<T>;
};
