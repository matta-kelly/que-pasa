import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  type Cursor,
  type EntryRecord,
  MemoryStorage,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../define/index.ts";
import { humanInTheLoop } from "../middleware/index.ts";
import { openRuntime, type Runtime } from "./index.ts";
import { resultOf, scripted } from "./scripted.fixture.ts";

const { faux, models, model } = scripted();
const matt = { id: "matt" };
const sam = { id: "sam" };

/** A tool that holds its call until the test lets it go, so a run stays going. */
let release = () => {};
let holding = Promise.resolve();
let held = () => {};
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
const send = defineTool({
  name: "send",
  description: "Send.",
  schema: z.object({}),
  run: () => "sent",
});

const chat = defineAgent({
  name: "chat",
  model,
  instructions: "Chat.",
  tools: [hold, send],
  middleware: [humanInTheLoop({ interruptOn: { send: true } })],
});
const geo = defineAgent({
  name: "geo",
  model,
  instructions: "Answer briefly.",
  tools: [],
});

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function open() {
  faux.setResponses([]);
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [chat, geo],
  });
  return runtime;
}

const says = (text: string) => fauxAssistantMessage([fauxText(text)]);
const calls = (name: string, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, {}, { id })], {
    stopReason: "toolUse",
  });

/** One answered run on `conversation`. */
async function answered(
  runtime: Runtime,
  conversation: string,
  caller = matt,
  agent = geo,
  runId = "1",
) {
  faux.setResponses([says("Ok.")]);
  return runtime
    .run(agent, "Hi.", { conversation, runId, caller })
    .then(resultOf);
}

/** Every page of a read, in order, by following `next`. */
async function all<T>(
  page: (
    cursor: Cursor | undefined,
  ) => Promise<{ items: readonly T[]; next?: Cursor }>,
) {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const read = await page(cursor);
    items.push(...read.items);
    cursor = read.next;
  } while (cursor !== undefined);
  return items;
}

describe("a caller's conversations", () => {
  it("are listed newest made first, a page at a time to the end, and never another caller's", async () => {
    const runtime = await open();
    for (const key of ["a", "b", "c"]) await answered(runtime, key);
    await answered(runtime, "s", sam);
    const first = await runtime.conversations(matt, { limit: 2 });
    expect(first.items.map((c) => c.conversation)).toEqual(["c", "b"]);
    expect(first.next).toBeDefined();
    const second = await runtime.conversations(matt, {
      limit: 2,
      cursor: first.next!,
    });
    expect(second).toEqual({
      items: [expect.objectContaining({ conversation: "a" })],
    });
    expect(
      (await runtime.conversations(sam)).items.map((c) => c.conversation),
    ).toEqual(["s"]);
    expect(await runtime.conversations({ id: "nobody" })).toEqual({
      items: [],
    });
  });

  it("are those of the agents asked for, and a page ends where none is left of them", async () => {
    const runtime = await open();
    await answered(runtime, "g1");
    await answered(runtime, "c1", matt, chat);
    await answered(runtime, "g2");
    const page = await runtime.conversations(matt, {
      agents: ["chat"],
      limit: 1,
    });
    expect(page).toEqual({
      items: [expect.objectContaining({ conversation: "c1", agent: "chat" })],
    });
    expect(
      await all((cursor) =>
        runtime.conversations(matt, {
          agents: ["geo"],
          limit: 1,
          ...(cursor ? { cursor } : {}),
        }),
      ).then((items) => items.map((c) => c.conversation)),
    ).toEqual(["g2", "g1"]);
  });

  it("refuse a cursor that is not a page's next, and a limit under 1", async () => {
    const runtime = await open();
    await answered(runtime, "a");
    await expect(
      runtime.conversations(matt, { cursor: { before: 9 } }),
    ).rejects.toBeInstanceOf(StorageRequestError);
    await expect(
      runtime.conversations(matt, { cursor: { after: 1 } }),
    ).rejects.toBeInstanceOf(StorageRequestError);
    await expect(runtime.conversations(matt, { limit: 0 })).rejects.toThrow(
      /limit/,
    );
    await expect(runtime.entries("a", {}, 0)).rejects.toThrow(/limit/);
  });
});

describe("a conversation, as it stands", () => {
  it("is undefined for a key no run made", async () => {
    const runtime = await open();
    expect(await runtime.conversation("none")).toBeUndefined();
    expect(await runtime.entries("none", {}, 10)).toBeUndefined();
  });

  it("is idle once its run is done, with what its first run made it with", async () => {
    const runtime = await open();
    faux.setResponses([says("Ok.")]);
    await runtime.run(geo, "Hi.", {
      conversation: "a",
      runId: "1",
      caller: matt,
      context: { team: "ops" },
    });
    expect(await runtime.conversation("a")).toEqual({
      conversation: "a",
      agent: "geo",
      caller: matt,
      context: { team: "ops" },
      status: "idle",
      interrupts: [],
    });
  });

  it("is busy with the run going on while a run goes on", async () => {
    const runtime = await open();
    holding = new Promise<void>((resolve) => (held = resolve));
    faux.setResponses([calls("hold", "h"), says("Done.")]);
    const going = runtime.run(chat, "Hold.", {
      conversation: "a",
      runId: "1",
      caller: matt,
    });
    await holding;
    expect(await runtime.conversation("a")).toMatchObject({
      status: "busy",
      runId: "1",
      interrupts: [],
    });
    release();
    await going;
    expect(await runtime.conversation("a")).toMatchObject({ status: "idle" });
  });

  it("is interrupted with its questions and the run to answer them on, then goes on once answered", async () => {
    const runtime = await open();
    faux.setResponses([calls("send", "s"), says("Sent.")]);
    const options = {
      conversation: "a",
      runId: "1",
      caller: matt,
      attended: true,
    };
    const outcome = await runtime.run(chat, "Send.", options);
    const kept = await runtime.conversation("a");
    expect(kept).toMatchObject({ status: "interrupted", runId: "1" });
    expect(outcome).toEqual({
      status: "interrupted",
      interrupts: kept!.interrupts,
    });
    await runtime
      .run(
        chat,
        { resume: { [kept!.interrupts[0]!.id]: { type: "approve" } } },
        options,
      )
      .then(resultOf);
    expect(await runtime.conversation("a")).toMatchObject({
      status: "idle",
      interrupts: [],
    });
  });

  it("is error with pi's runFailure when its newest run ended with no answer, and idle once a run answers", async () => {
    const runtime = await open();
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "down" }),
    ]);
    await expect(
      runtime.run(geo, "Hi.", { conversation: "a", runId: "1", caller: matt }),
    ).rejects.toMatchObject({ reason: "model_error" });
    expect(await runtime.conversation("a")).toMatchObject({
      status: "error",
      runFailure: { reason: "model_error", detail: expect.any(String) },
    });
    await answered(runtime, "a", matt, geo, "2");
    const kept = await runtime.conversation("a");
    expect(kept).toMatchObject({ status: "idle" });
    expect(kept).not.toHaveProperty("runFailure");
  });
});

describe("a conversation's entries", () => {
  /** A conversation of two runs, and its messages as onMessages gives them. */
  async function twoRuns(runtime: Runtime) {
    let messages: Message[] = [];
    faux.setResponses([calls("hold", "h"), says("One."), says("Two.")]);
    holding = new Promise<void>((resolve) => (held = resolve));
    const first = runtime.run(chat, "One.", {
      conversation: "a",
      runId: "1",
      caller: matt,
    });
    await holding;
    release();
    await first;
    await runtime.run(chat, "Two.", {
      conversation: "a",
      runId: "2",
      caller: matt,
      onMessages: (all) => (messages = all),
    });
    return messages;
  }

  const modelOf = (entries: readonly EntryRecord[]) =>
    entries.flatMap((entry) => entry.model ?? []);

  it("are pi's entries, newest first, with every message and no system entry, paged to the end one at a time either way", async () => {
    const runtime = await open();
    const messages = await twoRuns(runtime);
    const ascending = await all(
      async (cursor) =>
        (await runtime.entries("a", { order: "ascending" }, 1, cursor))!,
    );
    expect(ascending.map((entry) => entry.kind)).not.toContain("pi.system");
    expect(modelOf(ascending)).toEqual(messages);
    const descending = await all(
      async (cursor) => (await runtime.entries("a", {}, 1, cursor))!,
    );
    expect(descending).toEqual([...ascending].reverse());
  });

  it("fill a page past the system entries the scan finds, and end it only when the scan does", async () => {
    const runtime = await open();
    await twoRuns(runtime);
    const page = (await runtime.entries("a", { order: "ascending" }, 100))!;
    expect(page.next).toBeUndefined();
    // The first entries are the system prompt, then the input: a page of one skips the one and gives the other.
    const first = (await runtime.entries("a", { order: "ascending" }, 1))!;
    expect(first.items).toEqual([page.items[0]]);
    expect(first.items[0]!.kind).toBe("pi.user");
    expect(first.next).toBeDefined();
    // Bounded by entry ids, as pi's ConversationTranscript loads the page before what it has.
    const before = (await runtime.entries(
      "a",
      { maxEntryId: page.items[2]!.id, order: "descending" },
      2,
    ))!;
    expect(before.items).toEqual([page.items[2], page.items[1]]);
  });

  it("refuse a cursor of a scan in the other order", async () => {
    const runtime = await open();
    await twoRuns(runtime);
    const first = (await runtime.entries("a", { order: "ascending" }, 1))!;
    await expect(
      runtime.entries("a", { order: "descending" }, 1, first.next),
    ).rejects.toBeInstanceOf(StorageRequestError);
  });
});
