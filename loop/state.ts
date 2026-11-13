import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
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
  /** Its runs' ids, in the order they were admitted: the last is the one going on, or the last that ended. */
  runs: string[];
};

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
    runs: [],
  }),
  checkpointWhen: () => true,
});

/** What a run keeps, besides its submission: one per run id, written in the commit that admits it. */
export type RunState = {
  /** The model it runs on, "provider:model-id": the agent's, or the one the run was given. */
  model: string;
  /** What the conversation had spent when the run was admitted: the run's usage is what it spent after. */
  spent: UsageState;
  /** The parent of each of its trace's segments: the host's span it was started in, or its first segment. */
  trace?: TraceParent;
  /** Who each of its connections with a `whoami` was logged in as when it started, by the connection's name. */
  identities?: Record<string, ServiceIdentity>;
};

/** A run's document, by its run id. */
export const RunDoc = defineDocFamily<RunState, null>({
  kind: "que-pasa.run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  family: true,
  initial: () => ({ model: "", spent: { models: {}, tools: {} } }),
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
