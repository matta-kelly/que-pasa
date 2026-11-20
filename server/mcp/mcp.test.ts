import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Caller,
  type Json,
  defineAgent,
  defineConnection,
  defineTool,
  withImages,
} from "../../define/index.ts";
import { memoryFiles } from "../../files/index.ts";
import { openRuntime, type Runtime } from "../../loop/index.ts";
import { scripted } from "../../loop/scripted.fixture.ts";
import { humanInTheLoop } from "../../middleware/index.ts";
import { createServer, type Server } from "../index.ts";

const { faux, models, model } = scripted();

/** A tool that holds its call until the test lets it go, so a run stays going; it keeps the signal its call got. */
let release = () => {};
let held = () => {};
let signal: AbortSignal | undefined;
const holding = () => new Promise<void>((resolve) => (held = resolve));
const hold = defineTool({
  name: "hold",
  description: "Hold.",
  schema: z.object({}),
  run: (_input, runtime) =>
    new Promise<string>((resolve) => {
      signal = runtime.signal;
      release = () => resolve("held");
      held();
    }),
});
let sent = 0;
const send = defineTool({
  name: "send",
  description: "Send a quote.",
  schema: z.object({}),
  run: () => {
    sent += 1;
    return "sent";
  },
});
/** A service each caller logs into with their own token. */
const crm = defineConnection({
  name: "crm",
  owner: "user",
  credential: z.object({ token: z.string() }),
  connect: ({ token }) => ({ who: token }),
});
const whoAmI = defineTool({
  name: "who_am_i",
  description: "Say who the CRM knows you as.",
  schema: z.object({}),
  uses: [crm],
  run: async (_input, runtime) => (await runtime.use(crm)).who,
});

const geo = defineAgent({
  name: "geo",
  description: "Answers questions about places.",
  model,
  instructions: "Answer briefly.",
  tools: [hold],
});
const judge = defineAgent({
  name: "judge",
  description: "Judges a piece of work.",
  model,
  instructions: "Judge.",
  tools: [],
  output: z.object({ verdict: z.enum(["done", "raise"]) }),
});
const seller = defineAgent({
  name: "seller",
  model,
  instructions: "Sell.",
  tools: [whoAmI],
});
const mailer = defineAgent({
  name: "mailer",
  model,
  instructions: "Send quotes.",
  tools: [send],
  middleware: [
    humanInTheLoop({
      interruptOn: { send: { description: "Send the quote to the customer" } },
    }),
  ],
});

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

/** A server on a fresh runtime, which gives owner every agent and stranger only geo. */
async function serve(): Promise<Server> {
  faux.setResponses([]);
  sent = 0;
  signal = undefined;
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [geo, judge, seller, mailer, printer],
    files: memoryFiles(),
    credentialFor: () => undefined,
  });
  return createServer({
    runtime,
    authenticate: (request) => {
      const id = request.headers.get("x-caller");
      return id ? { id } : undefined;
    },
    agentsFor: (caller: Caller) =>
      caller.id === "owner"
        ? [geo, judge, seller, mailer]
        : caller.id === "printer"
          ? [printer]
          : [geo],
    connectUrl: ({ connection }) => `/connections#${connection.name}`,
    onError: () => {},
  });
}

/** A tool that renders a barcode: a PNG for the person, a line for the model. */
const render = defineTool({
  name: "render",
  description: "Render a barcode.",
  schema: z.object({}),
  run: () =>
    withImages("Rendered.", [
      {
        name: "a.png",
        mediaType: "image/png",
        data: new Uint8Array([137, 80, 78, 71]),
      },
    ]),
});
const printer = defineAgent({
  name: "printer",
  model,
  instructions: "Print.",
  tools: [render],
});

/** The two eras of the protocol a client speaks: 2026-07-28, stateless, and a 2025 client's handshake. */
const eras = [
  ["2026-07-28", { pin: "2026-07-28" }],
  ["2025", "legacy"],
] as const;

/** The MCP SDK's own client, on the server's handler, as the caller. */
async function connect(
  server: Server,
  {
    caller = "owner",
    era = eras[0][1],
  }: { caller?: string; era?: (typeof eras)[number][1] } = {},
) {
  const client = new Client(
    { name: "test", version: "1" },
    { versionNegotiation: { mode: era } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://que/mcp"), {
      fetch: (url, init) => server.fetch(new Request(url, init)),
      requestInit: { headers: { "x-caller": caller } },
    }),
  );
  return client;
}

/** The text of a tool's result. */
const textOf = (result: { content?: unknown }) =>
  (result.content as { type: string; text?: string }[])
    .map((block) => block.text ?? "")
    .join("");

const says = (text: string) => fauxAssistantMessage([fauxText(text)]);
const calls = (name: string, args: { [key: string]: Json } = {}) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

/** The owner's request, as the server's operations take it. */
const owner = () =>
  new Request("http://que/", { headers: { "x-caller": "owner" } });

describe.each(eras)("an MCP client speaking %s", (_name, era) => {
  it("gets one tool per agent it is given, each taking one text, and an agent's output as the tool's", async () => {
    const server = await serve();
    const client = await connect(server, { era });
    expect(client.getServerVersion()?.name).toBe("@mku1tra/que-pasa");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "geo",
      "judge",
      "seller",
      "mailer",
    ]);
    const [geoTool, judgeTool] = tools;
    expect(geoTool).toMatchObject({
      description: "Answers questions about places.",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
    });
    expect(geoTool).not.toHaveProperty("outputSchema");
    expect(judgeTool?.outputSchema).toMatchObject({
      properties: { verdict: { enum: ["done", "raise"] } },
    });
    const theirs = await (
      await connect(server, { caller: "stranger", era })
    ).listTools();
    expect(theirs.tools.map((tool) => tool.name)).toEqual(["geo"]);
  });

  it("gives the images the run's tools made as image content, after the answer", async () => {
    const server = await serve();
    const client = await connect(server, { era, caller: "printer" });
    faux.setResponses([calls("render"), says("Printed.")]);
    const result = await client.callTool({
      name: "printer",
      arguments: { input: "Print." },
    });
    expect(result.content).toEqual([
      { type: "text", text: "Printed." },
      {
        type: "image",
        data: Buffer.from([137, 80, 78, 71]).toString("base64"),
        mimeType: "image/png",
      },
    ]);
  });

  it("runs the agent once per call, each on a conversation of its own, kept in the caller's history", async () => {
    const server = await serve();
    const client = await connect(server, { era });
    faux.setResponses([says("Paris."), says("Rome.")]);
    const first = await client.callTool({
      name: "geo",
      arguments: { input: "Capital of France?" },
    });
    const second = await client.callTool({
      name: "geo",
      arguments: { input: "Capital of Italy?" },
    });
    expect([textOf(first), textOf(second)]).toEqual(["Paris.", "Rome."]);
    expect(first.isError).toBeFalsy();
    const { items } = await server.conversations(owner());
    expect(items).toHaveLength(2);
    for (const conversation of items) {
      expect(conversation).toMatchObject({ agent: "geo", status: "idle" });
      const runs = await server.runs(owner(), conversation.conversation);
      expect(runs.items).toEqual([
        expect.objectContaining({
          runId: conversation.conversation,
          status: "done",
        }),
      ]);
    }
  });

  it("sends progress while a run goes on", async () => {
    const server = await serve();
    const client = await connect(server, { era });
    faux.setResponses([calls("hold"), says("Done.")]);
    const going = holding();
    const progress: number[] = [];
    const result = client.callTool(
      { name: "geo", arguments: { input: "Hold." } },
      { onprogress: ({ progress: at }) => progress.push(at) },
    );
    await going;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    release();
    expect(textOf(await result)).toBe("Done.");
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
  });
});

describe("an MCP call", () => {
  it("gives an agent's output as the tool's structured result, and as its text", async () => {
    const server = await serve();
    faux.setResponses([calls("submit", { verdict: "done" })]);
    const result = await (
      await connect(server)
    ).callTool({ name: "judge", arguments: { input: "Judge this." } });
    expect(result.structuredContent).toEqual({ verdict: "done" });
    expect(JSON.parse(textOf(result))).toEqual({ verdict: "done" });
  });

  it("with no login for a connection the agent uses: says where to connect it, and keeps nothing", async () => {
    const server = await serve();
    const before = faux.state.callCount;
    const result = await (
      await connect(server)
    ).callTool({ name: "seller", arguments: { input: "Who am I?" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "No login for crm (connect it at http://que/connections#crm). Connect it, then call again. Nothing ran.",
    );
    expect(faux.state.callCount).toBe(before);
    expect((await server.conversations(owner())).items).toEqual([]);
  });

  it("that asks a person for an approval: fails before the tool acts, and says what it asked", async () => {
    const server = await serve();
    faux.setResponses([calls("send"), says("Sent.")]);
    const result = await (
      await connect(server)
    ).callTool({ name: "mailer", arguments: { input: "Send the quote." } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "The agent stopped to ask a person: Send the quote to the customer. Nobody can answer over MCP, so the step that asked did not run.",
    );
    expect(sent).toBe(0);
    const [conversation] = (await server.conversations(owner())).items;
    expect(
      (await server.runs(owner(), conversation!.conversation)).items,
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        failure: expect.objectContaining({ reason: "needs_answer" }),
      }),
    ]);
  });

  it("that the client cancels: stops its run, as a person's stop does, and the tool's signal aborts", async () => {
    const server = await serve();
    const client = await connect(server);
    faux.setResponses([calls("hold"), says("Too late.")]);
    const going = holding();
    const cancel = new AbortController();
    const result = client.callTool(
      { name: "geo", arguments: { input: "Hold." } },
      { signal: cancel.signal },
    );
    await going;
    cancel.abort();
    await expect(result).rejects.toThrow();
    const [conversation] = (await server.conversations(owner())).items;
    await expect
      .poll(async () =>
        (await server.runs(owner(), conversation!.conversation)).items.map(
          (run) => run.status,
        ),
      )
      .toEqual(["stopped"]);
    expect(signal?.aborted).toBe(true);
    expect(
      await server.conversation(owner(), conversation!.conversation),
    ).toMatchObject({ status: "idle" });
  });

  it("whose run fails: gives why, as a result the model reads", async () => {
    const server = await serve();
    faux.setResponses([says("Done."), says("Done."), says("Done.")]);
    const result = await (
      await connect(server)
    ).callTool({ name: "judge", arguments: { input: "Judge this." } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^The run failed \(no_submit\): /);
  });

  it("of an agent the caller is not given: is refused as an unknown tool", async () => {
    const server = await serve();
    const client = await connect(server, { caller: "stranger" });
    await expect(
      client.callTool({ name: "judge", arguments: { input: "Judge." } }),
    ).rejects.toThrow(/judge/);
  });
});

describe("the /mcp route", () => {
  const post = (headers: Record<string, string>) =>
    new Request("http://que/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });

  it("refuses a request with no caller, as every route does (401)", async () => {
    const server = await serve();
    const response = await server.fetch(post({}));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "unauthenticated",
        message: "who is calling is not known",
      },
    });
  });

  it("refuses a page on another site (403), and takes one on its own", async () => {
    const server = await serve();
    const away = await server.fetch(
      post({ "x-caller": "owner", origin: "https://elsewhere.example" }),
    );
    expect(away.status).toBe(403);
    const home = await server.fetch(
      post({ "x-caller": "owner", origin: "http://que" }),
    );
    expect(home.status).not.toBe(403);
  });

  it("keeps no stream to take up, and no session to end (405)", async () => {
    const server = await serve();
    for (const method of ["GET", "DELETE"]) {
      const response = await server.fetch(
        new Request("http://que/mcp", {
          method,
          headers: { "x-caller": "owner", accept: "text/event-stream" },
        }),
      );
      expect(response.status).toBe(405);
    }
  });
});
