import {
  type ConversationId,
  defineDoc,
  defineDocFamily,
} from "@earendil-works/pi-durable";
import type { Caller, Json } from "../define/index.ts";

/** A span a run's trace hangs from, as plain JSON: the ids of OpenTelemetry's span context. */
export type TraceParent = {
  traceId: string;
  spanId: string;
  traceFlags: number;
};

/** What a run keeps besides its transcript: who it is for, and what its tools are given. One per run's conversation. */
export type RunState = {
  /** The host's id for the run. */
  runId: string;
  /** The agent it runs. */
  agent: string;
  /** The model it runs on, "provider:model-id": the agent's, or the one the run was started with. */
  model: string;
  caller: Caller;
  /** Absent when the run was given none. */
  context?: Json;
  /** The parent of each of its trace's segments: the host's span it was started in, or its first segment. */
  trace?: TraceParent;
};

/** The run's own document, written in the commit that makes its conversation. */
export const RunDoc = defineDoc<RunState>({
  kind: "que-pasa.run",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ runId: "", agent: "", model: "", caller: { id: "" } }),
  checkpointWhen: () => true,
});

/** Where a run is: its conversation, one document per run id, so a run started again finds the one it started. */
export const RunIndex = defineDocFamily<
  { conversationId: ConversationId | null },
  null
>({
  kind: "que-pasa.run-index",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ conversationId: null }),
  checkpointWhen: () => true,
});

/**
 * What a middleware keeps for a run: what its `beforeAgent` gave back, written in the commit that makes the run, so a
 * run that resumes in a new process reads the same. One per middleware, by its name.
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
