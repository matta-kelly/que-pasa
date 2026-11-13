import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool as definePiTool,
  type Extension,
  GenerationTask,
  hook,
  LiveDoc,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import {
  type Agent,
  type Connection,
  isConnection,
  type Json,
  type Middleware,
  type Runtime,
  type ServiceIdentity,
  type Tool,
} from "../define/index.ts";
import type { Resources } from "./resources.ts";
import { ConversationDoc, MiddlewareDoc, RunDoc } from "./state.ts";
import { hasResult, messagesOf, userText } from "./transcript.ts";

/** Any agent, as the runtime holds it. */
export type AnyAgent = Agent<z.ZodObject | undefined, Json | undefined>;

/** The tool an agent with an output calls to give its result. No agent tool may take its name. */
export const submitTool = "submit";

/** What a run says to an agent with an output that answered without calling submit. */
export const reminder = `You have not given your result. Call ${submitTool} with it.`;

/** How many reminders a run sends before it ends with no result. */
const reminders = 2;

/** The name of an agent's extension: stable, so a run that resumes after a restart finds the agent's code. */
export const extensionName = (agent: AnyAgent) => `agent-${agent.name}`;

/**
 * An agent as one pi extension: its tools, a system prompt section for each middleware that adds to it, and, for an
 * agent with an output, the submit tool and the reminder. It holds no conversation's state: each call reads its
 * conversation's documents and transcript, so it serves every conversation of the agent, also one that resumes in a new
 * process.
 */
export function agentExtension(
  agent: AnyAgent,
  resources: Resources,
): Extension {
  const { output } = agent;
  if (output && agent.tools.some((tool) => tool.name === submitTool)) {
    throw new Error(
      `agent "${agent.name}": a tool is named "${submitTool}", which its output needs`,
    );
  }
  const tools = agent.tools.map((tool) => toPiTool(tool, resources));
  if (output) tools.push(submit(output));
  return defineExtension({
    name: extensionName(agent),
    tools,
    sections: [
      ...(agent.middleware ?? []).flatMap((middleware) =>
        middleware.systemPrompt ? [sectionOf(middleware)] : [],
      ),
      ...(connectionsOf(agent).some((connection) => connection.whoami)
        ? [identitySection(agent)]
        : []),
    ],
    hooks: output ? [remind] : [],
  });
}

/** The connections the agent's tools use, each once, in the order its tools name them. */
export function connectionsOf(agent: AnyAgent): Connection[] {
  const byName = new Map<string, Connection>();
  for (const tool of agent.tools) {
    for (const resource of tool.uses ?? []) {
      if (isConnection(resource)) byName.set(resource.name, resource);
    }
  }
  return [...byName.values()];
}

/** The key of the section that says who the agent acts as in each service. */
export const identityKey = "connections";

/**
 * Who the agent acts for, and who it is logged in as in each of its connections, as the system prompt says it: a shared
 * login is said to be one, so "my" means the caller, never the shared account. Undefined when the run knows none.
 */
export function identityText(
  agent: AnyAgent,
  known: Known | undefined,
): string | undefined {
  if (!known) return undefined;
  const { caller, identities } = known;
  const lines = connectionsOf(agent).flatMap(({ name, owner }) => {
    const who = identities?.[name];
    if (!who) return [];
    const more = [`id ${who.id}`, ...(who.email ? [who.email] : [])];
    const whose =
      owner === "user"
        ? "the login of the person you act for"
        : "a shared login, not the person you act for";
    return [`- ${name}: ${who.name} (${more.join(", ")}): ${whose}`];
  });
  if (lines.length === 0) return undefined;
  const person = caller.name ? `${caller.name} (${caller.id})` : caller.id;
  return [
    `You act for ${person}.`,
    "In these services you are logged in as:",
    ...lines,
  ].join("\n");
}

/** What a run knows of who it acts for and as: its conversation's caller, and its connections' identities. */
type Known = {
  caller: { id: string; name?: string };
  identities: Readonly<Record<string, ServiceIdentity>> | undefined;
};

/** What the conversation's run going on, or its last, knows of who it acts for and as. */
export async function identitiesOf(
  reader: DocumentReader,
  id: ConversationId,
  context: Context,
): Promise<Known | undefined> {
  const kept = await reader.snapshot(ConversationDoc, id, context);
  const runId = kept?.runs.at(-1);
  if (!kept || runId === undefined) return undefined;
  const run = await reader.snapshot(RunDoc, id, runId, context);
  return { caller: kept.caller, identities: run?.identities };
}

/**
 * Who the agent acts as in each service, so "me" and "mine" resolve: rendered before each request from the run's
 * document, which its start wrote, never from a login.
 */
function identitySection(agent: AnyAgent): PromptSection {
  return {
    key: identityKey,
    tag: false,
    render: async (input, context) =>
      identityText(
        agent,
        await identitiesOf(input.read, input.conversationId, context),
      ),
  };
}

/** The key of a middleware's section of the system prompt. */
export const sectionKey = (middleware: Middleware) =>
  `middleware-${middleware.name}`;

/**
 * A middleware's section of the system prompt: rendered before each request from the state its conversation keeps,
 * never from memory, so a run that resumes renders the same. pi sends it again only when it changes.
 */
function sectionOf(middleware: Middleware): PromptSection {
  return {
    key: sectionKey(middleware),
    tag: false,
    render: async (input, context) => {
      const kept = await input.read.snapshot(
        MiddlewareDoc,
        input.conversationId,
        middleware.name,
        context,
      );
      return middleware.systemPrompt?.(kept?.state ?? null);
    },
  };
}

/** A que-pasa tool as a pi tool: pi checks the arguments against the JSON Schema, zod parses them, and the run's runtime goes in. */
function toPiTool(
  tool: Tool<z.ZodObject, Json | undefined>,
  resources: Resources,
) {
  return definePiTool({
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema(tool.schema),
    ...(tool.replay ? { replay: tool.replay } : {}),
    execute: async (args, api, context) => {
      const result = await tool.run(
        tool.schema.parse(args),
        await runtimeOf(tool, resources, api, context),
      );
      return {
        output: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result),
          },
        ],
      };
    },
  });
}

/** The submit tool: a result that fails the schema throws, and the model gets the error to try again. A good one is kept in the transcript, as the result's details, and ends the run. */
function submit(output: z.ZodObject) {
  return definePiTool({
    name: submitTool,
    description: "Give your final result. Call it once, when you are done.",
    parameters: jsonSchema(output),
    replay: "safe",
    execute: async (args) => ({
      output: [{ type: "text", text: "Result received." }],
      details: output.parse(args) as Json,
      control: { terminate: true },
    }),
  });
}

/**
 * Reminds an agent with an output that answered without submitting, at most `reminders` times per run, counted in the
 * run's own entries: from pi's first entry of the run, so an earlier run's submit or reminders do not count.
 */
const remind = hook(GenerationTask, {
  onYield: async (_answer, api, context) => {
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const messages = await messagesOf(api, context, live?.run?.first);
    if (hasResult(messages, submitTool)) return undefined;
    const sent = messages.filter(
      (message) => userText(message) === reminder,
    ).length;
    return sent < reminders ? { continue: reminder } : undefined;
  },
});

/** The runtime of the call, from its conversation's document: its caller, its context, and the resources the tool uses. */
async function runtimeOf(
  tool: Tool<z.ZodObject, Json | undefined>,
  resources: Resources,
  api: DocumentReader & { readonly conversationId: ConversationId },
  context: Context,
): Promise<Runtime<Json | undefined>> {
  const kept = await api.snapshot(ConversationDoc, api.conversationId, context);
  if (!kept) throw new Error("the conversation has no document");
  const { conversation, caller, context: given } = kept;
  const of = {
    conversation,
    caller,
    ...(given === undefined ? {} : { context: given }),
  };
  const uses = new Set((tool.uses ?? []).map((resource) => resource.name));
  return {
    caller,
    context: given,
    use: async (resource) => {
      if (!uses.has(resource.name)) {
        throw new Error(
          `tool "${tool.name}" uses resource "${resource.name}", which it does not declare in uses`,
        );
      }
      return resources.use(of, resource);
    },
  };
}

/**
 * The JSON Schema of what the model must give: the input shape, so a field with a default is not required. Without the
 * `$schema` key a tool's parameters do not take.
 */
export function jsonSchema(schema: z.ZodObject): object {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete json["$schema"];
  return json;
}
