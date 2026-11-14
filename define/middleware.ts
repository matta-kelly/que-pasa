import type { z } from "zod";
import type { Caller, ConversationOf, Json } from "./runtime.ts";
import type { Tool } from "./tool.ts";

/**
 * An optional behaviour on an agent's loop, after LangChain's middleware: a name and hooks, each optional. S is the state
 * it keeps for a conversation, as JSON, so the conversation keeps it in storage and a run that resumes in a new process
 * has the same.
 *
 * Its hooks are methods, so a middleware of any state goes in an agent's list of `Middleware`.
 *
 * Built: `beforeAgent` and `systemPrompt`, which memory needs, `wrapToolCall`, which approvals need, and `tools`, which
 * skills need. LangChain's others (`before_model`, `after_model`, `after_agent`) are not built yet.
 */
export type Middleware<S extends Json = Json> = {
  /** kebab-case, and one per agent: the key of the state it keeps. */
  readonly name: string;
  /**
   * Tools it brings to the agent, as LangChain middleware's `tools`: after the agent's own. One whose name an agent tool
   * has already is left out, so the agent's own is the one the model calls.
   */
  readonly tools?: readonly Tool<z.ZodObject, Json | undefined>[];
  /**
   * LangChain's `before_agent`, run once per conversation, as Deep Agents' memory loads once per thread: when its first
   * run makes it, before any model call. What it gives back is the middleware's state for the conversation, kept in the
   * commit that makes it. A throw fails the run, and nothing is kept.
   */
  beforeAgent?(conversation: ConversationOf): S | Promise<S>;
  /**
   * What it adds to the system prompt, from its state, as LangChain's `wrap_model_call` does when it appends to the
   * system message: before each model request. Its state is null when it has no `beforeAgent`, or the conversation was
   * made before the agent had it. Undefined adds nothing.
   */
  systemPrompt?(state: S | null): string | undefined;
  /**
   * LangChain's `wrap_tool_call`: around each call of the agent's tools, outermost first. It may ask a person with
   * `request.interrupt` before it calls `handler`, change the arguments it calls it with, or give a result of its own and
   * not call it. Its state is not passed: a call reads only what the request holds.
   */
  wrapToolCall?(
    request: ToolCallRequest,
    handler: ToolCallHandler,
  ): Promise<ToolMessage>;
};

/** One call of a tool, as a middleware's `wrapToolCall` gets it. */
export type ToolCallRequest = {
  /** The tool's name. */
  name: string;
  /** The arguments the model gave, checked against the tool's schema. */
  args: { [key: string]: Json };
  /** The call's id, the model's. */
  id: string;
  caller: Caller;
  /** The context its conversation was given; undefined when none. */
  context: Json | undefined;
  /**
   * LangGraph's `interrupt()`: ask a person, and resolve with their answer. The question and the answer are kept, so the
   * same call after a restart gets the same answer, and a person is never asked twice. Only before `handler` is called:
   * after the tool has started, a pause is refused. An answer that does not fit `answer` is refused, and asked again with
   * why. In a run nobody attends, the run fails with the question.
   */
  interrupt<A = Json>(value: Json, answer?: z.ZodType<A>): Promise<A>;
};

/** Run the tool: with the request's arguments, or with others, which the tool's schema checks. */
export type ToolCallHandler = (args?: {
  [key: string]: Json;
}) => Promise<ToolMessage>;

/** A call's result, as LangChain's `ToolMessage`: the text the model reads, and whether the call failed. */
export type ToolMessage = { content: string; status: "success" | "error" };

const middlewareName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A middleware, checked: its name is kebab-case. */
export function defineMiddleware<S extends Json>(
  middleware: Middleware<S>,
): Middleware<S> {
  if (!middlewareName.test(middleware.name)) {
    throw new Error(
      `middleware "${middleware.name}": the name must be kebab-case`,
    );
  }
  return Object.freeze({ ...middleware });
}
