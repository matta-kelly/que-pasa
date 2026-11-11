import type { Json, RunOf } from "./runtime.ts";

/**
 * An optional behaviour on an agent's loop, after LangChain's middleware: a name and hooks, each optional. S is the state
 * it keeps for a run, as JSON, so the run keeps it in storage and a run that resumes in a new process has the same.
 *
 * Its hooks are methods, so a middleware of any state goes in an agent's list of `Middleware`.
 *
 * Built: the two hooks memory needs. LangChain's others (`before_model`, `after_model`, `wrap_tool_call`, `after_agent`)
 * are not built yet.
 */
export type Middleware<S extends Json = Json> = {
  /** kebab-case, and one per agent: the key of the state it keeps. */
  readonly name: string;
  /**
   * LangChain's `before_agent`: once, when the run is made, before its first model call. What it gives back is the
   * middleware's state for the run, kept in the commit that makes the run. A throw fails the run, and nothing is kept.
   */
  beforeAgent?(run: RunOf): S | Promise<S>;
  /**
   * What it adds to the system prompt, from its state, as LangChain's `wrap_model_call` does when it appends to the
   * system message: before each model request. Its state is null when it has no `beforeAgent`, or the run was made
   * before the agent had it. Undefined adds nothing.
   */
  systemPrompt?(state: S | null): string | undefined;
};

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
