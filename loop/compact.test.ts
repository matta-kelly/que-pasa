import {
  createModels,
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { CompactionEntry, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../define/index.ts";
import { compaction } from "../middleware/index.ts";
import { openRuntime, type RunOptions, type Runtime } from "./index.ts";
import { resultOf } from "./scripted.fixture.ts";

// A window wide enough that pi's own threshold (16k tokens below it) never starts a compaction here.
const faux = fauxProvider({ models: [{ id: "main", contextWindow: 500_000 }] });
const models = createModels();
models.setProvider(faux.provider);
const model = `${faux.provider.id}:main`;
const caller = { id: "owner" };

/** A reply of about `tokens` tokens: faux counts 4 characters as one. pi keeps 20k tokens as they are, so a summary needs more. */
const long = (tokens: number) => "word ".repeat((tokens * 4) / 5);

/** A tool that holds its call until the test lets it go, so a run stays going. */
let release = () => {};
let held = () => {};
let holding = Promise.resolve();
const nextHold = () => {
  holding = new Promise<void>((resolve) => (held = resolve));
};
const hold = defineTool({
  name: "hold",
  description: "Hold.",
  schema: z.object({}),
  run: () =>
    new Promise<string>((resolve) => {
      release = () => resolve("held");
      held();
    }),
});

const named = (
  name: string,
  middleware = [] as ReturnType<typeof compaction>[],
) =>
  defineAgent({
    name,
    model,
    instructions: "Chat.",
    tools: [hold],
    middleware,
  });

/** No compaction middleware: pi's own threshold only. */
const plain = named("plain");
/** Compacts past 30k tokens. */
const early = named("early", [compaction({ trigger: { tokens: 30_000 } })]);
/** The same model as `early`, compacting past 60k tokens. */
const late = named("late", [compaction({ trigger: { tokens: 60_000 } })]);

/** A message's text: its string, or its text blocks joined. */
const textOf = (message: Message | undefined) =>
  typeof message?.content === "string"
    ? message.content
    : (message?.content ?? [])
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");

/** pi's summarizer request: its system message is pi's summarization prompt. */
const isSummarizer = (messages: readonly Message[]) =>
  messages.some(
    (m) =>
      (m.role as string) === "system" &&
      textOf(m).startsWith("You are a context summarization assistant"),
  );

/** What the summarizer was asked for, by request: its user message. */
const summarized: string[] = [];
/** The user messages of each agent request, by request. */
const seen: string[][] = [];
/** Held summaries, let go by the test. */
let summaryGate: Promise<void> | undefined;

/**
 * The script: each agent request takes the next reply; each summarizer request answers "Summary." once the gate, if
 * any, is let go.
 */
function script(replies: ReturnType<typeof fauxAssistantMessage>[]) {
  const step: FauxResponseFactory = async (context) => {
    if (isSummarizer(context.messages)) {
      summarized.push(textOf(context.messages.find((m) => m.role === "user")));
      await summaryGate;
      return fauxAssistantMessage([fauxText("Summary.")]);
    }
    seen.push(
      context.messages.flatMap((m: Message) =>
        m.role === "user" ? [textOf(m)] : [],
      ),
    );
    const reply = replies.shift();
    if (!reply) throw new Error("the script has no reply left");
    return reply;
  };
  faux.setResponses(Array.from({ length: 20 }, () => step));
}

const says = (text: string) => fauxAssistantMessage([fauxText(text)]);
const holds = (text: string) =>
  fauxAssistantMessage(
    [fauxText(text), fauxToolCall("hold", {}, { id: "h" })],
    {
      stopReason: "toolUse",
    },
  );

const options = (conversation: string, runId: string) =>
  ({ conversation, runId, caller }) as RunOptions<undefined>;

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  summaryGate = undefined;
});

async function open() {
  summarized.length = 0;
  seen.length = 0;
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [plain, early, late],
  });
  return runtime;
}

/** The compaction entries of a conversation. */
async function compactions(runtime: Runtime, key: string) {
  return (await runtime.entries(key, {}, 100))!.items.filter((entry) =>
    CompactionEntry.is(entry),
  );
}

describe("compact, by hand", () => {
  it("on an idle conversation places a summary, and the next run reads it", async () => {
    const runtime = await open();
    script([says(long(25_000)), says("Two.")]);
    await runtime.run(plain, "One.", options("c", "1")).then(resultOf);
    expect(
      await runtime.compact("c", { instructions: "Keep the names." }),
    ).toEqual({ status: "compacting" });
    await vi.waitFor(async () =>
      expect(await compactions(runtime, "c")).toHaveLength(1),
    );
    expect(summarized[0]).toContain("Keep the names.");
    await runtime.run(plain, "Two.", options("c", "2")).then(resultOf);
    expect(seen.at(-1)?.[0]).toContain("<summary>\nSummary.\n</summary>");
    expect((await runtime.runs("c"))!.items).toHaveLength(2);
  });

  it("while a run goes on is placed at its next step", async () => {
    const runtime = await open();
    script([holds(long(25_000)), says("Done.")]);
    nextHold();
    const going = runtime.run(plain, "One.", options("c", "1"));
    await holding;
    await runtime.compact("c");
    await vi.waitFor(() => expect(summarized).toHaveLength(1));
    release();
    await expect(going.then(resultOf)).resolves.toBe("Done.");
    expect(await compactions(runtime, "c")).toHaveLength(1);
    expect(seen.at(-1)?.[0]).toContain("<summary>\nSummary.\n</summary>");
  });

  it("asked again while one goes on starts no second", async () => {
    const runtime = await open();
    let letGo = () => {};
    summaryGate = new Promise<void>((resolve) => (letGo = resolve));
    script([says(long(25_000))]);
    await runtime.run(plain, "One.", options("c", "1")).then(resultOf);
    const [first, second] = await Promise.all([
      runtime.compact("c"),
      runtime.compact("c"),
    ]);
    expect(first).toEqual({ status: "compacting" });
    expect(second).toEqual({ status: "compacting" });
    expect(await runtime.compact("c")).toEqual({ status: "compacting" });
    await vi.waitFor(() => expect(summarized).toHaveLength(1));
    letGo();
    await vi.waitFor(async () =>
      expect(await compactions(runtime, "c")).toHaveLength(1),
    );
    expect(summarized).toHaveLength(1);
  });

  it("is undefined for a key no run made", async () => {
    const runtime = await open();
    expect(await runtime.compact("none")).toBeUndefined();
  });
});

describe("the compaction middleware", () => {
  it("compacts each agent at its own trigger, on one model, and an agent without it not at all", async () => {
    const runtime = await open();
    script([says(long(40_000)), says(long(40_000)), says(long(40_000))]);
    await runtime.run(early, "One.", options("early", "1")).then(resultOf);
    await runtime.run(late, "One.", options("late", "1")).then(resultOf);
    await runtime.run(plain, "One.", options("plain", "1")).then(resultOf);
    await vi.waitFor(async () =>
      expect(await compactions(runtime, "early")).toHaveLength(1),
    );
    expect(await compactions(runtime, "late")).toHaveLength(0);
    expect(await compactions(runtime, "plain")).toHaveLength(0);
    expect(summarized).toHaveLength(1);
  });
});
