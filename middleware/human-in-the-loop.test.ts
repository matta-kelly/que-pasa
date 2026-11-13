import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../define/index.ts";
import {
  openRuntime,
  RunFailed,
  RunRefused,
  type Runtime,
} from "../loop/index.ts";
import { resultOf, scripted } from "../loop/scripted.fixture.ts";
import { humanInTheLoop } from "./index.ts";

const { faux, models, model } = scripted();
const caller = { id: "matt" };

/** What the gated tool was sent, in order. */
let sent: string[] = [];
const send = defineTool({
  name: "send_quote",
  description: "Send a quote.",
  schema: z.object({ to: z.string(), amount: z.number() }),
  run: ({ to, amount }) => {
    sent.push(`${to}:${amount}`);
    return `sent ${amount} to ${to}`;
  },
});
const look = defineTool({
  name: "look_up",
  description: "Look a customer up.",
  schema: z.object({ name: z.string() }),
  replay: "safe",
  run: ({ name }) => `${name} is a customer`,
});
const agent = defineAgent({
  name: "seller",
  model,
  instructions: "Sell.",
  tools: [send, look],
  middleware: [
    humanInTheLoop({
      interruptOn: {
        send_quote: {
          allowedDecisions: ["approve", "edit", "reject", "respond"],
        },
      },
    }),
  ],
});

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function open() {
  sent = [];
  faux.setResponses([]);
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  return runtime;
}

/** The model sends a quote, then answers with the tool's result. */
function sendsQuote(...more: ReturnType<typeof fauxAssistantMessage>[]) {
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall("send_quote", { to: "acme", amount: 100 }, { id: "q" })],
      { stopReason: "toolUse" },
    ),
    ...more,
    fauxAssistantMessage([fauxText("Done.")]),
  ]);
}

const question = {
  id: "q:human-in-the-loop:0",
  value: {
    type: "tool_approval",
    name: "send_quote",
    args: { to: "acme", amount: 100 },
    description:
      'Tool execution requires approval\n\nTool: send_quote\nArgs: {"to":"acme","amount":100}',
    allowedDecisions: ["approve", "edit", "reject", "respond"],
  },
};

const options = (extra: object = {}) => ({
  conversation: "c",
  runId: "1",
  caller,
  attended: true,
  ...extra,
});

/** The tool results the model was given. */
const results = (messages: Message[]) =>
  messages.flatMap((message) =>
    message.role === "toolResult"
      ? [
          `${message.isError ? "error" : "ok"}: ${message.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`,
        ]
      : [],
  );

describe("human in the loop", () => {
  it("asks before a gated call, and runs it once approved", async () => {
    const runtime = await open();
    sendsQuote();
    await expect(runtime.run(agent, "Quote acme.", options())).resolves.toEqual(
      { status: "interrupted", interrupts: [question] },
    );
    expect(sent).toEqual([]);
    // The same run again, unanswered, gives the same question back.
    await expect(runtime.run(agent, "Quote acme.", options())).resolves.toEqual(
      { status: "interrupted", interrupts: [question] },
    );
    await expect(
      runtime
        .run(
          agent,
          { resume: { [question.id]: { type: "approve" } } },
          options(),
        )
        .then(resultOf),
    ).resolves.toBe("Done.");
    expect(sent).toEqual(["acme:100"]);
  });

  it("runs an edited call with the person's arguments", async () => {
    const runtime = await open();
    sendsQuote();
    await runtime.run(agent, "Quote acme.", options());
    const edit = {
      type: "edit",
      editedAction: { name: "send_quote", args: { to: "acme", amount: 90 } },
    };
    await runtime
      .run(agent, { resume: { [question.id]: edit } }, options())
      .then(resultOf);
    expect(sent).toEqual(["acme:90"]);
  });

  it("gives the model the refusal on reject, and the person's message on respond, without running the tool", async () => {
    const runtime = await open();
    let messages: Message[] = [];
    sendsQuote();
    await runtime.run(agent, "Quote acme.", options());
    await runtime
      .run(
        agent,
        { resume: { [question.id]: { type: "reject", message: "too low" } } },
        options({ onMessages: (all: Message[]) => (messages = all) }),
      )
      .then(resultOf);
    expect(results(messages)).toEqual([
      "error: User rejected the tool call for `send_quote` with reason: too low",
    ]);
    sendsQuote();
    await runtime.run(agent, "Quote acme.", options({ runId: "2" }));
    await runtime
      .run(
        agent,
        {
          resume: {
            [question.id]: { type: "respond", message: "Already sent." },
          },
        },
        options({
          runId: "2",
          onMessages: (all: Message[]) => (messages = all),
        }),
      )
      .then(resultOf);
    expect(results(messages).at(-1)).toBe("ok: Already sent.");
    expect(sent).toEqual([]);
  });

  it("refuses an answer that does not fit, and asks again with why", async () => {
    const runtime = await open();
    sendsQuote();
    await runtime.run(agent, "Quote acme.", options());
    const again = await runtime.run(
      agent,
      { resume: { [question.id]: { type: "maybe" } } },
      options(),
    );
    expect(again).toMatchObject({
      status: "interrupted",
      interrupts: [{ id: question.id, error: expect.stringContaining("type") }],
    });
    const renamed = await runtime.run(
      agent,
      {
        resume: {
          [question.id]: {
            type: "edit",
            editedAction: { name: "delete_all", args: {} },
          },
        },
      },
      options(),
    );
    expect(renamed).toMatchObject({
      interrupts: [
        { error: expect.stringContaining("an edit keeps the tool") },
      ],
    });
    await runtime
      .run(agent, { resume: { [question.id]: { type: "approve" } } }, options())
      .then(resultOf);
    expect(sent).toEqual(["acme:100"]);
  });

  it("refuses answers to a question the run does not wait on", async () => {
    const runtime = await open();
    const refused = (runId: string, id: string) =>
      runtime
        .run(
          agent,
          { resume: { [id]: { type: "approve" } } },
          options({ runId }),
        )
        .catch((error: unknown) => error);
    expect(await refused("never", question.id)).toMatchObject({
      reason: "not_interrupted",
    });
    sendsQuote();
    await runtime.run(agent, "Quote acme.", options());
    expect(await refused("1", "q:other:0")).toBeInstanceOf(RunRefused);
    await runtime
      .run(agent, { resume: { [question.id]: { type: "approve" } } }, options())
      .then(resultOf);
    expect(await refused("1", question.id)).toMatchObject({
      reason: "not_interrupted",
    });
  });

  it("lets calls that are not gated run, and gives back every question of a round together", async () => {
    const runtime = await open();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("look_up", { name: "acme" }, { id: "l" }),
          fauxToolCall("send_quote", { to: "acme", amount: 100 }, { id: "q" }),
          fauxToolCall("send_quote", { to: "zeta", amount: 5 }, { id: "z" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const outcome = await runtime.run(agent, "Quote both.", options());
    expect(outcome).toMatchObject({ status: "interrupted" });
    expect(
      outcome.status === "interrupted" &&
        outcome.interrupts.map(({ id }) => id),
    ).toEqual(["q:human-in-the-loop:0", "z:human-in-the-loop:0"]);
    // One answer: the run still waits on the other.
    await expect(
      runtime.run(
        agent,
        { resume: { "q:human-in-the-loop:0": { type: "approve" } } },
        options(),
      ),
    ).resolves.toMatchObject({
      status: "interrupted",
      interrupts: [{ id: "z:human-in-the-loop:0" }],
    });
    await runtime
      .run(
        agent,
        { resume: { "z:human-in-the-loop:0": { type: "reject" } } },
        options(),
      )
      .then(resultOf);
    expect(sent).toEqual(["acme:100"]);
  });

  it("fails a run nobody attends, with the question, before the tool acts", async () => {
    const runtime = await open();
    sendsQuote();
    const failed = await runtime
      .run(agent, "Quote acme.", options({ attended: false }))
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RunFailed);
    expect(failed).toMatchObject({
      reason: "needs_answer",
      message: expect.stringContaining("approve send_quote"),
      interrupts: [question],
    });
    expect(sent).toEqual([]);
  });
});
