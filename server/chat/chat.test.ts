import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  DefaultChatTransport,
  readUIMessageStream,
  type UIMessageChunk,
} from "ai";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "../../define/index.ts";
import { openRuntime, type Runtime } from "../../loop/index.ts";
import { humanInTheLoop } from "../../middleware/index.ts";
import { createServer, type Server } from "../index.ts";
import type { ChatMessage, ChatPart } from "./message.ts";
import { MessageDiff } from "./stream.ts";

/** A model that writes its answers a few characters at a time, so an answer streams in more than one piece. */
const faux = fauxProvider({
  tokensPerSecond: 60,
  tokenSize: { min: 2, max: 4 },
});
const models = createModels();
models.setProvider(faux.provider);
const model = `${faux.provider.id}:${faux.getModel().id}`;

/** A tool that holds its call until the test lets it go, so a run stays going. */
let release = () => {};
let held = () => {};
const holding = () => new Promise<void>((resolve) => (held = resolve));
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
const look = defineTool({
  name: "look",
  description: "Look a customer up.",
  schema: z.object({ name: z.string() }),
  replay: "safe",
  run: ({ name }) => `${name} is a customer`,
});
let sent: string[] = [];
const send = defineTool({
  name: "send",
  description: "Send a quote.",
  schema: z.object({ to: z.string() }),
  run: ({ to }) => {
    sent.push(to);
    return `sent to ${to}`;
  },
});
const agent = defineAgent({
  name: "chat",
  model,
  instructions: "Chat.",
  tools: [hold, look, send],
  middleware: [humanInTheLoop({ interruptOn: { send: true } })],
});

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function serve(): Promise<Server> {
  faux.setResponses([]);
  sent = [];
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  return createServer({
    runtime,
    authenticate: (request) => {
      const id = request.headers.get("x-caller");
      return id ? { id } : undefined;
    },
    agentsFor: () => [agent],
    onError: () => {},
  });
}

/** The AI SDK's own transport, as `useChat` uses it, on the server's handler. */
const transportOf = (server: Server, caller = "matt") =>
  new DefaultChatTransport<ChatMessage>({
    api: "http://que/chat",
    headers: { "x-caller": caller },
    body: { agent: "chat" },
    fetch: (url, init) => server.fetch(new Request(url, init)),
  });

/** Each value of the message a stream builds, as `useChat` builds it, from what the client holds. */
async function read(
  stream: ReadableStream<UIMessageChunk>,
  message?: ChatMessage,
) {
  const values: ChatMessage[] = [];
  for await (const value of readUIMessageStream<ChatMessage>({
    stream,
    ...(message ? { message } : {}),
    terminateOnError: true,
  }))
    values.push(structuredClone(value));
  return values;
}

/** A user message, as `useChat` sends one. */
const said = (id: string, text: string): ChatMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** Send the chat's messages, as `sendMessage` does, and read the reply to the end. */
async function send_(
  server: Server,
  messages: ChatMessage[],
  options: { caller?: string; held?: ChatMessage } = {},
) {
  const stream = await transportOf(server, options.caller).sendMessages({
    chatId: "c",
    messages,
    trigger: "submit-message",
    messageId: undefined,
    abortSignal: undefined,
  });
  return read(stream, options.held);
}

/** The chat's history, as the app loads it. */
async function history(server: Server, caller = "matt") {
  const response = await server.fetch(
    new Request("http://que/chat/c/messages", {
      headers: { "x-caller": caller },
    }),
  );
  return (await response.json()) as { messages: ChatMessage[] };
}

const textOf = (message: ChatMessage | undefined) =>
  (message?.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("");

const answer =
  "The capital of France is Paris, a city on the Seine with a long history.";

describe("the chat surface, with the AI SDK's own client", () => {
  it("streams a run's answer as it is written, and the message is the one history reads back", async () => {
    const server = await serve();
    faux.setResponses([fauxAssistantMessage([fauxText(answer)])]);
    const values = await send_(server, [said("m1", "Capital of France?")]);
    const last = values.at(-1)!;
    expect(last.id).toBe("m1:answer");
    expect(textOf(last)).toBe(answer);
    // More than one piece of the answer reached the client before it was done.
    const lengths = new Set(values.map((value) => textOf(value).length));
    expect(lengths.size).toBeGreaterThan(2);
    expect((await history(server)).messages).toEqual([
      said("m1", "Capital of France?"),
      last,
    ]);
  });

  it("gives a tool call's input, then its output, in its step, and the answer in the next", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("look", { name: "acme" }, { id: "l" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Acme is a customer.")]),
    ]);
    const last = (await send_(server, [said("m1", "Is acme a customer?")])).at(
      -1,
    )!;
    expect(last.parts).toEqual([
      { type: "step-start" },
      {
        type: "dynamic-tool",
        toolName: "look",
        toolCallId: "l",
        state: "output-available",
        input: { name: "acme" },
        output: "acme is a customer",
      },
      { type: "step-start" },
      expect.objectContaining({ type: "text", text: "Acme is a customer." }),
    ]);
    expect((await history(server)).messages.at(-1)).toEqual(last);
  });

  it("asks for an approval, and goes on with the run once addToolApprovalResponse answers it", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("send", { to: "acme" }, { id: "s" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Sent.")]),
    ]);
    const user = said("m1", "Send acme a quote.");
    const asked = (await send_(server, [user])).at(-1)!;
    const call = asked.parts.find((part) => part.type === "dynamic-tool");
    expect(call).toMatchObject({
      state: "approval-requested",
      approval: {
        id: "s:human-in-the-loop:0",
        descriptor: { type: "tool_approval", name: "send" },
      },
    });
    expect(sent).toEqual([]);
    // As addToolApprovalResponse leaves the message, before useChat sends it back.
    const answered = respond(asked, true);
    const last = (await send_(server, [user, answered], { held: answered })).at(
      -1,
    )!;
    expect(sent).toEqual(["acme"]);
    expect(
      last.parts.find((part) => part.type === "dynamic-tool"),
    ).toMatchObject({
      state: "output-available",
      output: "sent to acme",
      approval: { id: "s:human-in-the-loop:0", approved: true },
    });
    expect(textOf(last)).toBe("Sent.");
    expect((await history(server)).messages.at(-1)).toEqual(last);
  });

  it("denies a call the person rejects, with their reason, and its tool never runs", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("send", { to: "acme" }, { id: "s" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Not sent.")]),
    ]);
    const user = said("m1", "Send acme a quote.");
    const asked = (await send_(server, [user])).at(-1)!;
    const answered = respond(asked, false, "too early");
    const last = (await send_(server, [user, answered], { held: answered })).at(
      -1,
    )!;
    expect(sent).toEqual([]);
    expect(
      last.parts.find((part) => part.type === "dynamic-tool"),
    ).toMatchObject({
      state: "output-denied",
      approval: { approved: false, reason: "too early" },
    });
    expect((await history(server)).messages.at(-1)).toEqual(last);
  });

  it("replays the run going on to a client that reconnects, then goes on live, and gives 204 once none goes on", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText(answer)]),
    ]);
    const going = holding();
    const first = send_(server, [said("m1", "Hold.")]);
    await going;
    const transport = transportOf(server);
    const resumed = await transport.reconnectToStream({ chatId: "c" });
    expect(resumed).not.toBeNull();
    release();
    const replayed = (await read(resumed!)).at(-1)!;
    const live = (await first).at(-1)!;
    expect(replayed).toEqual(live);
    expect(textOf(replayed)).toBe(answer);
    expect(await transport.reconnectToStream({ chatId: "c" })).toBeNull();
  });

  it("stops the run going on: the stream ends aborted, and the run is stopped", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Too late.")]),
    ]);
    const going = holding();
    const stream = transportOf(server).sendMessages({
      chatId: "c",
      messages: [said("m1", "Hold.")],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
    });
    await going;
    const stop = await server.fetch(
      new Request("http://que/chat/c/stop", {
        method: "POST",
        headers: { "x-caller": "matt", "content-type": "application/json" },
        body: JSON.stringify({ runId: "m1" }),
      }),
    );
    expect(await stop.json()).toEqual({ stopped: true });
    const chunks: UIMessageChunk[] = [];
    for await (const chunk of await stream) chunks.push(chunk);
    expect(chunks.at(-1)).toEqual({ type: "abort", reason: "stopped" });
    expect(await runtime!.runOf("c", "m1")).toMatchObject({
      status: "stopped",
    });
  });

  it("refuses what a chat cannot do, before any stream starts", async () => {
    const server = await serve();
    const post = (body: object, caller = "matt") =>
      server.fetch(
        new Request("http://que/chat", {
          method: "POST",
          headers: { "x-caller": caller, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    const refused = async (response: Response) => [
      response.status,
      ((await response.json()) as { error: { code: string } }).error.code,
    ];
    const message = said("m1", "Hi.");
    const base = {
      id: "c",
      trigger: "submit-message",
      agent: "chat",
      messages: [message],
    };
    expect(
      await refused(await post({ ...base, trigger: "regenerate-message" })),
    ).toEqual([400, "regenerate_not_supported"]);
    expect(
      await refused(
        await post({
          ...base,
          messages: [
            {
              id: "m1",
              role: "user",
              parts: [{ type: "file", url: "x", mediaType: "image/png" }],
            },
          ],
        }),
      ),
    ).toEqual([400, "bad_request"]);
    expect(await refused(await post({ ...base, agent: undefined }))).toEqual([
      400,
      "bad_request",
    ]);
    expect(
      await refused(
        await post({
          ...base,
          messages: [{ id: "a", role: "assistant", parts: [] }],
        }),
      ),
    ).toEqual([400, "bad_request"]);
    // Made by matt: sam finds no conversation of the key, and matt finds it waits on nothing.
    faux.setResponses([fauxAssistantMessage([fauxText("Hi.")])]);
    await send_(server, [message]);
    for (const path of ["/chat/c/stream", "/chat/c/messages"]) {
      const hidden = await server.fetch(
        new Request(`http://que${path}`, { headers: { "x-caller": "sam" } }),
      );
      expect(await refused(hidden)).toEqual([404, "conversation_not_found"]);
    }
    expect(await refused(await post(base, "sam"))).toEqual([
      404,
      "conversation_not_found",
    ]);
    expect(
      await refused(
        await post({
          ...base,
          messages: [
            message,
            respond(
              {
                id: "m1:answer",
                role: "assistant",
                parts: [
                  {
                    type: "dynamic-tool",
                    toolName: "send",
                    toolCallId: "s",
                    state: "approval-requested",
                    input: {},
                    approval: { id: "s:human-in-the-loop:0" },
                  },
                ],
              },
              true,
            ),
          ],
        }),
      ),
    ).toEqual([409, "not_interrupted"]);
    const stop = await server.fetch(
      new Request("http://que/chat/c/stop", {
        method: "POST",
        headers: { "x-caller": "matt", "content-type": "application/json" },
        body: JSON.stringify({ runId: "nope" }),
      }),
    );
    expect(await refused(stop)).toEqual([404, "run_not_found"]);
  });

  it("refuses a message while a run goes on (422), and queues one sent with whenBusy followUp", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("One.")]),
      fauxAssistantMessage([fauxText("Two.")]),
    ]);
    const going = holding();
    const first = send_(server, [said("m1", "One.")]);
    await going;
    const busy = await server.fetch(
      new Request("http://que/chat", {
        method: "POST",
        headers: { "x-caller": "matt", "content-type": "application/json" },
        body: JSON.stringify({
          id: "c",
          trigger: "submit-message",
          messages: [said("m2", "Two.")],
        }),
      }),
    );
    expect(busy.status).toBe(422);
    const second = transportOf(server).sendMessages({
      chatId: "c",
      messages: [said("m2", "Two.")],
      trigger: "submit-message",
      messageId: undefined,
      abortSignal: undefined,
      body: { whenBusy: "followUp" },
    });
    release();
    expect(textOf((await first).at(-1))).toBe("One.");
    expect(textOf((await read(await second)).at(-1))).toBe("Two.");
    expect(
      (await history(server)).messages.map((message) => message.id),
    ).toEqual(["m1", "m1:answer", "m2", "m2:answer"]);
  });
});

describe("the LangGraph routes for a conversation's runs", () => {
  it("list its runs, read one, and cancel one, for the caller only", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("hold", {}, { id: "h" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Too late.")]),
    ]);
    const going = holding();
    void send_(server, [said("m1", "Hold.")]).catch(() => {});
    await going;
    const get = (path: string, caller = "matt") =>
      server.fetch(
        new Request(`http://que${path}`, { headers: { "x-caller": caller } }),
      );
    expect(await (await get("/conversations/c/runs")).json()).toEqual({
      items: [expect.objectContaining({ runId: "m1", status: "running" })],
    });
    expect(await (await get("/conversations/c/runs/m1")).json()).toMatchObject({
      runId: "m1",
      status: "running",
      entries: { first: expect.any(Number) },
    });
    expect((await get("/conversations/c/runs/m9")).status).toBe(404);
    expect((await get("/conversations/c/runs", "sam")).status).toBe(404);
    const cancel = (runId: string) =>
      server.fetch(
        new Request(`http://que/conversations/c/runs/${runId}/cancel`, {
          method: "POST",
          headers: { "x-caller": "matt" },
        }),
      );
    expect(await (await cancel("m1")).json()).toEqual({ stopped: true });
    await expect
      .poll(
        async () =>
          (await (await get("/conversations/c/runs/m1")).json()) as {
            status: string;
          },
      )
      .toMatchObject({ status: "stopped" });
    expect(await (await cancel("m1")).json()).toEqual({ stopped: false });
  });
});

describe("a message's diff", () => {
  /** A client's message after the chunks: the AI SDK's own reader applies them. */
  async function applied(messageId: string, values: ChatPart[][]) {
    const diff = new MessageDiff(messageId);
    const chunks: UIMessageChunk[] = [{ type: "start", messageId }];
    for (const parts of values) chunks.push(...diff.next(parts));
    chunks.push(...diff.end(), { type: "finish" });
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    return { chunks, message: (await read(stream)).at(-1)! };
  }

  it("brings the client's message to each value, and replaces a step pi retried with reset-step", async () => {
    const step: ChatPart = { type: "step-start" };
    const { chunks, message } = await applied("m", [
      [step, { type: "text", text: "Hel", state: "streaming" }],
      // The attempt failed and pi tried again: the step's text is new, not grown.
      [step, { type: "text", text: "Bon", state: "streaming" }],
      [step, { type: "text", text: "Bonjour.", state: "done" }],
    ]);
    expect(chunks.filter((chunk) => chunk.type === "reset-step")).toHaveLength(
      1,
    );
    expect(message.parts).toEqual([
      step,
      { type: "text", text: "Bonjour.", state: "done" },
    ]);
  });

  it("refuses a value that changes a step before the one being written", async () => {
    const diff = new MessageDiff("m");
    diff.next([
      { type: "step-start" },
      { type: "text", text: "One.", state: "done" },
      { type: "step-start" },
    ]);
    expect(() =>
      diff.next([
        { type: "step-start" },
        { type: "text", text: "Two.", state: "done" },
        { type: "step-start" },
      ]),
    ).toThrow(/changed before the step being written/);
  });
});

/** A message as `addToolApprovalResponse` leaves it: each call that waits, answered. */
function respond(
  message: ChatMessage,
  approved: boolean,
  reason?: string,
): ChatMessage {
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "dynamic-tool" && part.state === "approval-requested"
        ? {
            ...part,
            state: "approval-responded",
            approval: {
              ...part.approval,
              approved,
              ...(reason === undefined ? {} : { reason }),
            },
          }
        : part,
    ),
  } as ChatMessage;
}
