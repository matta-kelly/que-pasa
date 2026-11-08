import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  defineTool as definePiTool,
  type Extension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Agent, Json, Runtime, Tool } from "../define/index.ts";
import type { Resources } from "./resources.ts";
import { RunDoc } from "./state.ts";
import { messagesOf, resultOf, userText } from "./transcript.ts";

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
 * An agent as one pi extension: its tools, and, for an agent with an output, the submit tool and the reminder. It holds
 * no run's state: each call reads its run's document and transcript, so it serves every run of the agent, also one that
 * resumes in a new process.
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
    hooks: output ? [remind] : [],
  });
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

/** Reminds an agent with an output that answered without submitting, at most `reminders` times, counted in its transcript. */
const remind = hook(GenerationTask, {
  onYield: async (_answer, api, context) => {
    const messages = await messagesOf(api, context);
    if (resultOf(messages, submitTool)) return undefined;
    const sent = messages.filter(
      (message) => userText(message) === reminder,
    ).length;
    return sent < reminders ? { continue: reminder } : undefined;
  },
});

/** The runtime of the call's run, from its run document: its caller, its context, and the resources the tool uses. */
async function runtimeOf(
  tool: Tool<z.ZodObject, Json | undefined>,
  resources: Resources,
  api: DocumentReader & { readonly conversationId: ConversationId },
  context: Context,
): Promise<Runtime<Json | undefined>> {
  const run = await api.snapshot(RunDoc, api.conversationId, context);
  if (!run) throw new Error("the run has no run document");
  const uses = new Set((tool.uses ?? []).map((resource) => resource.name));
  return {
    caller: run.caller,
    context: run.context,
    use: async (resource) => {
      if (!uses.has(resource.name)) {
        throw new Error(
          `tool "${tool.name}" uses resource "${resource.name}", which it does not declare in uses`,
        );
      }
      return resources.use(run, resource);
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
