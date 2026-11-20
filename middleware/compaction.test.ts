import { describe, expect, it, vi } from "vitest";
import type { ModelApi } from "../define/index.ts";
import { compaction } from "./compaction.ts";

const api = (compacting = false) => {
  const compact = vi.fn<ModelApi["compact"]>(async () => {});
  return { compacting, compact };
};

describe("compaction", () => {
  it("refuses a trigger that is not a whole number of tokens, 1 or more", () => {
    for (const tokens of [0, -1, 1.5, Number.NaN])
      expect(() => compaction({ trigger: { tokens } })).toThrow(RangeError);
  });

  it("asks for a compaction past its trigger, with its instructions, and not at it or while one goes on", async () => {
    const { afterModel } = compaction({
      trigger: { tokens: 100 },
      instructions: " Keep the names. ",
    });
    const at = api();
    await afterModel!({ contextTokens: 100 }, at);
    expect(at.compact).not.toHaveBeenCalled();
    const past = api();
    await afterModel!({ contextTokens: 101 }, past);
    expect(past.compact).toHaveBeenCalledExactlyOnceWith("Keep the names.");
    const going = api(true);
    await afterModel!({ contextTokens: 500 }, going);
    expect(going.compact).not.toHaveBeenCalled();
  });
});
