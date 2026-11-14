import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { type EntryRecord, MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../define/index.ts";
import { humanInTheLoop } from "../middleware/index.ts";
import {
  type ConversationView,
  openRuntime,
  RunFailed,
  type RunOptions,
  type Runtime,
} from "./index.ts";
import { resultOf, scripted } from "./scripted.fixture.ts";

const { faux, models, model } = scripted();
const caller = { id: "owner" };

/** A tool that holds its call until the test lets it go, so a run stays going. */
let release = () => {};
let held = () => {};
let ran = 0;
const hold = defineTool({
  name: "hold",
  description: "Hold.",
  schema: z.object({}),
  run: () =>
    new Promise<string>((resolve) => {
      ran += 1;
      release = () => resolve("held");
      held();
    }),
});
/** Wait until the next call of hold is holding. */
const holding = () => new Promise<void>((resolve) => (held = resolve));

let sent = 0;
const send = defineTool({
  name: "send",
  description: "Send.",
  schema: z.object({}),
  run: () => {
    sent += 1;
    return "sent";
  },
});

const agent = defineAgent({
  name: "chat",
  model,
  instructions: "Chat.",
  tools: [hold, send],
  middleware: [humanInTheLoop({ interruptOn: { send: true } })],
});

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function open() {
  faux.setResponses([]);
  ran = 0;
  sent = 0;
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  return runtime;
}

const says = (text: string) => fauxAssistantMessage([fauxText(text)]);
const calls = (name: string, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, {}, { id })], {
    stopReason: "toolUse",
  });
const options = (
  runId: string,
  more: Partial<RunOptions<undefined>> = {},
): RunOptions<undefined> =>
  ({ conversation: "c", runId, caller, ...more }) as RunOptions<undefined>;

/** A run, and a promise that settles once it is admitted. */
function start(
  runtime: Runtime,
  input: string,
  runId: string,
  more: Partial<RunOptions<undefined>> = {},
) {
  let admitted = () => {};
  const started = new Promise<void>((resolve) => (admitted = resolve));
  const outcome = runtime.run(
    agent,
    input,
    options(runId, { ...more, onStarted: admitted }),
  );
  outcome.catch(() => {});
  return { outcome, started };
}

/** The text of the user and assistant messages of some entries. */
const textsOf = (entries: readonly EntryRecord[]) =>
  entries.flatMap((entry) =>
    (entry.model ?? []).flatMap((message) =>
      message.role === "user" && typeof message.content === "string"
        ? [message.content]
        : message.role === "assistant"
          ? message.content.flatMap((block) =>
              block.type === "text" ? [block.text] : [],
            )
          : [],
    ),
  );

/** Every entry of a run, by its range. */
async function entriesOf(runtime: Runtime, runId: string) {
  const run = await runtime.runOf("c", runId);
  if (!run?.entries) return [];
  const { first, last } = run.entries;
  return (await runtime.entries(
    "c",
    {
      order: "ascending",
      minEntryId: first,
      ...(last === undefined ? {} : { maxEntryId: last }),
    },
    100,
  ))!.items;
}

describe("a conversation's runs", () => {
  it("are listed newest first, each with how it ended and its own entries, a steer with the run it joined", async () => {
    const runtime = await open();
    faux.setResponses([
      calls("hold", "h"),
      says("One and two."),
      says("Three."),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "down" }),
    ]);
    const going = holding();
    const one = start(runtime, "One.", "1");
    await going;
    const steer = start(runtime, "And two.", "2", { whenBusy: "steer" });
    await steer.started;
    const three = start(runtime, "Three?", "3", { whenBusy: "followUp" });
    await three.started;
    expect(await runtime.runOf("c", "3")).toMatchObject({
      status: "pending",
    });
    expect(await runtime.runOf("c", "1")).toMatchObject({
      status: "running",
    });
    release();
    await one.outcome;
    await three.outcome;
    await expect(
      runtime.run(agent, "Four.", options("4")),
    ).rejects.toBeInstanceOf(RunFailed);
    const page = await runtime.runs("c");
    expect(page?.next).toBeUndefined();
    expect(
      page?.items.map(({ runId, status, joined, failure }) => ({
        runId,
        status,
        ...(joined === undefined ? {} : { joined }),
        ...(failure === undefined ? {} : { reason: failure.reason }),
      })),
    ).toEqual([
      { runId: "4", status: "failed", reason: "model_error" },
      { runId: "3", status: "done" },
      { runId: "2", status: "done", joined: "1" },
      { runId: "1", status: "done" },
    ]);
    const first = page!.items[3]!;
    expect(first.steers).toEqual([{ runId: "2", entry: expect.any(Number) }]);
    // Each run's entries are its own, and together they are the conversation's.
    expect(textsOf(await entriesOf(runtime, "1"))).toEqual([
      "One.",
      "And two.",
      "One and two.",
    ]);
    expect(textsOf(await entriesOf(runtime, "3"))).toEqual([
      "Three?",
      "Three.",
    ]);
    // A steer starts no run: its entries are the run's it joined.
    expect(page!.items[2]!.entries).toBeUndefined();
    expect(textsOf(await entriesOf(runtime, "4"))).toEqual(["Four."]);
    const all = (await runtime.entries("c", { order: "ascending" }, 100))!
      .items;
    expect([
      ...(await entriesOf(runtime, "1")),
      ...(await entriesOf(runtime, "3")),
      ...(await entriesOf(runtime, "4")),
    ]).toEqual(all);
  });

  it("are paged by next, and undefined for a conversation no run made", async () => {
    const runtime = await open();
    for (const runId of ["1", "2", "3"]) {
      faux.setResponses([says(`Run ${runId}.`)]);
      await runtime.run(agent, "Hi.", options(runId)).then(resultOf);
    }
    const first = await runtime.runs("c", { limit: 2 });
    expect(first?.items.map((run) => run.runId)).toEqual(["3", "2"]);
    const second = await runtime.runs("c", { limit: 2, cursor: first!.next! });
    expect(second).toEqual({
      items: [expect.objectContaining({ runId: "1" })],
    });
    expect(await runtime.runs("none")).toBeUndefined();
    expect(await runtime.runOf("c", "9")).toBeUndefined();
  });

  it("keep each run's questions and answers, and a later call with the same call id asks afresh", async () => {
    const runtime = await open();
    const attended = { attended: true };
    faux.setResponses([calls("send", "s"), says("Sent.")]);
    await runtime.run(agent, "Send.", options("1", attended));
    await runtime
      .run(
        agent,
        { resume: { "s:human-in-the-loop:0": { type: "approve" } } },
        options("1", attended),
      )
      .then(resultOf);
    // The model gives the next call the same id: it is a new call, and the person is asked again.
    faux.setResponses([calls("send", "s"), says("Sent again.")]);
    await expect(
      runtime.run(agent, "Again.", options("2", attended)),
    ).resolves.toMatchObject({
      status: "interrupted",
      interrupts: [{ id: "s:human-in-the-loop:0", callId: "s" }],
    });
    expect(sent).toBe(1);
    expect((await runtime.runOf("c", "1"))?.questions).toEqual([
      {
        id: "s:human-in-the-loop:0",
        callId: "s",
        value: expect.objectContaining({ type: "tool_approval" }),
        answer: { type: "approve" },
      },
    ]);
    expect(await runtime.runOf("c", "2")).toMatchObject({
      status: "interrupted",
      questions: [{ id: "s:human-in-the-loop:0" }],
    });
  });
});

describe("stopping a run", () => {
  it("stops the run going on: it ends stopped, the conversation is idle, and a second stop finds it ended", async () => {
    const runtime = await open();
    faux.setResponses([calls("hold", "h"), says("Too late.")]);
    const going = holding();
    const one = start(runtime, "Hold.", "1");
    await going;
    expect(await runtime.stop("c", "1")).toBe("stopped");
    await expect(one.outcome).rejects.toMatchObject({ reason: "stopped" });
    expect(await runtime.runOf("c", "1")).toMatchObject({ status: "stopped" });
    const kept = await runtime.conversation("c");
    expect(kept).toMatchObject({ status: "idle" });
    expect(kept).not.toHaveProperty("runFailure");
    expect(await runtime.stop("c", "1")).toBe("ended");
    expect(await runtime.stop("c", "9")).toBeUndefined();
    expect(await runtime.stop("none", "1")).toBeUndefined();
  });

  it("stops a run that waits on a question, and its tool never runs", async () => {
    const runtime = await open();
    faux.setResponses([calls("send", "s"), says("Sent.")]);
    await expect(
      runtime.run(agent, "Send.", options("1", { attended: true })),
    ).resolves.toMatchObject({ status: "interrupted" });
    expect(await runtime.stop("c", "1")).toBe("stopped");
    await expect(
      runtime.run(agent, "Send.", options("1", { attended: true })),
    ).rejects.toMatchObject({ reason: "stopped" });
    expect(sent).toBe(0);
    expect(await runtime.conversation("c")).toMatchObject({ status: "idle" });
  });

  it("withdraws a queued run alone, and stops the run going on with every run queued behind it", async () => {
    const runtime = await open();
    faux.setResponses([calls("hold", "h"), says("Five.")]);
    const going = holding();
    const one = start(runtime, "One.", "1");
    await going;
    const queued = ["2", "3", "4"].map((runId) => {
      const run = start(runtime, `Run ${runId}.`, runId, {
        whenBusy: "followUp",
      });
      return run;
    });
    for (const run of queued) await run.started;
    expect(await runtime.stop("c", "2")).toBe("stopped");
    await expect(queued[0]!.outcome).rejects.toMatchObject({
      reason: "stopped",
    });
    expect(await runtime.stop("c", "1")).toBe("stopped");
    for (const run of [one, queued[1]!, queued[2]!])
      await expect(run.outcome).rejects.toMatchObject({ reason: "stopped" });
    expect(
      (await runtime.runs("c"))?.items.map(({ runId, status }) => [
        runId,
        status,
      ]),
    ).toEqual([
      ["4", "stopped"],
      ["3", "stopped"],
      ["2", "stopped"],
      ["1", "stopped"],
    ]);
    expect(ran).toBe(1);
    // The conversation takes the next input at once.
    await expect(
      runtime.run(agent, "Five.", options("5")).then(resultOf),
    ).resolves.toBe("Five.");
  });
});

describe("watching a conversation", () => {
  it("gives a value at once, then one per change, with the live round and how it stands, until its signal", async () => {
    const runtime = await open();
    faux.setResponses([calls("hold", "h"), says("Done.")]);
    const going = holding();
    const one = start(runtime, "Hold.", "1");
    await going;
    const stop = new AbortController();
    const views = (await runtime.watch("c", { signal: stop.signal }))!;
    const seen: ConversationView[] = [];
    let released = false;
    for await (const view of views) {
      seen.push(view);
      if (!released) {
        expect(view.info).toMatchObject({ status: "busy", runId: "1" });
        expect(view.live.tools).toEqual([
          expect.objectContaining({ callId: "h", name: "hold" }),
        ]);
        released = true;
        release();
      }
      if (view.info.status === "idle") stop.abort();
    }
    await one.outcome;
    const last = seen.at(-1)!;
    expect(last.info.status).toBe("idle");
    expect(last.entries.map((entry) => entry.kind)).not.toContain("pi.system");
    expect(textsOf(last.entries)).toEqual(["Hold.", "Done."]);
    expect(await runtime.watch("none")).toBeUndefined();
  });
});
