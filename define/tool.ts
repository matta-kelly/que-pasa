import type { z } from "zod";
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
  /** The name of the connection it reads at call time. The tool never holds the credential. */
  connection?: string;
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
  if (tool.connection !== undefined && tool.connection.trim() === "") {
    throw new Error(`tool "${tool.name}": the connection name is empty`);
  }
  return Object.freeze({ ...tool });
}
