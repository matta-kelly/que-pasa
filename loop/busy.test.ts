import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../define/index.ts";
import { humanInTheLoop } from "../middleware/index.ts";
import {
  openRuntime,
  RunFailed,
  type RunOptions,
  type RunUsage,
  type Runtime,
} from "./index.ts";
import { resultOf } from "./scripted.fixture.ts";

const faux = fauxProvider({ models: [{ id: "main" }, { id: "fallback" }] });
const models = createModels();
models.setProvider(faux.provider);
const model = `${faux.provider.id}:main`;
const fallback = `${faux.provider.id}:fallback`;
const caller = { id: "matt" };

/** A tool that holds its call until the test lets it go, so a run stays going. */
let release = () => {};
let holding = Promise.resolve();
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
let held = () => {};
/** Wait until the next call of hold is holding. */
const nextHold = () => {
  holding = new Promise<void>((resolve) => (held = resolve));
};

const send = defineTool({
  name: "send",
  description: "Send.",
  schema: z.object({}),
  run: () => "sent",
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
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  return runtime;
}

/** The text of each user message the model was sent, by request. */
const seen: string[][] = [];
const seeing =
  (reply: ReturnType<typeof fauxAssistantMessage>) =>
  (request: { messages: Message[] }) => {
    seen.push(
      request.messages.flatMap((m) =>
        m.role === "user" && typeof m.content === "string" ? [m.content] : [],
      ),
    );
    return reply;
  };
const calls = (name: string, id: string) =>
  fauxAssistantMessage([fauxToolCall(name, {}, { id })], {
    stopReason: "toolUse",
  });
const says = (text: string) => fauxAssistantMessage([fauxText(text)]);

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
  return { outcome, started };
}

describe("an input to a busy conversation", () => {
  it("is refused by default, as reject", async () => {
    const runtime = await open();
    nextHold();
    faux.setResponses([calls("hold", "h"), says("Done.")]);
    const first = start(runtime, "Hold.", "1");
    await holding;
    await expect(
      runtime.run(agent, "Again.", options("2")),
    ).rejects.toMatchObject({ reason: "busy" });
    release();
    await expect(first.outcome.then(resultOf)).resolves.toBe("Done.");
  });

  it("follows up: queued, it starts when the run before it ends, with its own result, usage and messages", async () => {
    const runtime = await open();
    seen.length = 0;
    nextHold();
    faux.setResponses([
      seeing(calls("hold", "h")),
      seeing(says("First.")),
      seeing(says("Second.")),
    ]);
    const usage: Record<string, RunUsage> = {};
    const first = start(runtime, "One.", "1", {
      onUsage: (spent) => (usage["1"] = spent),
    });
    await holding;
    const second = start(runtime, "Two.", "2", {
      whenBusy: "followUp",
      onUsage: (spent) => (usage["2"] = spent),
    });
    await second.started;
    release();
    await expect(first.outcome.then(resultOf)).resolves.toBe("First.");
    await expect(second.outcome.then(resultOf)).resolves.toBe("Second.");
    // The second run's model saw both runs, in order: the queue never reached into the first.
    expect(seen).toEqual([["One."], ["One."], ["One.", "Two."]]);
    const requests = (spent: RunUsage | undefined) =>
      Object.values(spent?.models ?? {}).length;
    expect(requests(usage["1"])).toBe(1);
    expect(requests(usage["2"])).toBe(1);
    const tokens = (spent: RunUsage | undefined) =>
      Object.values(spent?.models ?? {}).reduce(
        (sum, used) => sum + used.totalTokens,
        0,
      );
    expect(tokens(usage["1"])).toBeGreaterThan(tokens(usage["2"]));
  });

  it("steers: joins the run going on at its next step, and gives back that run's answer", async () => {
    const runtime = await open();
    seen.length = 0;
    nextHold();
    faux.setResponses([seeing(calls("hold", "h")), seeing(says("Both."))]);
    let usage: RunUsage | undefined;
    const first = start(runtime, "One.", "1");
    await holding;
    const steer = start(runtime, "And two.", "2", {
      whenBusy: "steer",
      onUsage: (spent) => (usage = spent),
    });
    await steer.started;
    release();
    await expect(first.outcome.then(resultOf)).resolves.toBe("Both.");
    await expect(steer.outcome.then(resultOf)).resolves.toBe("Both.");
    expect(seen).toEqual([["One."], ["One.", "And two."]]);
    // It started no run of its own: what was spent is the run it joined.
    expect(usage).toEqual({ models: {}, tools: {} });
  });

  it("starts at once on an idle conversation, whatever its whenBusy", async () => {
    const runtime = await open();
    faux.setResponses([says("Hi.")]);
    await expect(
      runtime
        .run(agent, "Hi.", options("1", { whenBusy: "steer" }))
        .then(resultOf),
    ).resolves.toBe("Hi.");
  });

  it("runs a follow-up queued behind a run that failed", async () => {
    const runtime = await open();
    nextHold();
    faux.setResponses([
      calls("hold", "h"),
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "down" }),
      says("Second."),
    ]);
    const first = start(runtime, "One.", "1");
    await holding;
    const second = start(runtime, "Two.", "2", { whenBusy: "followUp" });
    await second.started;
    release();
    await expect(first.outcome).rejects.toBeInstanceOf(RunFailed);
    await expect(second.outcome.then(resultOf)).resolves.toBe("Second.");
  });

  it("runs a follow-up on the conversation's model, the one the run before it set", async () => {
    const runtime = await open();
    let models: string[] = [];
    nextHold();
    faux.setResponses([calls("hold", "h"), says("First."), says("Second.")]);
    const first = start(runtime, "One.", "1", { model: fallback });
    await holding;
    const second = start(runtime, "Two.", "2", {
      whenBusy: "followUp",
      onMessages: (all) =>
        (models = all.flatMap((m) =>
          m.role === "assistant" ? [m.model] : [],
        )),
    });
    await second.started;
    release();
    await first.outcome;
    await second.outcome;
    expect(models.at(-1)).toBe("fallback");
  });

  it("gives a steer that joined a run that asks the same questions, and an answer on either goes on", async () => {
    const runtime = await open();
    nextHold();
    faux.setResponses([calls("hold", "h"), calls("send", "s"), says("Sent.")]);
    const first = start(runtime, "One.", "1", { attended: true });
    await holding;
    const steer = start(runtime, "Send it.", "2", {
      whenBusy: "steer",
      attended: true,
    });
    await steer.started;
    release();
    const question = { id: "s:human-in-the-loop:0" };
    await expect(first.outcome).resolves.toMatchObject({
      status: "interrupted",
      interrupts: [question],
    });
    await expect(steer.outcome).resolves.toMatchObject({
      status: "interrupted",
      interrupts: [question],
    });
    await expect(
      runtime
        .run(
          agent,
          { resume: { [question.id]: { type: "approve" } } },
          options("2"),
        )
        .then(resultOf),
    ).resolves.toBe("Sent.");
  });

  it("starts a follow-up queued behind a run that waits once that run is answered", async () => {
    const runtime = await open();
    faux.setResponses([calls("send", "s"), says("Sent."), says("Second.")]);
    await expect(
      runtime.run(agent, "Send.", options("1", { attended: true })),
    ).resolves.toMatchObject({ status: "interrupted" });
    const second = start(runtime, "Two.", "2", { whenBusy: "followUp" });
    await second.started;
    await expect(
      runtime
        .run(
          agent,
          { resume: { "s:human-in-the-loop:0": { type: "approve" } } },
          options("1"),
        )
        .then(resultOf),
    ).resolves.toBe("Sent.");
    await expect(second.outcome.then(resultOf)).resolves.toBe("Second.");
  });
});
