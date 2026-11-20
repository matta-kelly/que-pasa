/**
 * Compaction: an agent's conversation is compacted once its context passes the agent's own threshold, after LangChain's
 * `SummarizationMiddleware` and its `trigger`. pi does the compacting: it summarizes the older part and keeps the
 * recent part, placed at the run's next step. Without this middleware, an agent keeps pi's own threshold, near its
 * model's whole context window.
 */
import { defineMiddleware, type Middleware } from "../define/index.ts";

/** When to compact, LangChain's `trigger`: once the context passes this many tokens. */
export type Trigger = { tokens: number };

/**
 * Compact the agent's conversation once its context passes `trigger`.
 * - `trigger`: the tokens of context that start a compaction, a whole number, 1 or more
 * - `instructions`: what the summary keeps, given to pi's summarizer
 */
export function compaction({
  trigger,
  instructions,
}: {
  trigger: Trigger;
  instructions?: string;
}): Middleware {
  if (!Number.isSafeInteger(trigger.tokens) || trigger.tokens < 1)
    throw new RangeError(
      `compaction: the trigger is a whole number of tokens, 1 or more, not ${trigger.tokens}`,
    );
  const given = instructions?.trim() || undefined;
  return defineMiddleware({
    name: "compaction",
    afterModel: async ({ contextTokens }, api) => {
      if (contextTokens > trigger.tokens && !api.compacting)
        await api.compact(given);
    },
  });
}
