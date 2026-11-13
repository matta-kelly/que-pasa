import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import {
  type Conversation,
  ConversationBusy,
  configure,
  createRegistry,
  type Extension,
  Harness,
  type Storage,
  type Submission,
  type SubmissionId,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { z } from "zod";
import {
  type Agent,
  type Caller,
  type Connection,
  isConnection,
  type Json,
  parseModel,
} from "../define/index.ts";
import { ConnectionsMissing, RunFailed, RunRefused } from "./errors.ts";
import { type AnyAgent, agentExtension, submitTool } from "./extension.ts";
import {
  createResources,
  type CredentialFor,
  type Provider,
} from "./resources.ts";
import {
  ConversationDoc,
  ConversationIndex,
  type ConversationState,
  MiddlewareDoc,
  RunDoc,
  type RunState,
} from "./state.ts";
import { activeParent, createTracing } from "./trace.ts";
import { answerText, messagesOf, outcomeOf } from "./transcript.ts";
import { usageOf } from "./usage.ts";

/** The tokens and cost a run spent: per `provider/model-id` for model calls, and per tool for tools that report it. */
export type RunUsage = UsageState;

/** What a run gives back: the agent's output, checked against its schema, or its answer as text. */
export type RunResult<O> = O extends z.ZodObject ? z.infer<O> : string;

/** What a runtime needs: where it keeps its conversations, the models it may call, and every agent it can run. */
export type RuntimeOptions = {
  /** pi's storage: `openNodeSqliteStorage(file)` to keep conversations across restarts, `MemoryStorage` to keep none. */
  storage: Storage;
  /** The host's models, with its providers set. */
  models: Models;
  /** Every agent the host can run. A run that resumes after a restart finds its agent here, by name. */
  agents: readonly AnyAgent[];
  /**
   * The host's value of each resource the agents' tools use, per conversation: `provide(resource, (conversation) =>
   * value)`. A provider resolves from the conversation as its first run made it, so every run on it, also one that
   * resumes after a restart, gets the same one.
   */
  resources?: readonly Provider[];
  /**
   * The deployment's logins, for the connections the agents' tools use: from its control plane, for a caller. Needed
   * when any tool uses a connection. que-pasa keeps none: a run asks at its start, and a tool's first use in a process.
   */
  credentialFor?: CredentialFor;
  /**
   * Record message content in the trace: instructions, tool definitions, messages, tool arguments and results. Off by
   * default, as the GenAI conventions say: content can hold sensitive data.
   */
  captureContent?: boolean;
};

/** What a run needs besides the agent and its input. */
export type RunOptions<C extends Json | undefined> = {
  /**
   * The host's key for the conversation the run is on: pi's conversation, which keeps its history across runs. Its
   * first run makes it, with the agent, the caller and the context; every run on it gives the same, or is refused.
   */
  conversation: string;
  /**
   * The run's id in its conversation: pi's request id of its input. A run started again with the same id is the same
   * run: it goes on from where it is, or gives back its result, on the model it was started with.
   */
  runId: string;
  /** Who the conversation acts for. */
  caller: Caller;
  /** The model to run on, "provider:model-id", in place of the agent's: such as a fallback for a retry. */
  model?: string;
  /** Stops the run: run() rejects with the signal's reason, and no tool or model call starts after it. */
  signal?: AbortSignal;
  /**
   * Called once the run is admitted, or found admitted already: after this, run() gives its result or `RunFailed`,
   * never `RunRefused`. A host that answers a caller before the result, such as the server, waits for it.
   */
  onStarted?: () => void;
  /** Called once when the run ends, answered or not, with what it spent. */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Called once when the run ends, answered or not, with its conversation in order, as pi-ai's messages: every run's
   * input, each assistant message with its tool calls, each tool result, and the reminders sent, up to this run's end.
   * The system prompt is not in it.
   */
  onMessages?: (messages: Message[]) => void;
} & (undefined extends C ? { context?: C } : { context: C });

/** A host's agents on one pi harness: open once per process, run any number of runs, close at the end. */
export type Runtime = {
  /**
   * Run one input on a conversation to its result, or go on with the run of this `runId`. A conversation takes one run
   * at a time: a run while another goes on is refused.
   */
  run<O extends z.ZodObject | undefined, C extends Json | undefined>(
    agent: Agent<O, C>,
    input: string,
    options: RunOptions<C>,
  ): Promise<RunResult<O>>;
  /** Close the harness. A run still going is kept, and goes on when a runtime opens on the same storage. */
  close(): Promise<void>;
};

const context = BACKGROUND_CONTEXT;

/** What a run gives its conversation: what the conversation's first run makes it with, and every run gives again. */
type Made = Omit<ConversationState, "runs">;

/**
 * Open a runtime: one pi harness on `storage`, with each agent installed as its own extension. Runs a crash left
 * unfinished go on at once.
 */
export async function openRuntime({
  storage,
  models,
  agents,
  resources: providers = [],
  credentialFor,
  captureContent = false,
}: RuntimeOptions): Promise<Runtime> {
  const resources = createResources(providers, credentialFor);
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

  /** Whether the run is admitted already: a run started again goes on, and is not gated again. */
  async function admitted(key: string, runId: string) {
    const made = await harness.snapshot(ConversationIndex, key, context);
    const id = made?.conversationId;
    if (id == null) return false;
    const had = await harness.commit(
      (tx) => tx.submissionByRequest(id, runId),
      context,
    );
    return had !== undefined;
  }

  /**
   * The credential gate, as LangChain's before the first model turn: a run whose caller has no login for a connection
   * its agent's tools use is refused before anything of it is kept.
   */
  async function gate(agent: AnyAgent, caller: Caller) {
    const missing = await resources.missing(caller, connectionsOf(agent));
    if (missing.length === 0) return;
    const names = missing.map((connection) => `"${connection.name}"`);
    throw new ConnectionsMissing(
      missing,
      `agent "${agent.name}": "${caller.id}" has no login for ${names.join(", ")}`,
    );
  }

  /**
   * The conversation of a key: made with its agent, its document and its middleware's state in one commit, or the one
   * the key already has, when it was made with the same agent, caller and context.
   */
  async function conversationOf(
    agent: AnyAgent,
    extension: Extension,
    given: Made,
  ) {
    const key = given.conversation;
    const made = await harness.snapshot(ConversationIndex, key, context);
    // Each middleware's beforeAgent runs once, for a conversation not made yet, outside the commit that keeps it.
    const states =
      made?.conversationId != null ? [] : await beforeAgent(agent, given);
    const id = await harness.commit(async (tx) => {
      const index = await tx.doc(ConversationIndex, key, null);
      if (index.conversationId !== null) {
        refuseOther(await tx.doc(ConversationDoc, index.conversationId), given);
        return index.conversationId;
      }
      const { id } = await tx.createConversation({
        ownership: { kind: "ownerless" },
      });
      await configure(tx, id, {
        model: parseModel(agent.model),
        instructions: agent.instructions,
        extensions: [extension, tracing.extension],
      });
      Object.assign(await tx.doc(ConversationDoc, id), given, { runs: [] });
      for (const { name, state } of states) {
        (await tx.doc(MiddlewareDoc, id, name, state)).state = state;
      }
      index.conversationId = id;
      return id;
    }, context);
    const conversation = await harness.conversation(id, context);
    if (!conversation)
      throw new Error(`conversation "${key}": it is missing from storage`);
    return conversation;
  }

  /**
   * The run's submission: the one its run id already has, or its input admitted now, with its model, its document and
   * its place in the conversation's runs, in one commit. A conversation whose run goes on refuses it.
   */
  async function admit(
    conversation: Conversation,
    key: string,
    runId: string,
    input: string,
    start: Omit<RunState, "spent">,
  ) {
    const { id } = conversation;
    const admitted = await harness.commit(async (tx) => {
      const had = await tx.submissionByRequest(id, runId);
      if (had) return had.id;
      let submission: SubmissionId;
      try {
        // Before any other write, as pi requires; a busy conversation throws here, having written nothing.
        submission = await conversation.submit(tx, {
          type: "input",
          content: input,
          requestId: runId,
          whenBusy: "reject",
        });
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
        const going = (await tx.doc(ConversationDoc, id)).runs.at(-1);
        throw new RunRefused(
          "busy",
          `conversation "${key}": run "${going}" goes on, so run "${runId}" is refused`,
          { cause: error },
        );
      }
      await configure(tx, id, { model: parseModel(start.model) });
      // What the conversation has spent so far, as plain JSON: the run's usage is what it spends after.
      const spent = JSON.parse(
        JSON.stringify(await tx.doc(UsageDoc, id)),
      ) as UsageState;
      Object.assign(await tx.doc(RunDoc, id, runId, null), start, { spent });
      (await tx.doc(ConversationDoc, id)).runs.push(runId);
      tracing.start(id, runId);
      return submission;
    }, context);
    const submission = await harness.submission(admitted, context);
    if (!submission)
      throw new Error(`run "${runId}": its submission is missing`);
    return submission;
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
    const {
      conversation: key,
      runId,
      caller,
      signal,
      onStarted,
      onUsage,
      onMessages,
    } = options;
    const model = options.model ?? agent.model;
    parseModel(model);
    if (!(await admitted(key, runId))) await gate(entry.agent, caller);
    const parent = activeParent();
    const conversation = await conversationOf(agent, entry.extension, {
      conversation: key,
      agent: agent.name,
      caller,
      ...(options.context === undefined ? {} : { context: options.context }),
    });
    const submission = await admit(conversation, key, runId, input, {
      model,
      ...(parent === undefined ? {} : { trace: parent }),
    });
    onStarted?.();
    try {
      const settled = await waitFor(submission, conversation, signal);
      if (settled.status !== "done") {
        throw new RunFailed(
          settled.reason,
          `agent "${agent.name}": the run ended with no answer (${settled.reason})`,
        );
      }
      const outcome = await outcomeOf(
        conversation,
        settled,
        submitTool,
        context,
      );
      if (!agent.output)
        return (
          outcome.answer ? answerText(outcome.answer) : ""
        ) as RunResult<O>;
      if (!outcome.submitted)
        throw new RunFailed(
          "no_submit",
          `agent "${agent.name}": the run ended with no ${submitTool}`,
        );
      return outcome.submitted.value as RunResult<O>;
    } finally {
      // The run's trace ends before run() does, so a host's span around it holds the whole run.
      await tracing.ended(conversation.id, runId);
      onUsage?.(await usageOf(harness, conversation.id, runId, context));
      onMessages?.(await messagesOf(conversation, context));
      resources.forget(key);
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

/** The connections the agent's tools use, each once, in the order its tools name them. */
function connectionsOf(agent: AnyAgent): Connection[] {
  const byName = new Map<string, Connection>();
  for (const tool of agent.tools) {
    for (const resource of tool.uses ?? []) {
      if (isConnection(resource)) byName.set(resource.name, resource);
    }
  }
  return [...byName.values()];
}

/** Refuse a run that gives a conversation another agent, caller or context than its first run made it with. */
function refuseOther(kept: ConversationState, given: Made) {
  const key = given.conversation;
  if (kept.agent !== given.agent) {
    throw new RunRefused(
      "other_agent",
      `conversation "${key}" is of agent "${kept.agent}", not "${given.agent}"`,
    );
  }
  if (kept.caller.id !== given.caller.id) {
    throw new RunRefused(
      "other_caller",
      `conversation "${key}" acts for "${kept.caller.id}", not "${given.caller.id}"`,
    );
  }
  if (!isDeepStrictEqual(kept.context, given.context)) {
    throw new RunRefused(
      "other_context",
      `conversation "${key}" was made with another context: its runs give the one it was made with`,
    );
  }
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

/** What each of the agent's middleware with a `beforeAgent` gives back for a conversation, as its first run makes it. */
async function beforeAgent(agent: AnyAgent, given: Made) {
  const { conversation, caller, context: kept } = given;
  const of = {
    conversation,
    caller,
    ...(kept === undefined ? {} : { context: kept }),
  };
  const states: { name: string; state: Json }[] = [];
  for (const middleware of agent.middleware ?? []) {
    if (!middleware.beforeAgent) continue;
    states.push({
      name: middleware.name,
      state: await middleware.beforeAgent(of),
    });
  }
  return states;
}
