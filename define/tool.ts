import type { z } from "zod";
import type { Resource } from "./resource.ts";
import type { Json, Runtime } from "./runtime.ts";

/** A function an agent can call: written once in a workspace, so any agent in it can be given it. */
export type Tool<
  S extends z.ZodObject = z.ZodObject,
  C extends Json | undefined = undefined,
> = {
  /** What the model calls it by: snake_case, at most 64 characters. */
  name: string;
  /** What it does and when to call it. The model reads it to choose. */
  description: string;
  /** The input the model must give. */
  schema: S;
  /** The resources it asks its run for, with `runtime.use`: a sandbox, a connection. It never holds one. */
  uses?: readonly Resource[];
  /**
   * "safe": a call a crash cut off runs again when the run resumes. Left out, it never runs twice: the model gets an
   * `interrupted` result and decides what to do. pi's own term.
   */
  replay?: "safe";
  run(input: z.infer<S>, runtime: Runtime<C>): unknown;
};

const toolName = /^[a-z][a-z0-9_]{0,63}$/;

/** A tool, checked: its name is one the model providers take, and it says what it does. */
export function defineTool<
  S extends z.ZodObject,
  C extends Json | undefined = undefined,
>(tool: Tool<S, C>): Tool<S, C> {
  if (!toolName.test(tool.name)) {
    throw new Error(
      `tool "${tool.name}": the name must be snake_case, at most 64 characters`,
    );
  }
  if (tool.description.trim() === "") {
    throw new Error(`tool "${tool.name}": the description is empty`);
  }
  const uses = tool.uses ?? [];
  const named = new Set(uses.map((resource) => resource.name));
  if (named.size !== uses.length) {
    throw new Error(`tool "${tool.name}": a resource is in uses twice`);
  }
  return Object.freeze({
    ...tool,
    ...(tool.uses ? { uses: Object.freeze([...tool.uses]) } : {}),
  });
}
