import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
  defineEntry,
  type DocumentReader,
  LiveDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { Caller, Json, ServiceIdentity } from "../define/index.ts";

/** A span a run's trace hangs from, as plain JSON: the ids of OpenTelemetry's span context. */
export type TraceParent = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

/**
 * What a conversation keeps besides its transcript: what its first run made it with, which every run on it gives again,
 * and its runs. One per conversation.
 */
export type ConversationState = {
  /** The host's key for the conversation. */
  conversation: string;
  /** The agent it runs. */
  agent: string;
  caller: Caller;
  /** Absent when it was given none. */
  context?: Json;
  /** What a client lists it by: its first input, cut short, or what a rename gave. */
  title: string;
  /** When it was made, ISO 8601: pi keeps no clock on a conversation. */
  createdAt: string;
  /** Its runs' ids, in the order they were admitted. */
  runs: string[];
  /**
   * Each run's id by its input, pi's submission: how the run going on is found from the input that started pi's run.
   * Absent on a conversation made before it was kept: its run going on is its last.
   */
  inputs?: Record<string, string>;
  /** Each note's submission by the note's id, so the same note sent again is placed once. Absent before its first. */
  notes?: Record<string, number>;
};

/**
 * A note: a message put in a conversation for its runs to read, which starts no run. Its `model` is one user message;
 * its data, the note's id, by which a client tells it from a person's input.
 */
export const NoteEntry = defineEntry<{ noteId: string }>("que-pasa.note");

/** The conversation's own document, written in the commit that makes it. */
export const ConversationDoc = defineDoc<ConversationState>({
  kind: "que-pasa.conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({
    conversation: "",
    agent: "",
    caller: { id: "" },
    title: "",
    createdAt: "",
    runs: [],
  }),
  checkpointWhen: () => true,
});

/** What a run keeps, besides its submission: one per run id, written in the commit that admits it. */
export type RunState = {
  /** The model it runs on, "provider:model-id": the agent's, or the one the run was given. */
  model: string;
  /**
   * What the conversation had spent when the run started, before its first model request: its usage is what it spent
   * after. Absent until it starts; a steer that joined another run never starts one.
   */
  spent?: UsageState;
  /** The parent of each of its trace's segments: the host's span it was started in, or its first segment. */
  trace?: TraceParent;
  /** Who each of its connections with a `whoami` is logged in as, by the connection's name: at its start, or once connected. */
  identities?: Record<string, ServiceIdentity>;
  /** Whether someone attends it, to answer what it asks. Absent: nobody does. */
  attended?: boolean;
  /** The run it joined, for a steer admitted while another went on: it starts no run of its own. */
  joined?: string;
  /** Set when a person stopped it, before pi aborts it: it ended as they asked, not as a failure. */
  stopped?: true;
  /**
   * What its calls asked, and the answers, by the question's id: moved here from the conversation's questions when the
   * next run starts, so a later call with the same call id asks afresh, and the run read later shows what it asked.
   */
  asked?: Record<string, Asked>;
};

/** A question a tool call asked, and its answer once given. */
export type Asked = {
  /** The run that asked it. */
  runId: string;
  /**
   * Every run of pi's run when it was asked: the one that asked, and the steers that joined it. pi settles all of them
   * with one outcome, so each fails with this question when nobody can answer it.
   */
  runs: string[];
  /** The call that asked it. */
  callId: string;
  /** Someone attends its run, to answer it. Absent: its run stops with it. */
  attended?: true;
  value: Json;
  /** Absent until answered. */
  answer?: Json;
  /** Why the last answer was refused, when it did not fit. */
  error?: string;
};

/** A run's document, by its run id. */
export const RunDoc = defineDocFamily<RunState, null>({
  kind: "que-pasa.run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ model: "" }),
  checkpointWhen: () => true,
});

/**
 * What the calls of a conversation's newest run asked, by the question's id, and the answers: kept, so a call that
 * reruns after a restart finds its answer. One run waits at a time, so these are its run's; a steer that joined it sees
 * the same. A run that starts at once moves them to the runs that asked them.
 */
export const InterruptsDoc = defineDoc<{ asked: Record<string, Asked> }>({
  kind: "que-pasa.interrupts",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ asked: {} }),
  checkpointWhen: () => true,
});

/** Where a conversation is: one document per host key, so a run on the key finds the conversation its first run made. */
export const ConversationIndex = defineDocFamily<
  { conversationId: ConversationId | null },
  null
>({
  kind: "que-pasa.conversation-index",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversationId: null }),
  checkpointWhen: () => true,
});

/**
 * A caller's conversations, in the order they were made: one document per caller id, appended in the commit that makes
 * the conversation, so a caller's list is read without a scan of every conversation.
 */
export const CallerIndex = defineDocFamily<
  { conversations: { conversation: string; agent: string }[] },
  null
>({
  kind: "que-pasa.caller-index",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversations: [] }),
  checkpointWhen: () => true,
});

/**
 * What a middleware keeps for a conversation: what its `beforeAgent` gave back, written in the commit that makes the
 * conversation, so a run that resumes in a new process reads the same. One per middleware, by its name.
 */
export const MiddlewareDoc = defineDocFamily<{ state: Json }, Json>({
  kind: "que-pasa.middleware",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: (state) => ({ state: state ?? null }),
  checkpointWhen: () => true,
});

/**
 * The run going on: the run of the input that started pi's run going on, which steers join. Undefined when the
 * conversation is idle.
 */
export async function runGoingOn(
  reader: DocumentReader,
  id: ConversationId,
  context: Context,
): Promise<string | undefined> {
  const first = (await reader.snapshot(LiveDoc, id, context))?.run?.inputs[0];
  if (first === undefined) return undefined;
  const kept = await reader.snapshot(ConversationDoc, id, context);
  // A conversation made before it kept its inputs took one run at a time: the one going on is its last.
  return kept?.inputs?.[first] ?? kept?.runs.at(-1);
}
