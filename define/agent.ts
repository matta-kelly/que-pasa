import type { z } from "zod";
import type { Tool } from "./tool.ts";

/** One agent's picks from a workspace: the core every agent has. C is the context its runs are given, which its tools read. */
export type Agent<
  O extends z.ZodObject | undefined = z.ZodObject | undefined,
  C = unknown,
> = {
  /** kebab-case, as its file is named. */
  name: string;
  /** "provider:model-id". */
  model: string;
  /** What the agent is and how it works: the start of its system prompt. */
  instructions: string;
  /** Passed explicitly: the agent can call these and no others. */
  tools: readonly Tool<z.ZodObject, C>[];
  /** The shape of its result. Left out, the agent answers in chat text. */
  output?: O;
};

const agentName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const modelId = /^[^:\s]+:\S+$/;

/** An agent, checked: its name, its model id, its instructions, and tool names that do not repeat. */
export function defineAgent<
  O extends z.ZodObject | undefined = undefined,
  C = unknown,
>(agent: Agent<O, C>): Agent<O, C> {
  if (!agentName.test(agent.name)) {
    throw new Error(`agent "${agent.name}": the name must be kebab-case`);
  }
  if (!modelId.test(agent.model)) {
    throw new Error(
      `agent "${agent.name}": the model must be "provider:model-id", not "${agent.model}"`,
    );
  }
  if (agent.instructions.trim() === "") {
    throw new Error(`agent "${agent.name}": the instructions are empty`);
  }
  const seen = new Set<string>();
  for (const tool of agent.tools) {
    if (seen.has(tool.name)) {
      throw new Error(
        `agent "${agent.name}": two tools are named "${tool.name}"`,
      );
    }
    seen.add(tool.name);
  }
  return Object.freeze({ ...agent, tools: Object.freeze([...agent.tools]) });
}
