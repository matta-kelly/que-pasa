import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  type Submission,
  createRegistry,
  defineExtension,
  defineTool as definePiTool,
  GenerationTask,
  Harness,
  hook,
  MemoryStorage,
  type UsageState,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Agent, Caller, Runtime, Tool } from "../define/index.ts";

/** The tokens and cost a run spent: per `provider/model-id` for model calls, and per tool for tools that report it. */
export type RunUsage = UsageState;

/** What a run needs besides the agent and its input. */
export type RunOptions<C = unknown> = {
  /** Who the run acts for. */
  caller: Caller;
  /** The host's models, with its providers set. */
  models: Models;
  /** Stops the run: run() rejects with the signal's reason, and no tool or model call starts after it. */
  signal?: AbortSignal;
  /** Called once when the run ends, answered or not, with what it spent. */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Called once when the run ends, answered or not, with its whole conversation in order, as pi-ai's messages: the
   * input, each assistant message with its tool calls, each tool result, and the reminders the run sent. The system
   * prompt is the agent's instructions, and is not in it.
   */
  onMessages?: (messages: Message[]) => void;
} & (undefined extends C ? { context?: C } : { context: C });

/** What a run gives back: the agent's output, checked against its schema, or its answer as text. */
export type RunResult<O> = O extends z.ZodObject ? z.infer<O> : string;

/** The tool an agent with an output calls to give its result. No agent tool may take its name. */
export const submitTool = "submit";

/** How many times a run reminds an agent with an output that it has not called submit, before it fails. */
const reminders = 2;

/** Run one agent on one input, for one caller, to its result. */
export async function run<O extends z.ZodObject | undefined, C = unknown>(
  agent: Agent<O, C>,
  input: string,
  options: RunOptions<C>,
): Promise<RunResult<O>> {
  const { output } = agent;
  if (output && agent.tools.some((tool) => tool.name === submitTool)) {
    throw new Error(
      `agent "${agent.name}": a tool is named "${submitTool}", which its output needs`,
    );
  }
  options.signal?.throwIfAborted();
  const runtime: Runtime<C> = {
    caller: options.caller,
    context: options.context as C,
  };
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
  let root: Conversation | undefined;
  try {
    root = await harness.root(context, {
      agent: { model: modelRef(agent.model), instructions: agent.instructions },
    });
    const submission = await root.submit(
      { type: "input", content: input },
      context,
    );
    const settled = await waitFor(submission, root, options.signal);
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
    if (options.onUsage) options.onUsage(await harness.usage(context));
    if (options.onMessages && root)
      options.onMessages(await conversation(root));
    await harness.close(context);
  }
}

/** The conversation's messages, oldest first, without the system entries: every page of its entries. */
async function conversation(root: Conversation): Promise<Message[]> {
  const messages: Message[] = [];
  let cursor: Parameters<Conversation["entries"]>[2];
  do {
    const page = await root.entries(
      { order: "ascending" },
      100,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "system") messages.push(message);
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return messages;
}

/**
 * Wait for the run to settle. On abort, pi cancels only the wait and never the work, so the conversation is aborted
 * too: its tasks stop, and the run rejects with the signal's reason.
 */
async function waitFor(
  submission: Submission,
  conversation: Conversation,
  signal: AbortSignal | undefined,
) {
  if (!signal) return submission.wait(BACKGROUND_CONTEXT);
  try {
    return await submission.wait(withAbortSignal(signal, BACKGROUND_CONTEXT));
  } catch (error) {
    if (!signal.aborted) throw error;
    await conversation.abort(BACKGROUND_CONTEXT);
    throw signal.reason;
  }
}

/** A que-pasa tool as a pi tool: pi checks the arguments against the JSON Schema, zod parses them, and the run's runtime goes in. */
function toPiTool<C>(tool: Tool<z.ZodObject, C>, runtime: Runtime<C>) {
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

/**
 * The JSON Schema of what the model must give: the input shape, so a field with a default is not required. Without the
 * `$schema` key a tool's parameters do not take.
 */
function jsonSchema(schema: z.ZodObject): object {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete json["$schema"];
  return json;
}

/** "provider:model-id" as pi's model reference. defineAgent has checked the shape. */
function modelRef(model: string) {
  const at = model.indexOf(":");
  return { provider: model.slice(0, at), modelId: model.slice(at + 1) };
}

/** The text of an answer's assistant message. */
function text(messages: readonly Message[] | undefined): string {
  const answer = messages?.find((message) => message.role === "assistant");
  if (!answer) return "";
  return answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}
