import {
  BACKGROUND_CONTEXT,
  type Context,
  withAbortSignal,
  withCancel,
} from "@earendil-works/chord/context";
import type { Message, Models, UserMessage } from "@earendil-works/pi-ai";
import { isDeepStrictEqual } from "node:util";
import {
  AgentDoc,
  type Conversation,
  ConversationBusy,
  type ConversationId,
  type ConversationView as PiConversationView,
  configure,
  createRegistry,
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Extension,
  Harness,
  LiveDoc,
  type LiveState,
  type Page,
  type RunFailureReason,
  type SettledSubmissionRecord,
  StorageRequestError,
  type DocumentReader,
  InboxDoc,
  type Storage,
  type Submission,
  type SubmissionId,
  type SubmissionRecord,
  SystemEntry,
  UsageDoc,
  type UsageState,
  type WatchHandle,
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
import { fileKey, type FileStore, type StoredFile } from "../files/index.ts";
import { identityOf, until } from "./call.ts";
import { ConnectionsMissing, RunFailed, RunRefused } from "./errors.ts";
import {
  type AnyAgent,
  agentExtension,
  compacting,
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
  CallerIndex,
  ConversationDoc,
  InterruptsDoc,
  ConversationIndex,
  type ConversationState,
  MiddlewareDoc,
  NoteEntry,
  RunDoc,
  type RunState,
  runGoingOn,
} from "./state.ts";
import { activeParent, createTracing } from "./trace.ts";
import {
  answerText,
  entriesOf,
  lastMessageTime,
  messagesOf,
  outcomeOf,
  userInputText,
} from "./transcript.ts";
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

/**
 * How a conversation stands, LangGraph's thread status: `busy` while a run goes on, `interrupted` while it waits on
 * questions someone can answer, `error` when its newest run ended with no answer, `idle` otherwise.
 */
export type ConversationStatus = "idle" | "busy" | "interrupted" | "error";

/** A conversation as a client reads it, LangGraph's thread: what its first run made it with, and how it stands. */
export type ConversationInfo = {
  /** The host's key for it. */
  conversation: string;
  /** The agent it runs. */
  agent: string;
  /** Who it acts for. */
  caller: Caller;
  /** Absent when it was made with none. */
  context?: Json;
  /** What a client lists it by: its first input, cut short, or what a rename gave. */
  title: string;
  /** When it was made, ISO 8601. */
  createdAt: string;
  /** When its newest message was written, ISO 8601, from pi's message timestamps; `createdAt` while it has none. */
  lastMessageAt: string;
  status: ConversationStatus;
  /** The run going on, when it is `busy` or `interrupted`: answers to its questions go on it, as `{ resume }`. */
  runId?: string;
  /** The questions it waits on, when it is `interrupted`; none otherwise. */
  interrupts: Interrupt[];
  /** Why its newest run ended with no answer, when it is `error`: pi's `runFailure`. */
  runFailure?: { reason: RunFailureReason; detail?: string };
};

/**
 * How a run stands, in the words of a run's outcome: `pending` while queued behind another, `running`, `interrupted`
 * while it waits on questions, then `done`, `failed`, or `stopped` by a person.
 */
export type RunStatus =
  "pending" | "running" | "interrupted" | "done" | "failed" | "stopped";

/** A run as a client reads it, LangGraph's run: how it stands, and where its entries are in the conversation. */
export type RunInfo = {
  runId: string;
  status: RunStatus;
  /** Its input, while it is queued: pi's inbox keeps it until it is placed, and its entries hold it after. */
  input?: string;
  /** Why it failed, when `failed`: as `RunFailed` gives it. */
  failure?: { reason: string; message: string };
  /** The run it joined, for a steer: its entries are that run's. */
  joined?: string;
  /** The steers that joined it, each with its input's entry once placed. */
  steers: { runId: string; entry?: EntryId }[];
  /** What its calls asked, with the answers given: LangGraph's interrupts of a run, kept after it ends. */
  questions: Question[];
  /**
   * Its entries, inclusive: from its input's to the one before the next run's input, or open while it is the newest.
   * Absent before it starts, and for a steer.
   */
  entries?: { first: EntryId; last?: EntryId };
};

/**
 * A note as it stands: placed in the conversation, with its entry, or queued for the run going on to place at its next
 * step.
 */
export type NoteInfo = { noteId: string } & (
  { status: "placed"; entry: EntryId } | { status: "queued" }
);

/**
 * A compaction asked for: it goes on, the one asked for now or one already going, and its summary lands in the
 * conversation as pi's compaction entry.
 */
export type CompactInfo = { status: "compacting" };

/** A question a run's call asked, and its answer once given. */
export type Question = Interrupt & { answer?: Json };

/** Which of a conversation's runs to read: the newest first, a page at a time. */
export type RunsOptions = {
  /** At most this many; 20 when left out. */
  limit?: number;
  /** Where the page before ended: its `next`. */
  cursor?: Cursor;
};

/**
 * A conversation as it changes, after pi's `ConversationView`: how it stands, a window of its newest entries without
 * the system entries, and pi's live state, which holds the answer being written and the running tool calls.
 */
export type ConversationView = {
  info: ConversationInfo;
  /** A window of its newest entries, in order; `ConversationTranscript`'s rules apply, and `entries()` pages the rest. */
  entries: readonly EntryRecord[];
  /** The entry just before the window; absent when the window starts the transcript. */
  before?: EntryId;
  /** pi's `pi.live`: the run, the generation streaming its answer, the tool round. */
  live: LiveState;
};

/** Which of a caller's conversations to read, and from where: the newest first. */
export type ConversationsOptions = {
  /** Only the conversations of these agents. Left out, those of every agent. */
  agents?: readonly string[];
  /** At most this many; 20 when left out. */
  limit?: number;
  /** Where the page before ended: its `next`. */
  cursor?: Cursor;
};

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
  /**
   * Where the images the agents' tools make are kept: a bucket, `s3Files(...)`, or `folderFiles(...)`. A conversation
   * keeps only their links. Needed when a tool gives images; a call that gives some without it fails with why.
   */
  files?: FileStore;
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
  /**
   * Stops the run, as `stop` does: kept as `stopped`, with the runs it stops, then aborted, so no tool or model call
   * starts after it. run() rejects with the signal's reason.
   */
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
   * answers to its questions in place of the input. A run while another goes on, or waits, goes by its `whenBusy`.
   */
  run<O extends z.ZodObject | undefined, C extends Json | undefined>(
    agent: Agent<O, C>,
    input: string | Resume,
    options: RunOptions<C>,
  ): Promise<RunOutcome<RunResult<O>>>;
  /** The conversation of a host key, and how it stands; undefined when no run made it. */
  conversation(key: string): Promise<ConversationInfo | undefined>;
  /**
   * A page of a conversation's entries, pi's transcript records, as pi's `entries()` gives them (newest first unless
   * `query.order` is `ascending`), without its system entries; undefined when no run made it. `next` continues the scan
   * with the same query, and pi's `ConversationTranscript` pages it as it pages pi's own.
   */
  entries(
    key: string,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
  ): Promise<Page<EntryRecord, Cursor> | undefined>;
  /** A caller's conversations, the newest made first, a page at a time: `next` gives the page after. */
  conversations(
    caller: Caller,
    options?: ConversationsOptions,
  ): Promise<Page<ConversationInfo, Cursor>>;
  /** A conversation's runs, the newest admitted first, a page at a time; undefined when no run made it. */
  runs(
    key: string,
    options?: RunsOptions,
  ): Promise<Page<RunInfo, Cursor> | undefined>;
  /** One run of a conversation, and how it stands; undefined when it was never admitted. */
  runOf(key: string, runId: string): Promise<RunInfo | undefined>;
  /**
   * Change what a client lists a conversation by, as LangGraph's thread update: its title, 1 to 200 characters once
   * trimmed, or a `RangeError`. Gives the conversation as it now stands; undefined when no run made it.
   */
  update(
    key: string,
    change: { title: string },
  ): Promise<ConversationInfo | undefined>;
  /**
   * Put a message in a conversation for its runs to read, as a user message, without starting a run: OpenAI's message
   * added to a thread, apart from its run. On an idle conversation it is placed at once, and the next run reads it; while
   * a run goes on, or waits, it is placed at that run's next step, as a steer is, and that run reads it. Its `noteId` is
   * its key: the same note again is placed once. `text` is 1 character or more once trimmed, or a `RangeError`.
   * Undefined when no run made the conversation.
   */
  note(
    key: string,
    note: { noteId: string; text: string },
  ): Promise<NoteInfo | undefined>;
  /**
   * An image a tool of the conversation made, by its id, as its link gives it: its bytes, type and name. Undefined when
   * no run made the conversation, the id is not one a tool gave, or the runtime has no file store.
   */
  file(key: string, fileId: string): Promise<StoredFile | undefined>;
  /**
   * Compact a conversation now, pi's `compact()`: pi summarizes its older part and keeps its recent part, while the
   * conversation works. On an idle conversation the summary is placed when it is written; while a run goes on, at that
   * run's next step. `instructions` say what the summary keeps. While a compaction goes on, none more is started. Starts
   * no run. Undefined when no run made the conversation.
   */
  compact(
    key: string,
    options?: { instructions?: string },
  ): Promise<CompactInfo | undefined>;
  /**
   * Delete a conversation, as LangGraph's thread delete: the run going on is stopped first, with what is queued behind
   * it; then the conversation leaves its caller's list and its key, so every read of the key is undefined and a run on
   * it makes a new conversation. pi keeps no way to erase a conversation, so its history stays in storage, unread.
   * Undefined when no run made it.
   */
  delete(key: string): Promise<"deleted" | undefined>;
  /**
   * Stop a run, as a person asks it to. The run going on stops at once, with the steers that joined it and the runs
   * queued behind it, as pi's `abort()` does: nothing the person asked for goes on. A queued run alone is withdrawn,
   * and the rest go on. Kept before pi aborts it, so a crash between stops it too. A run that has ended stays as it
   * ended: `ended`. Undefined when it was never admitted.
   */
  stop(key: string, runId: string): Promise<"stopped" | "ended" | undefined>;
  /**
   * Watch a conversation as it changes, pi's `watch()`: its first value at once, then one after each change, the
   * newest only when the reader is slower. Ends with the signal, or when the runtime closes; undefined when no run made
   * it.
   */
  watch(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<ConversationView> | undefined>;
  /** Close the harness. A run still going is kept, and goes on when a runtime opens on the same storage. */
  close(): Promise<void>;
};

const context = BACKGROUND_CONTEXT;

/** What a run gives its conversation: what the conversation's first run makes it with, and every run gives again. */
type Made = Omit<ConversationState, "runs" | "title" | "createdAt">;

/** A file's id: a UUID, as a call gives it. */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most characters a title holds: a cut first input, or a rename. */
const titleMax = 200;

/** How many characters of the first input a title keeps, as a list shows it on one line. */
const titleCut = 80;

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
  files,
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
      extension: agentExtension(
        agent,
        resources,
        tracing.toolEvent,
        started,
        compactById,
        files,
      ),
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
   * the key already has, when it was made with the same agent, caller and context. A conversation made now is titled
   * by its first input.
   */
  async function conversationOf(
    agent: AnyAgent,
    extension: Extension,
    given: Made,
    input: string,
  ) {
    const key = given.conversation;
    // Read before the commit, which may run again.
    const createdAt = new Date().toISOString();
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
      Object.assign(await tx.doc(ConversationDoc, id), given, {
        title: titleOf(input),
        createdAt,
        runs: [],
      });
      // So the questions its runs' calls ask can be watched from its first run.
      await tx.doc(InterruptsDoc, id);
      (await tx.doc(CallerIndex, given.caller.id, null)).conversations.push({
        conversation: key,
        agent: given.agent,
      });
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
      const live = await tx.doc(LiveDoc, id);
      const busy = live.run !== undefined;
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
      if (!busy) {
        // A run that starts at once starts with no questions: those of the runs before it go to the runs that asked.
        const questions = await tx.doc(InterruptsDoc, id);
        for (const [question, asked] of Object.entries(questions.asked)) {
          const run = await tx.doc(RunDoc, id, asked.runId, null);
          run.asked = { ...run.asked, [question]: asked };
        }
        questions.asked = {};
      }
      const kept = await tx.doc(ConversationDoc, id);
      // A steer joins the run going on, read in this commit, so it is the run pi joins it to.
      const first = live.run?.inputs[0];
      const joined =
        whenBusy === "steer" && first !== undefined
          ? kept.inputs?.[first]
          : undefined;
      Object.assign(
        await tx.doc(RunDoc, id, runId, null),
        start,
        { model },
        joined === undefined ? {} : { joined },
      );
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
   * Before each model request of the run going on. Keep what the conversation had spent when it started, once, before
   * its first request: a run's usage is what it spends after; a queued run is admitted while another goes on, so its
   * admission is not its start. And stop it when a person stopped it: kept before pi aborts it, so a crash between
   * stops it here, at its next request.
   */
  async function started(id: ConversationId, reader: DocumentReader) {
    const runId = await runGoingOn(reader, id, context);
    if (runId === undefined) return;
    const run = await reader.snapshot(RunDoc, id, runId, context);
    if (run?.stopped) {
      // As the stop does: the conversation's abort, which withdraws the runs queued behind it too. Not awaited: it waits
      // for this very task to end, which waits on this hook.
      void harness
        .conversation(id, context)
        .then((conversation) => conversation?.abort(context));
      return;
    }
    if (run?.spent) return;
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
    const conversation = await conversationOf(
      agent,
      entry.extension,
      {
        conversation: key,
        agent: agent.name,
        caller,
        ...(options.context === undefined ? {} : { context: options.context }),
      },
      // A resume answers a run that made the conversation already.
      typeof input === "string" ? input : "",
    );
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
      const followed = await follow(
        submission,
        conversation,
        key,
        runId,
        signal,
      );
      if (followed.interrupts) {
        waits = true;
        return { status: "interrupted", interrupts: followed.interrupts };
      }
      return {
        status: "done",
        result: (await endOf(
          agent,
          conversation,
          runId,
          followed.settled,
        )) as RunResult<O>,
      };
    } finally {
      if (!waits) await ended(conversation, runId, key, onUsage, onMessages);
    }
  }

  /**
   * What a settled run gave: its result, its answer as text or its output, or `RunFailed` with why it has none. A run a
   * person stopped is `stopped`; a run nobody attends that stopped on its questions fails with them, as a steer that
   * joined it does.
   */
  async function endOf(
    agent: AnyAgent,
    conversation: Conversation,
    runId: string,
    settled: SettledSubmissionRecord,
  ): Promise<unknown> {
    if (settled.status !== "done") {
      const kept = await harness.snapshot(
        RunDoc,
        conversation.id,
        runId,
        context,
      );
      if (kept?.stopped) {
        throw new RunFailed(
          "stopped",
          `agent "${agent.name}": run "${runId}" was stopped`,
        );
      }
      const asked = await waitingOf(conversation.id, runId);
      if (asked.length > 0) throw unattended(agent.name, runId, asked);
      throw new RunFailed(
        settled.reason,
        `agent "${agent.name}": the run ended with no answer (${settled.reason})`,
      );
    }
    const outcome = await outcomeOf(conversation, settled, submitTool, context);
    if (!agent.output) return outcome.answer ? answerText(outcome.answer) : "";
    if (!outcome.submitted)
      throw new RunFailed(
        "no_submit",
        `agent "${agent.name}": the run ended with no ${submitTool}`,
      );
    return outcome.submitted.value;
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
   * never the work, so the run is stopped, as `stop` stops it: kept, then aborted. It rejects with the signal's reason.
   */
  async function follow(
    submission: Submission,
    conversation: Conversation,
    key: string,
    runId: string,
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
      await stop(key, runId);
      throw signal.reason;
    } finally {
      cancel();
    }
  }

  /** The questions a run nobody attends stopped on: asked by it, or by the run it joined as a steer. */
  async function waitingOf(id: ConversationId, runId: string) {
    const kept = await harness.snapshot(InterruptsDoc, id, context);
    return pending(
      kept?.asked ?? {},
      (question) => question.runs.includes(runId) && !question.attended,
    );
  }

  /** The conversation id of a host key, when a run made it. */
  async function idOf(key: string) {
    const made = await harness.snapshot(ConversationIndex, key, context);
    return made?.conversationId ?? undefined;
  }

  async function conversation(key: string) {
    const id = await idOf(key);
    return id === undefined ? undefined : infoOf(harness, id);
  }

  async function update(key: string, { title }: { title: string }) {
    const given = title.trim();
    if (given.length < 1 || given.length > titleMax)
      throw new RangeError(
        `a title is 1 to ${titleMax} characters once trimmed, not ${given.length}`,
      );
    const id = await idOf(key);
    if (id === undefined) return undefined;
    await harness.commit(async (tx) => {
      (await tx.doc(ConversationDoc, id)).title = given;
    }, context);
    return infoOf(harness, id);
  }

  async function note(
    key: string,
    { noteId, text }: { noteId: string; text: string },
  ): Promise<NoteInfo | undefined> {
    if (noteId === "") throw new RangeError("a note's id is empty");
    if (text.trim() === "")
      throw new RangeError("a note's text is 1 character or more once trimmed");
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const conversation = await harness.conversation(id, context);
    if (!conversation) throw new Error(`conversation "${key}": it is missing`);
    // Read outside the commit, which may run again: the note keeps the time it was sent.
    const timestamp = Date.now();
    const submission = await harness.commit(async (tx) => {
      const kept = await tx.doc(ConversationDoc, id);
      const had = kept.notes?.[noteId];
      if (had !== undefined) return had as SubmissionId;
      // pi's passive write: placed at once when idle, at the run's next step when busy; it starts no run.
      const written = await conversation.submit(tx, {
        type: "write",
        entry: {
          kind: NoteEntry.kind,
          data: { noteId },
          model: [{ role: "user", content: text, timestamp }],
        },
      });
      kept.notes = { ...kept.notes, [noteId]: written };
      return written;
    }, context);
    const record = await (
      await harness.submission(submission, context)
    )?.status(context);
    if (record?.type !== "write")
      throw new Error(`note "${noteId}": its submission is missing`);
    if (record.status === "queued") return { noteId, status: "queued" };
    if (record.status === "done")
      return { noteId, status: "placed", entry: record.entry };
    throw new Error(
      `note "${noteId}": pi could not place it: ${record.reason}`,
    );
  }

  async function file(key: string, fileId: string) {
    // An id is a UUID the call gave it, so a key never reaches outside the conversation's folder.
    if (!files || !uuid.test(fileId)) return undefined;
    const id = await idOf(key);
    if (id === undefined) return undefined;
    return files.get(fileKey(id, fileId));
  }

  async function compact(
    key: string,
    { instructions }: { instructions?: string } = {},
  ): Promise<CompactInfo | undefined> {
    const id = await idOf(key);
    if (id === undefined) return undefined;
    await compactById(id, instructions?.trim() || undefined, context);
    return { status: "compacting" };
  }

  /**
   * The compactions this process is starting, by conversation: one asked for while another starts waits for it, so
   * the check of pi's list and the start are one step.
   */
  const starting = new Map<ConversationId, Promise<boolean>>();

  /** Start pi's compaction of a conversation, unless one goes on: whether it started one. */
  function compactById(
    id: ConversationId,
    instructions: string | undefined,
    within: Context,
  ): Promise<boolean> {
    const before = starting.get(id) ?? Promise.resolve(false);
    const next = before
      .catch(() => false)
      .then(async () => {
        if (await compacting(harness, id, within)) return false;
        const conversation = await harness.conversation(id, within);
        if (!conversation)
          throw new Error(`conversation ${String(id)}: it is missing`);
        await conversation.compact(instructions, within);
        return true;
      });
    starting.set(id, next);
    void next.finally(() => {
      if (starting.get(id) === next) starting.delete(id);
    });
    return next;
  }

  async function entries(
    key: string,
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor?: Cursor,
  ) {
    checkLimit(limit);
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const kept = await harness.conversation(id, context);
    if (!kept)
      throw new Error(`conversation "${key}": it is missing from storage`);
    return entriesOf(kept, query, limit, cursor, context);
  }

  async function conversations(
    caller: Caller,
    { agents, limit = 20, cursor }: ConversationsOptions = {},
  ): Promise<Page<ConversationInfo, Cursor>> {
    checkLimit(limit);
    const made =
      (await harness.snapshot(CallerIndex, caller.id, context))
        ?.conversations ?? [];
    const of = ({ agent, deleted }: { agent: string; deleted?: true }) =>
      deleted === undefined && (agents === undefined || agents.includes(agent));
    // The list only grows, so a position in it is where a page ends: the newest first, from the end.
    let at = made.length;
    if (cursor !== undefined) {
      const { before } = cursor;
      if (
        typeof before !== "number" ||
        !Number.isSafeInteger(before) ||
        before < 0 ||
        before > made.length
      )
        throw new StorageRequestError("Invalid conversations cursor");
      at = before;
    }
    const items: ConversationInfo[] = [];
    while (at > 0 && items.length < limit) {
      const listed = made[--at]!;
      if (!of(listed)) continue;
      const id = await idOf(listed.conversation);
      if (id === undefined)
        throw new Error(
          `conversation "${listed.conversation}": it is missing from storage`,
        );
      items.push(await infoOf(harness, id));
    }
    return made.slice(0, at).some(of)
      ? { items, next: { before: at } }
      : { items };
  }

  /** Each run's submission, from the conversation's inputs. */
  function submissionsOf(kept: ConversationState) {
    const bySubmission = new Map<string, SubmissionId>();
    for (const [submission, runId] of Object.entries(kept.inputs ?? {}))
      bySubmission.set(runId, Number(submission) as SubmissionId);
    return bySubmission;
  }

  /**
   * A reader of a conversation's runs: each document read once, when a run first needs it, so a run reads only its own
   * and the runs after it, which may have joined it or end it.
   */
  async function runsOf(id: ConversationId) {
    const kept = await harness.snapshot(ConversationDoc, id, context);
    if (!kept) throw new Error(`conversation ${id}: its document is missing`);
    const conversation = await harness.conversation(id, context);
    if (!conversation) throw new Error(`conversation ${id}: it is missing`);
    const agent = byName.get(kept.agent);
    if (!agent)
      throw new Error(
        `agent "${kept.agent}" was not given when the runtime opened`,
      );
    const live = (await harness.snapshot(LiveDoc, id, context)) ?? {};
    const asked =
      (await harness.snapshot(InterruptsDoc, id, context))?.asked ?? {};
    const going = new Set(live.run?.inputs ?? []);
    const waiting = paused(asked, live) !== undefined;
    const submissions = submissionsOf(kept);
    const records = new Map<string, SubmissionRecord>();
    const docs = new Map<string, RunState | undefined>();

    async function recordOf(runId: string) {
      let record = records.get(runId);
      if (record) return record;
      const submission = submissions.get(runId);
      const handle =
        submission === undefined
          ? undefined
          : await harness.submission(submission, context);
      if (!handle) throw new Error(`run "${runId}": its submission is missing`);
      record = await handle.status(context);
      records.set(runId, record);
      return record;
    }

    async function docOf(runId: string) {
      if (!docs.has(runId))
        docs.set(runId, await harness.snapshot(RunDoc, id, runId, context));
      return docs.get(runId);
    }

    /** The input of a run queued behind another, from pi's inbox, which keeps it until it is placed. */
    async function queuedInput(submission: SubmissionId) {
      const inbox = await harness.snapshot(InboxDoc, id, context);
      const item = inbox?.items.find((each) => each.id === submission);
      if (item?.mode !== "steer" && item?.mode !== "followUp") return undefined;
      return userInputText(item.content as UserMessage["content"]);
    }

    async function infoAt(index: number): Promise<RunInfo> {
      const runId = kept!.runs[index]!;
      const record = await recordOf(runId);
      const doc = await docOf(runId);
      const later = kept!.runs.slice(index + 1);
      const steers: RunInfo["steers"] = [];
      let next: EntryId | undefined;
      for (const other of later) {
        const its = await docOf(other);
        if (its?.joined === runId) {
          const entry = (await recordOf(other)).entry;
          steers.push({
            runId: other,
            ...(entry === undefined ? {} : { entry }),
          });
        } else if (its?.joined === undefined && next === undefined) {
          next = (await recordOf(other)).entry;
        }
      }
      const placed =
        doc?.joined === undefined && record.entry !== undefined
          ? record.entry
          : undefined;
      const questions = Object.entries({
        ...doc?.asked,
        ...Object.fromEntries(
          Object.entries(asked).filter(([, each]) => each.runId === runId),
        ),
      }).map(([question, each]) => questionOf(question, each));
      const input =
        record.status === "queued" ? await queuedInput(record.id) : undefined;
      const info = {
        runId,
        ...(input === undefined ? {} : { input }),
        ...(doc?.joined === undefined ? {} : { joined: doc.joined }),
        steers,
        questions,
        ...(placed === undefined
          ? {}
          : {
              entries: {
                first: placed,
                ...(next === undefined || placed === undefined
                  ? {}
                  : { last: (next - 1) as EntryId }),
              },
            }),
      };
      if (isSettled(record)) {
        try {
          await endOf(agent!, conversation!, runId, record);
          return { ...info, status: "done" };
        } catch (error) {
          if (!(error instanceof RunFailed)) throw error;
          return error.reason === "stopped"
            ? { ...info, status: "stopped" }
            : {
                ...info,
                status: "failed",
                failure: { reason: error.reason, message: error.message },
              };
        }
      }
      if (!going.has(record.id)) return { ...info, status: "pending" };
      return { ...info, status: waiting ? "interrupted" : "running" };
    }

    return { runIds: kept.runs, infoAt };
  }

  async function runs(
    key: string,
    { limit = 20, cursor }: RunsOptions = {},
  ): Promise<Page<RunInfo, Cursor> | undefined> {
    checkLimit(limit);
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const { runIds, infoAt } = await runsOf(id);
    let at = runIds.length;
    if (cursor !== undefined) {
      const { before } = cursor;
      if (
        typeof before !== "number" ||
        !Number.isSafeInteger(before) ||
        before < 0 ||
        before > runIds.length
      )
        throw new StorageRequestError("Invalid runs cursor");
      at = before;
    }
    const items: RunInfo[] = [];
    while (at > 0 && items.length < limit) items.push(await infoAt(--at));
    return at > 0 ? { items, next: { before: at } } : { items };
  }

  async function runOf(key: string, runId: string) {
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const { runIds, infoAt } = await runsOf(id);
    const index = runIds.indexOf(runId);
    return index === -1 ? undefined : infoAt(index);
  }

  async function remove(key: string) {
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const going = await runGoingOn(harness, id, context);
    if (going !== undefined) await stop(key, going);
    await harness.commit(async (tx) => {
      const index = await tx.doc(ConversationIndex, key, null);
      // Deleted already, or made again since: what this delete found is gone.
      if (index.conversationId !== id) return;
      const { caller } = await tx.doc(ConversationDoc, id);
      const listed = await tx.doc(CallerIndex, caller.id, null);
      const at = listed.conversations.findLastIndex(
        (each) => each.conversation === key && each.deleted === undefined,
      );
      if (at !== -1)
        listed.conversations[at] = {
          ...listed.conversations[at]!,
          deleted: true,
        };
      index.conversationId = null;
    }, context);
    return "deleted" as const;
  }

  async function stop(key: string, runId: string) {
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const conversation = await harness.conversation(id, context);
    if (!conversation) throw new Error(`conversation "${key}": it is missing`);
    // Kept first, in one commit with what it reads: the run going on stops with every run not ended; a queued one alone.
    const found = await harness.commit(async (tx) => {
      const record = await tx.submissionByRequest(id, runId);
      if (!record) return undefined;
      if (isSettled(record)) return { ended: true as const };
      const going =
        (await tx.doc(LiveDoc, id)).run?.inputs.includes(record.id) ?? false;
      const stopping = [runId];
      if (going) {
        for (const other of (await tx.doc(ConversationDoc, id)).runs) {
          const its = await tx.submissionByRequest(id, other);
          if (other !== runId && its && !isSettled(its)) stopping.push(other);
        }
      }
      for (const each of stopping)
        (await tx.doc(RunDoc, id, each, null)).stopped = true;
      return { ended: false as const, going, submission: record.id };
    }, context);
    if (!found) return undefined;
    if (found.ended) return "ended" as const;
    if (found.going) {
      await conversation.abort(context);
    } else {
      const queued = await harness.submission(found.submission, context);
      // Placed since it was read: it is the run going on now, so it stops as one.
      if ((await queued?.abort(context)) === "already_placed")
        return stop(key, runId);
    }
    return "stopped" as const;
  }

  async function watch(
    key: string,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<AsyncIterable<ConversationView> | undefined> {
    const id = await idOf(key);
    if (id === undefined) return undefined;
    const conversation = await harness.conversation(id, context);
    if (!conversation) throw new Error(`conversation "${key}": it is missing`);
    const { context: watching, cancel } = withCancel(
      signal ? withAbortSignal(signal, context) : context,
    );
    const view = await conversation.watch(watching);
    const asked = await harness.watchDoc(InterruptsDoc, id, watching);
    if (!asked)
      throw new Error(`conversation "${key}": its questions are missing`);
    return views(id, view, asked, cancel);
  }

  /** A conversation's views, from its watch and its questions' watch: the newest when the reader asks. */
  async function* views(
    id: ConversationId,
    view: WatchHandle<PiConversationView>,
    asked: WatchHandle<unknown>,
    cancel: () => void,
  ): AsyncGenerator<ConversationView> {
    let changed = true;
    let ended = false;
    let wake = () => {};
    const changes = async (call: { kind: string }) => {
      if (call.kind !== "value") return;
      changed = true;
      wake();
    };
    view.start(changes);
    asked.start(changes);
    for (const watched of [view, asked]) {
      void watched.closed.then(() => {
        ended = true;
        wake();
      });
    }
    try {
      for (;;) {
        if (!changed) {
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          continue;
        }
        changed = false;
        const { entries, before, docs } = view.value;
        yield {
          info: await infoOf(harness, id),
          entries: entries.filter((entry) => !SystemEntry.is(entry)),
          ...(before === undefined ? {} : { before }),
          live: (docs[LiveDoc.definition.kind] ?? {}) as LiveState,
        };
      }
    } finally {
      cancel();
      await Promise.all([view.stop(), asked.stop()]);
    }
  }

  return {
    run,
    conversation,
    entries,
    conversations,
    runs,
    runOf,
    update,
    note,
    file,
    compact,
    delete: remove,
    stop,
    watch,
    async close() {
      await tracing.closeAll();
      await harness.close(context);
      resources.clear();
    },
  };
}

/** A page's size: a whole number, 1 or more. */
function checkLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new RangeError(
      `limit must be a whole number of 1 or more, not ${limit}`,
    );
}

/** A conversation as a client reads it: what its first run made it with, and how it stands now. */
async function infoOf(
  reader: Harness,
  id: ConversationId,
): Promise<ConversationInfo> {
  const kept = await reader.snapshot(ConversationDoc, id, context);
  if (!kept) throw new Error(`conversation ${id}: its document is missing`);
  const transcript = await reader.conversation(id, context);
  if (!transcript) throw new Error(`conversation ${id}: it is missing`);
  const live = (await reader.snapshot(LiveDoc, id, context)) ?? {};
  const newest = await lastMessageTime(transcript, context);
  const made = {
    conversation: kept.conversation,
    agent: kept.agent,
    caller: kept.caller,
    ...(kept.context === undefined ? {} : { context: kept.context }),
    title: kept.title,
    createdAt: kept.createdAt,
    lastMessageAt:
      newest === undefined ? kept.createdAt : new Date(newest).toISOString(),
  };
  if (live.run === undefined) {
    // A run a person stopped ended as they asked: the conversation is idle, not in error.
    const failure =
      live.runFailure &&
      !(await stoppedAll(reader, id, kept, live.runFailure.inputs))
        ? live.runFailure
        : undefined;
    return failure === undefined
      ? { ...made, status: "idle", interrupts: [] }
      : {
          ...made,
          status: "error",
          interrupts: [],
          runFailure: {
            reason: failure.reason,
            ...(failure.detail === undefined ? {} : { detail: failure.detail }),
          },
        };
  }
  const runId = await runGoingOn(reader, id, context);
  const asked = (await reader.snapshot(InterruptsDoc, id, context))?.asked;
  const waiting = paused(asked ?? {}, live);
  return {
    ...made,
    status: waiting ? "interrupted" : "busy",
    ...(runId === undefined ? {} : { runId }),
    interrupts: waiting ?? [],
  };
}

/** Whether a submission has settled: answered, or not. */
function isSettled(
  record: SubmissionRecord,
): record is SettledSubmissionRecord {
  return record.status === "done" || record.status === "unanswered";
}

/** A kept question as a client reads it: what was asked, and the answer once given. */
function questionOf(id: string, asked: Asked): Question {
  return {
    id,
    callId: asked.callId,
    value: asked.value,
    ...(Object.hasOwn(asked, "answer") ? { answer: asked.answer! } : {}),
    ...(asked.error === undefined ? {} : { error: asked.error }),
  };
}

/** Whether a person stopped the runs of these inputs. */
async function stoppedAll(
  reader: DocumentReader,
  id: ConversationId,
  kept: ConversationState,
  inputs: readonly SubmissionId[],
) {
  for (const input of inputs) {
    const runId = kept.inputs?.[input];
    const run =
      runId === undefined
        ? undefined
        : await reader.snapshot(RunDoc, id, runId, context);
    if (!run?.stopped) return false;
  }
  return inputs.length > 0;
}

/** Refuse a run that gives a conversation another agent, caller or context than its first run made it with. */
/**
 * A conversation's title from its first input, as a list shows it on one line: its words with single spaces between,
 * cut at the last space before the limit, with "…".
 */
function titleOf(input: string): string {
  const words = input.replace(/\s+/g, " ").trim();
  if (words.length <= titleCut) return words;
  const cut = words.slice(0, titleCut - 1);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}…`;
}

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
            callId: question.callId,
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
