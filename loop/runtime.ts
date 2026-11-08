import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import {
  type Conversation,
  configure,
  createRegistry,
  type Extension,
  Harness,
  type Storage,
  type Submission,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { z } from "zod";
import {
  type Agent,
  type Caller,
  type Json,
  parseModel,
} from "../define/index.ts";
import { type AnyAgent, agentExtension, submitTool } from "./extension.ts";
import { createResources, type Provider } from "./resources.ts";
import { RunDoc, RunIndex, type RunState } from "./state.ts";
import { activeParent, createTracing } from "./trace.ts";
import { answerOf, messagesOf, resultOf } from "./transcript.ts";

/** The tokens and cost a run spent: per `provider/model-id` for model calls, and per tool for tools that report it. */
export type RunUsage = UsageState;

/** What a run gives back: the agent's output, checked against its schema, or its answer as text. */
export type RunResult<O> = O extends z.ZodObject ? z.infer<O> : string;

/** What a runtime needs: where it keeps its runs, the models it may call, and every agent it can run. */
export type RuntimeOptions = {
  /** pi's storage: `openNodeSqliteStorage(file)` to keep runs across restarts, `MemoryStorage` to keep none. */
  storage: Storage;
  /** The host's models, with its providers set. */
  models: Models;
  /** Every agent the host can run. A run that resumes after a restart finds its agent here, by name. */
  agents: readonly AnyAgent[];
  /**
   * The host's value of each resource the agents' tools use, per run: `provide(resource, (run) => value)`. A provider
   * resolves from the run as it was started, so a run that resumes after a restart gets the same one.
   */
  resources?: readonly Provider[];
  /**
   * Record message content in the trace: instructions, tool definitions, messages, tool arguments and results. Off by
   * default, as the GenAI conventions say: content can hold sensitive data.
   */
  captureContent?: boolean;
};

/** What a run needs besides the agent and its input. */
export type RunOptions<C extends Json | undefined> = {
  /**
   * The host's id for the run. A run started again with the same id is the same run: it goes on from where it is, or
   * gives back its result, and its input, caller, model and context are the ones it was started with.
   */
  runId: string;
  /** Who the run acts for. */
  caller: Caller;
  /** The model to run on, "provider:model-id", in place of the agent's: such as a fallback for a retry. */
  model?: string;
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

/** A host's agents on one pi harness: open once per process, run any number of runs, close at the end. */
export type Runtime = {
  /** Run one agent on one input to its result, or go on with the run of this `runId`. */
  run<O extends z.ZodObject | undefined, C extends Json | undefined>(
    agent: Agent<O, C>,
    input: string,
    options: RunOptions<C>,
  ): Promise<RunResult<O>>;
  /** Close the harness. A run still going is kept, and goes on when a runtime opens on the same storage. */
  close(): Promise<void>;
};

const context = BACKGROUND_CONTEXT;

/**
 * Open a runtime: one pi harness on `storage`, with each agent installed as its own extension. Runs a crash left
 * unfinished go on at once.
 */
export async function openRuntime({
  storage,
  models,
  agents,
  resources: providers = [],
  captureContent = false,
}: RuntimeOptions): Promise<Runtime> {
  const resources = createResources(providers);
  resources.check(
    agents.flatMap((agent) =>
      agent.tools.flatMap((tool) =>
        (tool.uses ?? []).map((resource) => ({ tool: tool.name, resource })),
      ),
    ),
  );
  const installed = new Map<
    string,
    { agent: AnyAgent; extension: Extension }
  >();
  for (const agent of agents) {
    if (installed.has(agent.name))
      throw new Error(`two agents are named "${agent.name}"`);
    installed.set(agent.name, {
      agent,
      extension: agentExtension(agent, resources),
    });
  }
  const tracing = createTracing({
    agents: new Map([...installed].map(([name, { agent }]) => [name, agent])),
    captureContent,
  });
  const registry = createRegistry();
  for (const { extension } of installed.values()) registry.install(extension);
  registry.install(tracing.extension);
  const harness = await Harness.open(storage, { models, registry }, context);
  tracing.bind(harness);
  harness.resume();

  /**
   * The run's conversation: made with its agent, its model and its run document in one commit, or the one this run id
   * already has, which keeps what it was started with.
   */
  async function conversationOf(
    agent: AnyAgent,
    extension: Extension,
    start: RunState,
  ) {
    const { runId } = start;
    const id = await harness.commit(async (tx) => {
      const index = await tx.doc(RunIndex, runId, null);
      if (index.conversationId !== null) {
        const kept = await tx.doc(RunDoc, index.conversationId);
        if (kept.agent !== agent.name) {
          throw new Error(
            `run "${runId}" is of agent "${kept.agent}", not "${agent.name}"`,
          );
        }
        return index.conversationId;
      }
      const { id } = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, id, {
        model: parseModel(start.model),
        instructions: agent.instructions,
        extensions: [extension, tracing.extension],
      });
      Object.assign(await tx.doc(RunDoc, id), start);
      index.conversationId = id;
      tracing.start(id);
      return id;
    }, context);
    const conversation = await harness.conversation(id, context);
    if (!conversation)
      throw new Error(`run "${runId}": its conversation is missing`);
    return conversation;
  }

  async function run<
    O extends z.ZodObject | undefined,
    C extends Json | undefined,
  >(
    agent: Agent<O, C>,
    input: string,
    options: RunOptions<C>,
  ): Promise<RunResult<O>> {
    const entry = installed.get(agent.name);
    if (entry?.agent !== agent) {
      throw new Error(
        `agent "${agent.name}" was not given when the runtime opened`,
      );
    }
    options.signal?.throwIfAborted();
    const { runId, caller, signal, onUsage, onMessages } = options;
    const model = options.model ?? agent.model;
    parseModel(model);
    const parent = activeParent();
    const conversation = await conversationOf(agent, entry.extension, {
      runId,
      agent: agent.name,
      model,
      caller,
      ...(options.context === undefined ? {} : { context: options.context }),
      ...(parent === undefined ? {} : { trace: parent }),
    });
    let messages: Message[] | undefined;
    const transcript = async () =>
      (messages ??= await messagesOf(conversation, context));
    try {
      // The same request id finds the run's input when it is in already: a run started again never runs twice.
      const submission = await conversation.submit(
        { type: "input", content: input, requestId: runId },
        context,
      );
      const settled = await waitFor(submission, conversation, signal);
      if (settled.status !== "done") {
        throw new Error(
          `agent "${agent.name}": the run ended with no answer (${settled.reason})`,
        );
      }
      if (!agent.output) return answerOf(await transcript()) as RunResult<O>;
      const result = resultOf(await transcript(), submitTool);
      if (!result)
        throw new Error(
          `agent "${agent.name}": the run ended with no ${submitTool}`,
        );
      return result.value as RunResult<O>;
    } finally {
      // The run's trace ends before run() does, so a host's span around it holds the whole run.
      await tracing.ended(conversation.id);
      onUsage?.(
        (await harness.snapshot(UsageDoc, conversation.id, context)) ?? {
          models: {},
          tools: {},
        },
      );
      onMessages?.(await transcript());
      resources.forget(runId);
    }
  }

  return {
    run,
    async close() {
      await tracing.closeAll();
      await harness.close(context);
      resources.clear();
    },
  };
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
  if (!signal) return submission.wait(context);
  try {
    return await submission.wait(withAbortSignal(signal, context));
  } catch (error) {
    if (!signal.aborted) throw error;
    await conversation.abort(context);
    throw signal.reason;
  }
}
