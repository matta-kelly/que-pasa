import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool as definePiTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Agent, Caller, Runtime, Tool } from "../define/index.ts";

/** What a run needs besides the agent and its input: who it acts for, and the models it may call. */
export type RunOptions = {
  caller: Caller;
  /** The host's models, with its providers set. */
  models: Models;
};

/** What a run gives back: the agent's output, checked against its schema, or its answer as text. */
export type RunResult<O> = O extends z.ZodObject ? z.infer<O> : string;

/** The tool an agent with an output calls to give its result. No agent tool may take its name. */
export const submitTool = "submit";

/** How many times a run reminds an agent with an output that it has not called submit, before it fails. */
const reminders = 2;

/** Run one agent on one input, for one caller, to its result. */
export async function run<O extends z.ZodObject | undefined>(
  agent: Agent<O>,
  input: string,
  options: RunOptions,
): Promise<RunResult<O>> {
  const { output } = agent;
  if (output && agent.tools.some((tool) => tool.name === submitTool)) {
    throw new Error(
      `agent "${agent.name}": a tool is named "${submitTool}", which its output needs`,
    );
  }
  const runtime: Runtime = { context: { caller: options.caller } };
  let submitted: { value: unknown } | undefined;
  let reminded = 0;

  const tools = agent.tools.map((tool) => toPiTool(tool, runtime));
  if (output) {
    tools.push(
      definePiTool({
        name: submitTool,
        description: "Give your final result. Call it once, when you are done.",
        parameters: jsonSchema(output),
        execute: async (args) => {
          // A result that fails the schema throws, and the model gets the error to try again.
          submitted = { value: output.parse(args) };
          return {
            output: [{ type: "text", text: "Result received." }],
            control: { terminate: true },
          };
        },
      }),
    );
  }

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: `agent-${agent.name}`,
      tools,
      hooks: output
        ? [
            hook(GenerationTask, {
              onYield: () => {
                if (submitted || reminded >= reminders) return undefined;
                reminded += 1;
                return {
                  continue: `You have not given your result. Call ${submitTool} with it.`,
                };
              },
            }),
          ]
        : [],
    }),
  );

  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: options.models, registry },
    context,
  );
  try {
    const root = await harness.root(context, {
      agent: { model: modelRef(agent.model), instructions: agent.instructions },
    });
    const submission = await root.submit(
      { type: "input", content: input },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.answer === undefined) {
      throw new Error(
        `agent "${agent.name}": the run ended with no answer (${settled.reason ?? settled.status})`,
      );
    }
    if (output) {
      if (!submitted)
        throw new Error(
          `agent "${agent.name}": the run ended with no ${submitTool}`,
        );
      return submitted.value as RunResult<O>;
    }
    const range = { minEntryId: settled.answer, maxEntryId: settled.answer };
    const { items } = await root.entries(range, 1, undefined, context);
    return text(items[0]?.model) as RunResult<O>;
  } finally {
    await harness.close(context);
  }
}

/** A que-pasa tool as a pi tool: pi checks the arguments against the JSON Schema, zod parses them, and the run's runtime goes in. */
function toPiTool(tool: Tool, runtime: Runtime) {
  return definePiTool({
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema(tool.schema),
    execute: async (args) => {
      const result = await tool.run(tool.schema.parse(args), runtime);
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

/** The JSON Schema of a zod object, without the `$schema` key a tool's parameters do not take. */
function jsonSchema(schema: z.ZodObject): object {
  const json: Record<string, unknown> = z.toJSONSchema(schema);
  delete json["$schema"];
  return json;
}

/** "provider:model-id" as pi's model reference. defineAgent has checked the shape. */
function modelRef(model: string) {
  const at = model.indexOf(":");
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

type Message = { role: string; content?: unknown };

/** The text of an answer's assistant message. */
function text(messages: readonly Message[] | undefined): string {
  const content = messages?.find(
    (message) => message.role === "assistant",
  )?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        block?.type === "text",
    )
    .map((block) => block.text)
    .join("");
}
