import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type DocumentReader,
  UsageDoc,
  type UsageState,
} from "@earendil-works/pi-durable";
import { ConversationDoc, RunDoc } from "./state.ts";

const none = (): UsageState => ({ models: {}, tools: {} });

/**
 * What a run spent: what its conversation spent from the run's start to the next run's start, or to now for the last
 * run to start. Runs on a conversation never overlap, so this is all the run spent, failed attempts and compaction
 * included, as pi counts them. A run that never started, such as a steer that joined another, spent nothing of its own.
 */
export async function usageOf(
  reader: DocumentReader,
  id: ConversationId,
  runId: string,
  context: Context,
): Promise<UsageState> {
  const runs =
    (await reader.snapshot(ConversationDoc, id, context))?.runs ?? [];
  const at = runs.indexOf(runId);
  const spent = (await reader.snapshot(RunDoc, id, runId, context))?.spent;
  if (at < 0 || !spent) return none();
  // Runs start in the order they were admitted; a steer that joined one never starts.
  for (const next of runs.slice(at + 1)) {
    const after = (await reader.snapshot(RunDoc, id, next, context))?.spent;
    if (after) return usageSince(after, spent);
  }
  return usageSince(
    (await reader.snapshot(UsageDoc, id, context)) ?? none(),
    spent,
  );
}

type Counters = { [key: string]: number | Counters | undefined };

/**
 * What was spent between two readings of a conversation's `pi.usage`: `after` less `before`, per model and per tool. A
 * model or tool that spent nothing between them is left out. pi only adds to `pi.usage`, so no counter is below zero.
 */
export function usageSince(after: UsageState, before: UsageState): UsageState {
  return {
    models: bucketSince(after.models, before.models),
    tools: bucketSince(after.tools, before.tools),
  };
}

function bucketSince<U>(
  after: Record<string, U>,
  before: Record<string, U>,
): Record<string, U> {
  const since: Record<string, U> = {};
  for (const [key, usage] of Object.entries(after)) {
    const was = before[key];
    if (was === undefined) {
      since[key] = usage;
      continue;
    }
    const spent = less(usage as Counters, was as Counters);
    if (spent.totalTokens !== 0 || costOf(spent) !== 0) since[key] = spent as U;
  }
  return since;
}

/** Each counter of `after` less the same one of `before`; a counter `before` lacks is kept as it is. */
function less(after: Counters, before: Counters): Counters {
  const since: Counters = {};
  for (const [key, value] of Object.entries(after)) {
    const was = before[key];
    since[key] =
      typeof value === "number"
        ? value - (typeof was === "number" ? was : 0)
        : value && typeof was === "object"
          ? less(value, was)
          : value;
  }
  return since;
}

const costOf = (usage: Counters) => {
  const cost = usage["cost"];
  return typeof cost === "object" && typeof cost["total"] === "number"
    ? cost["total"]
    : 0;
};
