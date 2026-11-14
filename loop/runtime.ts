import {
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
  withCancel,
} from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import {
  AgentDoc,
  type Conversation,
  ConversationBusy,
  type ConversationId,
  configure,
  createRegistry,
  type Extension,
  Harness,
  LiveDoc,
  type LiveState,
  type SettledSubmissionRecord,
  type DocumentReader,
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
  type ConversationOf,
  type Interrupt,
  type Json,
  parseModel,
  type ServiceIdentity,
} from "../define/index.ts";
import { identityOf, until } from "./call.ts";
import { ConnectionsMissing, RunFailed, RunRefused } from "./errors.ts";
import {
  type AnyAgent,
  agentExtension,
  connectionsOf,
  submitTool,
  toolsOf,
} from "./extension.ts";
import {
  createResources,
  type CredentialFor,
  NoLogin,
  type Provider,
} from "./resources.ts";
import {
  type Asked,
  ConversationDoc,
  InterruptsDoc,
  ConversationIndex,
  type ConversationState,
  MiddlewareDoc,
  RunDoc,
  type RunState,
  runGoingOn,
} from "./state.ts";
import { activeParent, createTracing } from "./trace.ts";
import { answerText, messagesOf, outcomeOf } from "./transcript.ts";
import { usageOf } from "./usage.ts";

/** The tokens and cost a run spent: per `provider/model-id` for model calls, and per tool for tools that report it. */
export type RunUsage = UsageState;

/** What a run gives back: the agent's output, checked against its schema, or its answer as text. */
export type RunResult<O> = O extends z.ZodObject ? z.infer<O> : string;

/**
 * How a run stands when run() gives back, as LangGraph's `invoke`: done with its result, or interrupted, waiting on the
 * questions its tool calls asked. A run that failed throws `RunFailed`.
 */
export type RunOutcome<R> =
  | { status: "done"; result: R }
  | { status: "interrupted"; interrupts: Interrupt[] };

/**
 * What an input does when a run goes on on its conversation, pi's `whenBusy` and LangGraph's `multitask_strategy`:
 * `reject` refuses it, `followUp` queues it to start when the runs before it end (LangGraph's `enqueue`), and `steer`
 * joins it to the run going on, at that run's next step.
 */
export type WhenBusy = "reject" | "followUp" | "steer";

/**
 * Answers to an interrupted run's questions, by their ids, as LangGraph's `Command(resume)`: given in place of the input,
 * on the run's id. The run goes on from the calls that asked.
 */
export type Resume = { resume: Record<string, Json> };

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
  /**
   * Whether someone attends the run, to answer what it asks, such as a person in a chat: a tool call then asks and waits,
   * and run() gives back `interrupted`. Left out, nobody does: the run checks every login at its start, and fails with
   * the question when a call asks one. Its first start decides; the same run id again keeps it.
   */
  attended?: boolean;
  /** Stops the run: run() rejects with the signal's reason, and no tool or model call starts after it. */
  signal?: AbortSignal;
  /**
   * Called once the run is admitted, or found admitted already, and its answers kept: after this, run() gives its outcome
   * or `RunFailed`, never `RunRefused`. A host that answers a caller before the result, such as the server, waits for it.
   */
  onStarted?: () => void;
  /** Called once when the run ends, answered or not, with what it spent: not while it waits on a question. */
  onUsage?: (usage: RunUsage) => void;
  /**
   * Called once when the run ends, answered or not, with its conversation in order, as pi-ai's messages: every run's
   * input, each assistant message with its tool calls, each tool result, and the reminders sent, up to this run's end.
   * The system prompt is not in it.
   */
  onMessages?: (messages: Message[]) => void;
} & (undefined extends C ? { context?: C } : { context: C }) &
  (
    | {
        /**
         * What the run does when another goes on on its conversation, pi's `whenBusy`: `reject`, the default, refuses
         * it (`busy`); `followUp` queues it, to start when the runs before it end; `steer` joins it to the run going on,
         * at that run's next step, and gives back that run's outcome. On an idle conversation every run starts at once.
         */
        whenBusy?: "reject";
        /**
         * The model to run on, "provider:model-id", in place of the agent's: such as a fallback for a retry. Only for a
         * run that starts at once: one that waits or joins runs on the conversation's model when it starts.
         */
        model?: string;
      }
    | { whenBusy: Exclude<WhenBusy, "reject">; model?: never }
  );

/** A host's agents on one pi harness: open once per process, run any number of runs, close at the end. */
export type Runtime = {
  /**
   * Run one input on a conversation until it is done or waits on a question, or go on with the run of this `runId`, with
   * answers to its questions in place of the input. A conversation takes one run at a time: a run while another goes on,
   * or waits, is refused.
   */
  run<O extends z.ZodObject | undefined, C extends Json | undefined>(
    agent: Agent<O, C>,
    input: string | Resume,
    options: RunOptions<C>,
  ): Promise<RunOutcome<RunResult<O>>>;
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
      toolsOf(agent).flatMap((tool) =>
        (tool.uses ?? []).map((resource) => ({ tool: tool.name, resource })),
      ),
    ),
  );
  const byName = new Map<string, AnyAgent>();
  for (const agent of agents) {
    if (byName.has(agent.name))
      throw new Error(`two agents are named "${agent.name}"`);
    byName.set(agent.name, agent);
  }
  const tracing = createTracing({ agents: byName, captureContent });
  const installed = new Map<
    string,
    { agent: AnyAgent; extension: Extension }
  >();
  for (const agent of agents) {
    installed.set(agent.name, {
      agent,
      extension: agentExtension(agent, resources, tracing.toolEvent, started),
    });
  }
  const registry = createRegistry();
  for (const { extension } of installed.values()) registry.install(extension);
  registry.install(tracing.extension);
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      settings: {
        // One run per input: each follow-up its own run, with its own result, usage and trace.
        followUpMode: "one-at-a-time",
        // A failed run does not strand the follow-ups queued behind it.
        afterFailedRun: "continue",
      },
    },
    context,
  );
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
   * The start of a run's connections. A run nobody attends has the credential gate, as LangChain's before the first model
   * turn: it is refused before anything of it is kept when its caller has no login for a connection its agent's tools
   * use, as nobody could connect it later. A run someone attends starts without them: a tool call asks for its own.
   */
  async function gate(agent: AnyAgent, of: ConversationOf, attended: boolean) {
    const connections = connectionsOf(agent);
    if (!attended) {
      const missing = await resources.missing(of.caller, connections);
      if (missing.length > 0) {
        const names = missing.map((connection) => `"${connection.name}"`);
        throw new ConnectionsMissing(
          missing,
          `agent "${agent.name}": "${of.caller.id}" has no login for ${names.join(", ")}`,
        );
      }
    }
    // Who each connection with a login is logged in as, asked once: the run keeps it, and its system prompt says it.
    const identities: Record<string, ServiceIdentity> = {};
    for (const connection of connections) {
      if (!connection.whoami) continue;
      let who: ServiceIdentity;
      try {
        who = await connection.whoami(await resources.use(of, connection));
      } catch (error) {
        // Not connected yet: the call that needs it asks, and asks who it is once connected.
        if (error instanceof NoLogin) continue;
        // A run that started without it would read "my" wrong: it does not start.
        throw new RunRefused(
          "connection_failed",
          `connection "${connection.name}": who it is logged in as could not be read: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      identities[connection.name] = identityOf(who);
    }
    return identities;
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
   * The run's submission: the one its run id already has, or its input admitted now, with its document and its place in
   * the conversation's runs, in one commit. A run that starts at once sets the conversation's model; one that waits or
   * joins runs on the conversation's model, and its document says so. A busy conversation refuses a run that rejects.
   */
  async function admit(
    conversation: Conversation,
    key: string,
    runId: string,
    input: string,
    whenBusy: WhenBusy,
    start: Omit<RunState, "spent">,
  ) {
    const { id } = conversation;
    const admitted = await harness.commit(async (tx) => {
      const had = await tx.submissionByRequest(id, runId);
      if (had) return had.id;
      const busy = (await tx.doc(LiveDoc, id)).run !== undefined;
      let submission: SubmissionId;
      try {
        // Before any table write, as pi requires; a busy conversation that refuses throws here, having written nothing.
        submission = await conversation.submit(tx, {
          type: "input",
          content: input,
          requestId: runId,
          whenBusy,
        });
      } catch (error) {
        if (!(error instanceof ConversationBusy)) throw error;
        const kept = await tx.doc(ConversationDoc, id);
        const live = await tx.doc(LiveDoc, id);
        const going =
          kept.inputs?.[live.run?.inputs[0] ?? ""] ?? kept.runs.at(-1);
        throw new RunRefused(
          "busy",
          `conversation "${key}": run "${going}" goes on, so run "${runId}" is refused`,
          { cause: error },
        );
      }
      let model = start.model;
      if (busy) {
        const { model: on } = await tx.doc(AgentDoc, id);
        if (on) model = `${on.provider}:${on.modelId}`;
      } else {
        await configure(tx, id, { model: parseModel(model) });
      }
      Object.assign(await tx.doc(RunDoc, id, runId, null), start, { model });
      // So the questions its calls ask can be watched from its start. A run that starts at once starts with none: the
      // questions of the runs before it ended with them.
      const questions = await tx.doc(InterruptsDoc, id);
      if (!busy) questions.asked = {};
      const kept = await tx.doc(ConversationDoc, id);
      kept.runs.push(runId);
      kept.inputs = { ...kept.inputs, [submission]: runId };
      tracing.start(id, runId);
      return submission;
    }, context);
    const submission = await harness.submission(admitted, context);
    if (!submission)
      throw new Error(`run "${runId}": its submission is missing`);
    return submission;
  }

  /**
   * Keep what the conversation had spent when its run going on started, once, before that run's first model request: a
   * run's usage is what it spends after. A queued run is admitted while another goes on, so its admission is not its
   * start.
   */
  async function started(id: ConversationId, reader: DocumentReader) {
    const runId = await runGoingOn(reader, id, context);
    if (runId === undefined) return;
    if ((await reader.snapshot(RunDoc, id, runId, context))?.spent) return;
    await harness.commit(async (tx) => {
      const run = await tx.doc(RunDoc, id, runId, null);
      // As plain JSON: pi's usage is a document of its own.
      run.spent ??= JSON.parse(
        JSON.stringify(await tx.doc(UsageDoc, id)),
      ) as UsageState;
    }, context);
  }

  /**
   * Keep answers to the questions a run waits on, in one commit: the run must be in the run going on, alone or joined by
   * a steer, and each answer must name a question that waits. The calls that asked go on.
   */
  async function answer(
    conversation: Conversation,
    runId: string,
    answers: Record<string, Json>,
  ) {
    const { id } = conversation;
    await harness.commit(async (tx) => {
      const record = await tx.submissionByRequest(id, runId);
      const inRun =
        record !== undefined &&
        ((await tx.doc(LiveDoc, id)).run?.inputs ?? []).includes(record.id);
      const { asked } = await tx.doc(InterruptsDoc, id);
      for (const [question, given] of Object.entries(answers)) {
        const waiting = asked[question];
        if (!inRun || !waiting || Object.hasOwn(waiting, "answer")) {
          throw new RunRefused(
            "not_interrupted",
            `run "${runId}" does not wait on "${question}"`,
          );
        }
        waiting.answer = given;
        delete waiting.error;
      }
    }, context);
  }

  /**
   * The questions the run waits on, once it can go no further without answers: its input is in the run going on, that
   * run has a question waiting, and every call of its tool round that runs is waiting on one. Watched while it goes on.
   */
  async function pausedOf(
    id: ConversationId,
    submission: SubmissionId,
    following: Context,
  ): Promise<Interrupt[]> {
    const asked = await harness.watchDoc(InterruptsDoc, id, following);
    const live = await harness.watchDoc(LiveDoc, id, following);
    if (!asked || !live) throw new Error(`conversation ${id}: it is missing`);
    // Either change can pause it: a question asked, or a call that did not ask finishing. The watch that does not find
    // it ends with the follow.
    const check = () =>
      live.value.run?.inputs.includes(submission)
        ? paused(asked.value.asked, live.value)
        : undefined;
    const either = [until(asked, check), until(live, check)];
    for (const one of either) one.catch(() => {});
    return Promise.race(either);
  }

  async function run<
    O extends z.ZodObject | undefined,
    C extends Json | undefined,
  >(
    agent: Agent<O, C>,
    input: string | Resume,
    options: RunOptions<C>,
  ): Promise<RunOutcome<RunResult<O>>> {
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
    const known = await admitted(key, runId);
    if (typeof input !== "string" && !known) {
      throw new RunRefused(
        "not_interrupted",
        `run "${runId}" was never started, so it waits on nothing`,
      );
    }
    const attended = options.attended === true;
    const identities = known
      ? {}
      : await gate(
          entry.agent,
          {
            conversation: key,
            caller,
            ...(options.context === undefined
              ? {}
              : { context: options.context }),
          },
          attended,
        );
    const parent = activeParent();
    const conversation = await conversationOf(agent, entry.extension, {
      conversation: key,
      agent: agent.name,
      caller,
      ...(options.context === undefined ? {} : { context: options.context }),
    });
    const submission = await admit(
      conversation,
      key,
      runId,
      typeof input === "string" ? input : "",
      options.whenBusy ?? "reject",
      {
        model,
        ...(parent === undefined ? {} : { trace: parent }),
        ...(Object.keys(identities).length > 0 ? { identities } : {}),
        ...(attended ? { attended } : {}),
      },
    );
    if (typeof input !== "string")
      await answer(conversation, runId, input.resume);
    onStarted?.();
    // A run that waits on a question has not ended: what is given at its end waits for it.
    let waits = false;
    try {
      const followed = await follow(submission, conversation, signal);
      if (followed.interrupts) {
        waits = true;
        return { status: "interrupted", interrupts: followed.interrupts };
      }
      const { settled } = followed;
      if (settled.status !== "done") {
        // A run nobody attends stopped on its questions. A steer that joined it fails with pi's reason.
        const asked = await waitingOf(conversation.id, runId);
        if (asked.length > 0) throw unattended(agent.name, runId, asked);
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
        return {
          status: "done",
          result: (outcome.answer
            ? answerText(outcome.answer)
            : "") as RunResult<O>,
        };
      if (!outcome.submitted)
        throw new RunFailed(
          "no_submit",
          `agent "${agent.name}": the run ended with no ${submitTool}`,
        );
      return {
        status: "done",
        result: outcome.submitted.value as RunResult<O>,
      };
    } finally {
      if (!waits) await ended(conversation, runId, key, onUsage, onMessages);
    }
  }

  /** What is given when a run ends: its trace ends, its usage and messages go to the host, its resources go. */
  async function ended(
    conversation: Conversation,
    runId: string,
    key: string,
    onUsage: ((usage: RunUsage) => void) | undefined,
    onMessages: ((messages: Message[]) => void) | undefined,
  ) {
    // The run's trace ends before run() does, so a host's span around it holds the whole run.
    await tracing.ended(conversation.id, runId);
    onUsage?.(await usageOf(harness, conversation.id, runId, context));
    onMessages?.(await messagesOf(conversation, context));
    resources.forget(key);
  }

  /**
   * Follow a run until it settles, or waits on questions someone can answer. On abort, pi cancels only the wait and
   * never the work, so the conversation is aborted too: its tasks stop, and the run rejects with the signal's reason.
   */
  async function follow(
    submission: Submission,
    conversation: Conversation,
    signal: AbortSignal | undefined,
  ): Promise<
    | { settled: SettledSubmissionRecord; interrupts?: never }
    | { interrupts: Interrupt[]; settled?: never }
  > {
    const { context: following, cancel } = withCancel(
      signal ? withAbortSignal(signal, context) : context,
    );
    try {
      const settled = submission.wait(following).then((record) => ({
        settled: record,
      }));
      const paused = pausedOf(conversation.id, submission.id, following).then(
        (interrupts) => ({ interrupts }),
      );
      // The one that loses is cancelled below; its rejection is not the run's.
      settled.catch(() => {});
      paused.catch(() => {});
      return await Promise.race([settled, paused]);
    } catch (error) {
      if (!signal?.aborted) throw error;
      await conversation.abort(context);
      throw signal.reason;
    } finally {
      cancel();
    }
  }

  /** The questions a run nobody attends stopped on. */
  async function waitingOf(id: ConversationId, runId: string) {
    const kept = await harness.snapshot(InterruptsDoc, id, context);
    return pending(
      kept?.asked ?? {},
      (question) => question.runId === runId && !question.attended,
    );
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

/** The questions of `asked` not answered yet that `of` keeps, as a run gives them back. */
function pending(
  asked: Readonly<Record<string, Asked>>,
  of: (asked: Asked) => boolean,
): Interrupt[] {
  return Object.entries(asked).flatMap(([id, question]) =>
    Object.hasOwn(question, "answer") || !of(question)
      ? []
      : [
          {
            id,
            value: question.value,
            ...(question.error === undefined ? {} : { error: question.error }),
          },
        ],
  );
}

/**
 * The questions the run going on waits on, when it can go no further: someone can answer them, its calls of this tool
 * round asked them, and every one of its calls that runs asked one.
 */
function paused(
  asked: Readonly<Record<string, Asked>>,
  live: Readonly<LiveState>,
): Interrupt[] | undefined {
  const round = live.tools ?? [];
  const calls = new Set(round.map((slot) => slot.callId));
  const waiting = pending(
    asked,
    (question) => question.attended === true && calls.has(question.callId),
  );
  if (waiting.length === 0) return undefined;
  const asking = new Set(waiting.map(({ id }) => asked[id]!.callId));
  const running = round.filter(
    (slot) => slot.status !== "done" && slot.taskId !== undefined,
  );
  return running.every((slot) => asking.has(slot.callId)) ? waiting : undefined;
}

/**
 * How a run nobody attends fails when a call asks: with its questions, and why, in words a person reads. A missing login
 * is `needs_connection`; anything else, such as an approval, is `needs_answer`.
 */
function unattended(agent: string, runId: string, asked: Interrupt[]) {
  const connections = asked.flatMap(({ value }) =>
    isConnectionQuestion(value) ? [value.name] : [],
  );
  const reason =
    connections.length === asked.length ? "needs_connection" : "needs_answer";
  const what = asked.map(({ value }) => describe(value)).join("; ");
  return new RunFailed(
    reason,
    `agent "${agent}": run "${runId}" has nobody to answer, and stopped before it acted: ${what}`,
    asked,
  );
}

/** A question in a few words, for a message. */
function describe(value: Json): string {
  if (isConnectionQuestion(value)) return `connect ${value.name}`;
  if (isApprovalQuestion(value)) return `approve ${value.name}`;
  return JSON.stringify(value);
}

function isConnectionQuestion(
  value: Json,
): value is { type: "connection"; name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value["type"] === "connection" &&
    typeof value["name"] === "string"
  );
}

function isApprovalQuestion(
  value: Json,
): value is { type: "tool_approval"; name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value["type"] === "tool_approval" &&
    typeof value["name"] === "string"
  );
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
