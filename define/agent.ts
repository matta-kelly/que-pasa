import type { z } from "zod";
import type { Middleware } from "./middleware.ts";
import type { Json } from "./runtime.ts";
import type { Tool } from "./tool.ts";

/** One agent's picks from a workspace: the core every agent has. C is the context its conversations are given, which its tools read. */
export type Agent<
  O extends z.ZodObject | undefined = z.ZodObject | undefined,
  C extends Json | undefined = undefined,
> = {
  /** kebab-case, as its file is named. */
  name: string;
  /** What it does, for whoever picks it: a person in a list of agents, or a client that offers it as a tool. */
  description?: string;
  /** "provider:model-id". */
  model: string;
  /** What the agent is and how it works: its system prompt, after its middleware's sections. */
  instructions: string;
  /** Passed explicitly: the agent can call these and no others. */
  tools: readonly Tool<z.ZodObject, C>[];
  /** The shape of its result. Left out, the agent answers in chat text. */
  output?: O;
  /** Optional behaviours on its loop, in order: such as `memory`. */
  middleware?: readonly Middleware[];
};

const agentName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const modelId = /^[^:\s]+:\S+$/;

/** A model id, "provider:model-id", as its provider and its id: throws on any other shape. */
export function parseModel(model: string): {
  provider: string;
  modelId: string;
} {
  if (!modelId.test(model))
    throw new Error(`the model must be "provider:model-id", not "${model}"`);
  const at = model.indexOf(":");
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

/** An agent, checked: its name, its model id, its instructions, and tool and middleware names that do not repeat. */
export function defineAgent<
  O extends z.ZodObject | undefined = undefined,
  C extends Json | undefined = undefined,
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
  if (agent.description?.trim() === "") {
    throw new Error(`agent "${agent.name}": the description is empty`);
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
  const named = new Set<string>();
  for (const middleware of agent.middleware ?? []) {
    if (named.has(middleware.name)) {
      throw new Error(
        `agent "${agent.name}": two middleware are named "${middleware.name}"`,
      );
    }
    named.add(middleware.name);
  }
  return Object.freeze({
    ...agent,
    tools: Object.freeze([...agent.tools]),
    ...(agent.middleware
      ? { middleware: Object.freeze([...agent.middleware]) }
      : {}),
  });
}
