import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Caller,
  defineAgent,
  defineConnection,
  defineTool,
  type Runtime,
} from "../define/index.ts";
import { openRuntime, type Runtime as Loop } from "../loop/index.ts";
import { scripted } from "../loop/scripted.fixture.ts";
import {
  createServer,
  Refused,
  type Server,
  ServerError,
  type ServerOptions,
} from "./index.ts";

const { faux, models, model } = scripted();

/** A tool that waits until the test lets it go, so a run stays going. */
let release = () => {};
let started = () => {};
const wait = defineTool({
  name: "wait",
  description: "Wait.",
  schema: z.object({}),
  run: () =>
    new Promise<string>((resolve) => {
      release = () => resolve("waited");
      started();
    }),
});
/** A tool that says the context its conversation was made with. */
const where = defineTool({
  name: "where",
  description: "Say where.",
  schema: z.object({}),
  run: (_input, runtime: Runtime<{ root: string } | undefined>) =>
    runtime.context?.root ?? "nowhere",
});

const geo = defineAgent({
  name: "geo",
  description: "Answers questions about places.",
  model,
  instructions: "Answer briefly.",
  tools: [wait, where],
});
const judge = defineAgent({
  name: "judge",
  model,
  instructions: "Judge.",
  tools: [],
  output: z.object({ verdict: z.enum(["done", "raise"]) }),
});
/** A service each caller logs into with their own token. */
const crm = defineConnection({
  name: "crm",
  description: "The CRM, as you.",
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
const seller = defineAgent({
  name: "seller",
  model,
  instructions: "Sell.",
  tools: [whoAmI],
});
/** The CRM logins the deployment holds, by caller. */
const logins = new Map<string, string>();

const secret = defineAgent({
  name: "secret",
  model,
  instructions: "Keep it.",
  tools: [],
});

/** Who a request is from: the test's stand-in for a deployment's login, a header. */
const as = (id: string) => ({ "x-caller": id });

let loop: Loop | undefined;
/** The model calls since the test's server opened. */
let base = 0;
const calls = () => faux.state.callCount - base;
afterEach(async () => {
  await loop?.close();
  loop = undefined;
});

/** A server on a fresh runtime, with a deployment that gives matt geo and judge, and sam only geo. */
async function serve(
  options: Partial<Omit<ServerOptions, "runtime">> = {},
): Promise<Server> {
  faux.setResponses([]);
  base = faux.state.callCount;
  loop = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [geo, judge, secret, seller],
    credentialFor: ({ caller }) => {
      const token = logins.get(caller.id);
      return token ? { token } : undefined;
    },
  });
  return createServer({
    runtime: loop,
    authenticate: (request) => {
      const id = request.headers.get("x-caller");
      return id ? { id } : undefined;
    },
    agentsFor: (caller: Caller) =>
      caller.id === "matt" ? [geo, judge, seller] : [geo],
    onError: () => {},
    ...options,
  });
}

/** POST a run and wait. */
function wait_(
  server: Server,
  conversation: string,
  body: object,
  caller = "matt",
) {
  return server.fetch(
    new Request(
      `http://que/conversations/${encodeURIComponent(conversation)}/runs/wait`,
      {
        method: "POST",
        headers: { ...as(caller), "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

const asks = (runId: string, input = "Capital of France?", agent = "geo") => ({
  agent,
  runId,
  input,
});
const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

describe("the server's HTTP API", () => {
  it("answers /ok with no login, and refuses any other route with none (401)", async () => {
    const server = await serve();
    const ok = await server.fetch(new Request("http://que/ok"));
    expect(await ok.json()).toEqual({ ok: true });
    const agents = await server.fetch(new Request("http://que/agents"));
    expect(agents.status).toBe(401);
    expect(await errorOf(agents)).toBe("unauthenticated");
  });

  it("lists the agents the caller is given, with their descriptions", async () => {
    const server = await serve();
    const list = await server.fetch(
      new Request("http://que/agents", { headers: as("matt") }),
    );
    expect(await list.json()).toEqual({
      agents: [
        { name: "geo", description: "Answers questions about places." },
        { name: "judge" },
        { name: "seller" },
      ],
    });
  });

  it("runs an input on a conversation and gives back its result, and the conversation keeps its history", async () => {
    const server = await serve();
    const requests: number[] = [];
    const answer = (text: string) => (context: { messages: Message[] }) => {
      requests.push(context.messages.filter((m) => m.role === "user").length);
      return fauxAssistantMessage([fauxText(text)]);
    };
    faux.setResponses([answer("Paris."), answer("Rome.")]);
    const first = await wait_(server, "cl-42/geo", asks("1"));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      conversation: "cl-42/geo",
      runId: "1",
      status: "done",
      result: "Paris.",
    });
    const second = await wait_(server, "cl-42/geo", asks("2", "And Italy?"));
    expect(await second.json()).toMatchObject({ result: "Rome." });
    expect(requests).toEqual([1, 2]);
  });

  it("gives back an agent's output, and the same run id again gives the same result with no model call", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit", { verdict: "done" })], {
        stopReason: "toolUse",
      }),
    ]);
    const body = asks("1", "Judge this.", "judge");
    const first = await wait_(server, "c", body);
    expect(await first.json()).toMatchObject({ result: { verdict: "done" } });
    const again = await wait_(server, "c", body);
    expect(await again.json()).toMatchObject({ result: { verdict: "done" } });
    expect(calls()).toBe(1);
  });

  it("refuses before the run: a bad body (400), an agent not given (404), another caller's conversation (404), another agent (409)", async () => {
    const server = await serve();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const bad = await wait_(server, "c", { agent: "geo", input: "Hi" });
    expect([bad.status, await errorOf(bad)]).toEqual([400, "bad_request"]);
    const hidden = await wait_(server, "c", asks("1", "Hi", "secret"));
    expect([hidden.status, await errorOf(hidden)]).toEqual([
      404,
      "agent_not_found",
    ]);
    const notGiven = await wait_(server, "c", asks("1", "Hi", "judge"), "sam");
    expect(notGiven.status).toBe(404);
    await (await wait_(server, "c", asks("1"))).json();
    const other = await wait_(server, "c", asks("2"), "sam");
    expect([other.status, await errorOf(other)]).toEqual([
      404,
      "conversation_not_found",
    ]);
    const otherAgent = await wait_(server, "c", asks("2", "Hi", "judge"));
    expect([otherAgent.status, await errorOf(otherAgent)]).toEqual([
      409,
      "other_agent",
    ]);
    expect(calls()).toBe(1);
  });

  it("refuses a run while another goes on (422), and keeps a long run alive with newlines before its result", async () => {
    const server = await serve();
    const going = new Promise<void>((resolve) => (started = resolve));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const first = await wait_(server, "c", asks("1", "Wait."));
    expect(first.status).toBe(200);
    await going;
    const busy = await wait_(server, "c", asks("2"));
    expect([busy.status, await errorOf(busy)]).toEqual([422, "busy"]);
    setTimeout(() => release(), 1500);
    const text = await first.text();
    expect(text.startsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ status: "done", result: "Done." });
  });

  it("queues an input sent with whenBusy followUp, and answers it with its own outcome after the run before it", async () => {
    const server = await serve();
    const going = new Promise<void>((resolve) => (started = resolve));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Paris.")]),
    ]);
    const first = await wait_(server, "c", asks("1", "Wait."));
    await going;
    const queued = wait_(server, "c", {
      ...asks("2"),
      whenBusy: "followUp",
    });
    const bad = await wait_(server, "c", {
      agent: "geo",
      runId: "3",
      whenBusy: "steer",
      command: { resume: {} },
    });
    expect([bad.status, await errorOf(bad)]).toEqual([400, "bad_request"]);
    release();
    expect(JSON.parse(await first.text())).toMatchObject({
      status: "done",
      result: "Done.",
    });
    const second = await queued;
    expect(second.status).toBe(200);
    expect(JSON.parse(await second.text())).toMatchObject({
      runId: "2",
      status: "done",
      result: "Paris.",
    });
  });

  it("makes a conversation with the context the deployment gives, and refuses with 403 when its hook throws Refused", async () => {
    const server = await serve({
      contextFor: ({ caller, conversation }) => {
        if (conversation === "locked") throw new Refused("not this one");
        return { root: `/home/${caller.id}` };
      },
    });
    let seen = "";
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("where", {})], {
        stopReason: "toolUse",
      }),
      (context: { messages: Message[] }) => {
        seen = JSON.stringify(
          context.messages.find((m) => m.role === "toolResult")?.content,
        );
        return fauxAssistantMessage([fauxText("Found it.")]);
      },
    ]);
    await (await wait_(server, "c", asks("1", "Where?"))).json();
    expect(seen).toContain("/home/matt");
    const locked = await wait_(server, "locked", asks("1"));
    expect([locked.status, await errorOf(locked)]).toEqual([403, "forbidden"]);
  });

  it("answers 200 with the failure for a run that fails after it started", async () => {
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const failed = await wait_(server, "c", asks("1", "Judge.", "judge"));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({
      status: "failed",
      error: { code: "no_submit" },
    });
  });

  it("answers interrupted when a call needs a login, with the deployment's page; the answer goes on at that call", async () => {
    logins.clear();
    const server = await serve({
      connectUrl: ({ connection, caller }) =>
        `https://dash/connect/${connection.name}?for=${caller.id}`,
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("who_am_i", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("You are matt-at-crm.")]),
    ]);
    const asked = await wait_(server, "c", asks("1", "Who am I?", "seller"));
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({
      conversation: "c",
      runId: "1",
      status: "interrupted",
      interrupts: [
        {
          id: "call-1:connection-crm:0",
          value: {
            type: "connection",
            name: "crm",
            description: "The CRM, as you.",
            owner: "user",
            connectUrl: "https://dash/connect/crm?for=matt",
          },
        },
      ],
    });
    expect(calls()).toBe(1);
    // Busy while it waits: the person answers first.
    const other = await wait_(server, "c", asks("2", "Hi", "seller"));
    expect([other.status, await errorOf(other)]).toEqual([422, "busy"]);
    logins.set("matt", "matt-at-crm");
    const done = await wait_(server, "c", {
      agent: "seller",
      runId: "1",
      command: { resume: { "call-1:connection-crm:0": "connected" } },
    });
    expect(await done.json()).toMatchObject({
      status: "done",
      result: "You are matt-at-crm.",
    });
    expect(calls()).toBe(2);
    const late = await wait_(server, "c", {
      agent: "seller",
      runId: "1",
      command: { resume: { "call-1:connection-crm:0": "again" } },
    });
    expect([late.status, await errorOf(late)]).toEqual([
      409,
      "not_interrupted",
    ]);
  });

  it("answers 404 for a route it does not have", async () => {
    const server = await serve();
    const none = await server.fetch(
      new Request("http://que/threads", { headers: as("matt") }),
    );
    expect([none.status, await errorOf(none)]).toEqual([404, "not_found"]);
  });
});

describe("the server's operations, for a way in in the same process", () => {
  const request = (caller?: string) =>
    new Request("http://que/mcp", { headers: caller ? as(caller) : {} });

  it("list the caller's agents, and run to the outcome as the routes do", async () => {
    const server = await serve();
    expect(await server.agents(request("sam"))).toEqual([
      { name: "geo", description: "Answers questions about places." },
    ]);
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    await expect(
      server.run(request("matt"), "geo", {
        conversation: "c",
        runId: "1",
        input: "Capital of France?",
      }),
    ).resolves.toEqual({ status: "done", result: "Paris." });
  });

  it("give interrupted as an outcome, with no link when the deployment gives none, and resume with the answers", async () => {
    logins.clear();
    const server = await serve();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("who_am_i", {}, { id: "call-1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("You are matt-at-crm.")]),
    ]);
    await expect(
      server.run(request("matt"), "seller", {
        conversation: "c",
        runId: "1",
        input: "Who am I?",
      }),
    ).resolves.toEqual({
      status: "interrupted",
      interrupts: [
        {
          id: "call-1:connection-crm:0",
          value: {
            type: "connection",
            name: "crm",
            description: "The CRM, as you.",
            owner: "user",
          },
        },
      ],
    });
    logins.set("matt", "matt-at-crm");
    await expect(
      server.run(request("matt"), "seller", {
        conversation: "c",
        runId: "1",
        resume: { "call-1:connection-crm:0": null },
      }),
    ).resolves.toEqual({ status: "done", result: "You are matt-at-crm." });
  });

  it("throw the same refusals, as ServerError with the route's status and code", async () => {
    const server = await serve();
    const refused = (caller: string | undefined, agent: string) =>
      server
        .run(request(caller), agent, {
          conversation: "c",
          runId: "1",
          input: "Hi",
        })
        .catch((error: unknown) => error);
    const none = await refused(undefined, "geo");
    expect(none).toBeInstanceOf(ServerError);
    expect(none).toMatchObject({ status: 401, code: "unauthenticated" });
    expect(await refused("sam", "judge")).toMatchObject({
      status: 404,
      code: "agent_not_found",
    });
  });

  it("call onKeepAlive while a run goes on, and stop the run when the client's signal aborts", async () => {
    const server = await serve();
    const going = new Promise<void>((resolve) => (started = resolve));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Too late.")]),
    ]);
    const stop = new AbortController();
    let alive = 0;
    const outcome = server.run(
      request("matt"),
      "geo",
      { conversation: "c", runId: "1", input: "Wait." },
      { signal: stop.signal, onKeepAlive: () => (alive += 1) },
    );
    await going;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    stop.abort();
    release();
    await expect(outcome).resolves.toMatchObject({
      status: "failed",
      error: { code: "aborted" },
    });
    expect(alive).toBeGreaterThanOrEqual(1);
    expect(calls()).toBe(1);
  });
});
