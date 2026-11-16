/**
 * The server: a deployment's agents, reached from outside its process, after LangGraph's Agent Server. It asks the
 * deployment who is calling, which agents they are given and what context a conversation has, then runs the agent on
 * the deployment's runtime. Its HTTP API is LangGraph's routes in pi's words, with two surfaces on the same runs: the
 * AI SDK's chat at `/chat`, and MCP at `/mcp`. Its operations serve a way in that lives in the same process, such as a
 * Slack app.
 */
import type {
  Cursor,
  EntryId,
  EntryRecord,
  Page,
} from "@earendil-works/pi-durable";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { z } from "zod";
import {
  type Agent,
  type Caller,
  type Connection,
  type Interrupt,
  isConnection,
  type Json,
} from "../define/index.ts";
import {
  type ConnectionQuestion,
  type ConversationInfo as Kept,
  type RunInfo,
  RunFailed,
  RunRefused,
  type Runtime,
  type WhenBusy,
} from "../loop/index.ts";

import { chatRoutes } from "./chat/routes.ts";
import { mcpRoutes } from "./mcp/routes.ts";
import { shownInfo } from "./questions.ts";
import { Refused, ServerError } from "./errors.ts";
import {
  badRead,
  checkLimit,
  CursorParam,
  Limit,
  pageOut,
  paramsOf,
} from "./page.ts";

export { Refused, ServerError };

/** Any agent, as a deployment gives it. */
export type AnyAgent = Agent<z.ZodObject | undefined, Json | undefined>;

/** What a deployment answers for the server. */
export type ServerOptions = {
  /** The deployment's runtime, from `openRuntime`: the deployment opens and closes it. */
  runtime: Runtime;
  /** Who is calling: the caller, or undefined to refuse the request (401). */
  authenticate: (
    request: Request,
  ) => Caller | undefined | Promise<Caller | undefined>;
  /** The agents the caller is given, from the runtime's agents. */
  agentsFor: (
    caller: Caller,
  ) => readonly AnyAgent[] | Promise<readonly AnyAgent[]>;
  /**
   * The context a conversation is made with, from who is calling, the agent and the conversation's key; none when left
   * out. The request is there for a deployment that lets a client ask for something; it may throw `Refused`. A run gives
   * the same context every time, or it is refused (409 `other_context`).
   */
  contextFor?: (call: {
    caller: Caller;
    agent: AnyAgent;
    conversation: string;
    request: Request;
  }) => Json | undefined | Promise<Json | undefined>;
  /**
   * Where a person connects a connection: the deployment's page, from its control plane. Given with a run's question
   * that asks for a login the caller has not given; left out, none is.
   */
  connectUrl?: (request: {
    connection: Connection;
    caller: Caller;
  }) => string | undefined | Promise<string | undefined>;
  /** Where an error the server did not expect is reported; `console.error` by default. */
  onError?: (error: unknown) => void;
};

/** An agent as a caller sees it. Its input is always one text message. */
export type AgentInfo = { name: string; description?: string };

/**
 * What a client asks for, by its own run id: one input on a conversation, or answers to the run's questions, by their
 * ids, as LangGraph's `Command(resume)`.
 */
export type RunRequest = { conversation: string; runId: string } & (
  | {
      input: string;
      /**
       * What the input does when a run goes on on the conversation, pi's `whenBusy`: `reject` (the default, 422 `busy`),
       * `followUp` (queued, to run after it) or `steer` (joined to it, at its next step). LangGraph's `multitask_strategy`.
       */
      whenBusy?: WhenBusy;
      resume?: never;
    }
  | { resume: Record<string, Json>; input?: never; whenBusy?: never }
);

/**
 * How a run stands: done with its result (the agent's text, or its output), failed with pi's reason or `no_submit`, or
 * interrupted, waiting on its questions. A question that asks for a login carries the deployment's `connectUrl`.
 */
export type RunOutcome =
  | { status: "done"; result: unknown }
  | {
      status: "failed";
      error: { code: string; message: string };
      /** The questions a run nobody attends stopped on, as MCP's runs: `needs_connection` or `needs_answer`. */
      interrupts?: Interrupt[];
    }
  | { status: "interrupted"; interrupts: Interrupt[] };

/** How a client in the same process follows a run. */
export type RunControl = {
  /** Stops the run when it aborts. Left out, the run goes on whatever the client does, and the same run id gives its result. */
  signal?: AbortSignal;
  /** Called each second while the run goes on: for a client that must show it is alive, such as a progress bar. */
  onKeepAlive?: () => void;
};

/**
 * A conversation as a client reads it, LangGraph's thread: its agent, how it stands (`idle`, `busy`, `interrupted` or
 * `error`), the run going on, the questions it waits on, and why its newest run failed. Who it acts for and its context
 * are the deployment's, and not given.
 */
export type ConversationInfo = Omit<Kept, "caller" | "context">;

/** Which of the caller's conversations to read: the newest first, a page at a time. */
export type ConversationsQuery = {
  /** Only this agent's. Left out, those of every agent the caller is given. */
  agent?: string;
  /** At most this many, 1 to 100; 20 when left out. */
  limit?: number;
  /** The page before's `next`. */
  cursor?: Cursor;
};

/** Which of a conversation's runs to read: the newest admitted first, a page at a time. */
export type RunsQuery = {
  /** At most this many, 1 to 100; 20 when left out. */
  limit?: number;
  /** The page before's `next`. */
  cursor?: Cursor;
};

/** Which of a conversation's entries to read, pi's `EntryQuery`: newest first unless `order` is `ascending`. */
export type EntriesQuery = {
  order?: "ascending" | "descending";
  /** The oldest entry id that may be given. */
  minEntryId?: EntryId;
  /** The newest entry id that may be given. */
  maxEntryId?: EntryId;
  /** At most this many, 1 to 100; 50 when left out, as pi's `ConversationTranscript` pages. */
  limit?: number;
  /** The page before's `next`, with the same query. */
  cursor?: Cursor;
};

/** A server: its HTTP API, and its operations for a way in in the same process. */
export type Server = {
  /** The HTTP API, a Web-standard handler: serve it on Node, a Worker, or beside the deployment's own routes. */
  fetch: (request: Request) => Promise<Response>;
  /** The agents the request's caller is given. */
  agents: (request: Request) => Promise<AgentInfo[]>;
  /**
   * Run one input for the request's caller, to its outcome. A refusal throws `ServerError` before the run is admitted;
   * after that, the outcome says how it ended.
   */
  run: (
    request: Request,
    agent: string,
    run: RunRequest,
    control?: RunControl,
  ) => Promise<RunOutcome>;
  /** The caller's conversations, of the agents they are given, the newest made first. */
  conversations: (
    request: Request,
    query?: ConversationsQuery,
  ) => Promise<Page<ConversationInfo, Cursor>>;
  /** One of the caller's conversations, and how it stands. */
  conversation: (
    request: Request,
    conversation: string,
  ) => Promise<ConversationInfo>;
  /** Change what one of the caller's conversations is listed by, as LangGraph's thread PATCH: its title. */
  update: (
    request: Request,
    conversation: string,
    change: { title: string },
  ) => Promise<ConversationInfo>;
  /** A page of one of the caller's conversation's runs, LangGraph's runs of a thread, the newest admitted first. */
  runs: (
    request: Request,
    conversation: string,
    query?: RunsQuery,
  ) => Promise<Page<RunInfo, Cursor>>;
  /** One run of one of the caller's conversations, and how it stands. */
  runOf: (
    request: Request,
    conversation: string,
    runId: string,
  ) => Promise<RunInfo>;
  /**
   * Stop a run of one of the caller's conversations, as LangGraph's cancel: the run going on, with the runs queued
   * behind it, or a queued one alone. `stopped` is false for a run that had ended.
   */
  stop: (
    request: Request,
    conversation: string,
    runId: string,
  ) => Promise<{ stopped: boolean }>;
  /** A page of one of the caller's conversations' entries, pi's transcript records, without its system entries. */
  entries: (
    request: Request,
    conversation: string,
    query?: EntriesQuery,
  ) => Promise<Page<EntryRecord, Cursor>>;
};

/** An entry id in a query string. */
const EntryIdParam = z.coerce
  .number()
  .int()
  .min(0)
  .transform((id) => id as EntryId)
  .optional();

/** The query string of the conversations route. */
const ConversationsParams = z.strictObject({
  agent: z.string().min(1).optional(),
  limit: Limit,
  cursor: CursorParam,
});

/** A conversation's change: its title, as LangGraph's thread PATCH changes a thread. */
const UpdateBody = z.strictObject({ title: z.string() });

/** The query string of the runs route. */
const RunsParams = z.strictObject({ limit: Limit, cursor: CursorParam });

/** The query string of the entries route: pi's `EntryQuery`, a limit and a cursor. */
const EntriesParams = z.strictObject({
  order: z.enum(["ascending", "descending"]).optional(),
  minEntryId: EntryIdParam,
  maxEntryId: EntryIdParam,
  limit: Limit,
  cursor: CursorParam,
});

/** How long a run waits between keep-alive signals, as LangGraph's `waitKeepAlive`. */
const keepAliveMs = 1000;

/** A run's body: its input, or LangGraph's `command: { resume }` with answers to its questions, never both. */
const RunBody = z
  .strictObject({
    agent: z.string().min(1),
    runId: z.string().min(1),
    input: z.string().min(1).optional(),
    whenBusy: z.enum(["reject", "followUp", "steer"]).optional(),
    command: z
      .strictObject({ resume: z.record(z.string(), z.json()) })
      .optional(),
  })
  .refine(
    (body) => (body.input === undefined) !== (body.command === undefined),
    {
      message: "give input or command, not both",
    },
  )
  .refine((body) => body.input !== undefined || body.whenBusy === undefined, {
    message: "whenBusy goes with an input",
  });

/** A server on a deployment's runtime, with the deployment's answers. */
export function createServer({
  runtime,
  authenticate,
  agentsFor,
  contextFor,
  connectUrl,
  onError = (error) => console.error(error),
}: ServerOptions): Server {
  async function callerOf(request: Request) {
    const caller = await authenticate(request);
    if (!caller)
      throw new ServerError(
        401,
        "unauthenticated",
        "who is calling is not known",
      );
    return caller;
  }

  async function agents(request: Request): Promise<AgentInfo[]> {
    return (await agentsFor(await callerOf(request))).map(
      ({ name, description }) => ({
        name,
        ...(description === undefined ? {} : { description }),
      }),
    );
  }

  /**
   * Admit a run: answer the deployment's questions, start it, and settle once it is admitted. Every refusal throws here,
   * as a `ServerError`; what is left is how it ends. A run is attended, as a person is at the other end to answer what it
   * asks, except where nobody can answer: MCP's.
   */
  async function start(
    request: Request,
    name: string,
    asked: RunRequest,
    { signal, onKeepAlive }: RunControl = {},
    attended = true,
  ): Promise<{ outcome: Promise<RunOutcome> }> {
    const { conversation, runId } = asked;
    const input =
      asked.input !== undefined ? asked.input : { resume: asked.resume };
    for (const [field, value] of Object.entries({
      conversation,
      runId,
      ...(asked.input !== undefined ? { input: asked.input } : {}),
    })) {
      if (value === "")
        throw new ServerError(400, "bad_request", `${field} is empty`);
    }
    const caller = await callerOf(request);
    const agent = (await agentsFor(caller)).find(
      (given) => given.name === name,
    );
    if (!agent)
      throw new ServerError(
        404,
        "agent_not_found",
        `agent "${name}" is not given to the caller`,
      );
    const context = await contextFor?.({
      caller,
      agent,
      conversation,
      request,
    });
    let admitted = () => {};
    const started = new Promise<void>((resolve) => (admitted = resolve));
    const running = runtime.run(agent, input, {
      conversation,
      runId,
      caller,
      attended,
      ...(asked.whenBusy === undefined ? {} : { whenBusy: asked.whenBusy }),
      ...(context === undefined ? {} : { context }),
      ...(signal ? { signal } : {}),
      onStarted: admitted,
    } as Parameters<Runtime["run"]>[2]);
    try {
      await Promise.race([started, running]);
    } catch (error) {
      throw refusalOf(error, conversation);
    }
    return {
      outcome: outcomeOf(agent, caller, running, signal, onKeepAlive),
    };
  }

  /** A question as a client gets it: one that asks for a login carries the deployment's page to connect it. */
  async function shown(
    agent: AnyAgent,
    caller: Caller,
    interrupt: Interrupt,
  ): Promise<Interrupt> {
    const value = interrupt.value as ConnectionQuestion;
    if (value?.type !== "connection" || !connectUrl) return interrupt;
    const connection = connectionOf(agent, value.name);
    const url = connection && (await connectUrl({ connection, caller }));
    return url === undefined
      ? interrupt
      : { ...interrupt, value: { ...value, connectUrl: url } };
  }

  /** The questions a run is given back with, as the caller sees them. */
  async function shownAll(
    agent: AnyAgent,
    caller: Caller,
    interrupts: readonly Interrupt[],
  ): Promise<Interrupt[]> {
    const out: Interrupt[] = [];
    for (const interrupt of interrupts)
      out.push(await shown(agent, caller, interrupt));
    return out;
  }

  async function outcomeOf(
    agent: AnyAgent,
    caller: Caller,
    running: ReturnType<Runtime["run"]>,
    signal: AbortSignal | undefined,
    onKeepAlive: (() => void) | undefined,
  ): Promise<RunOutcome> {
    const timer = onKeepAlive
      ? setInterval(onKeepAlive, keepAliveMs)
      : undefined;
    try {
      const outcome = await running;
      if (outcome.status === "done") return outcome;
      return {
        status: "interrupted",
        interrupts: await shownAll(agent, caller, outcome.interrupts),
      };
    } catch (error) {
      if (error instanceof RunFailed) {
        return {
          status: "failed",
          error: { code: error.reason, message: error.message },
          ...(error.interrupts.length === 0
            ? {}
            : {
                interrupts: await shownAll(agent, caller, error.interrupts),
              }),
        };
      }
      if (signal?.aborted) {
        return {
          status: "failed",
          error: { code: "stopped", message: "the client stopped the run" },
        };
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * The caller's conversation of this key, with the agents they are given: another caller's, one of an agent they are
   * not given, and none at all are the same, not found.
   */
  async function readable(request: Request, key: string) {
    const caller = await callerOf(request);
    const kept = await runtime.conversation(key);
    const agent =
      kept?.caller.id === caller.id
        ? (await agentsFor(caller)).find((given) => given.name === kept.agent)
        : undefined;
    if (!kept || !agent)
      throw new ServerError(
        404,
        "conversation_not_found",
        `conversation "${key}" is not found`,
      );
    return { caller, agent, kept };
  }

  /** A conversation as a client gets it: without the deployment's caller and context, its questions shown. */
  async function infoOut(
    agent: AnyAgent,
    caller: Caller,
    kept: Kept,
  ): Promise<ConversationInfo> {
    const interrupts = await shownAll(agent, caller, kept.interrupts);
    return {
      conversation: kept.conversation,
      agent: kept.agent,
      title: kept.title,
      createdAt: kept.createdAt,
      lastMessageAt: kept.lastMessageAt,
      status: kept.status,
      ...(kept.runId === undefined ? {} : { runId: kept.runId }),
      interrupts,
      ...(kept.runFailure === undefined ? {} : { runFailure: kept.runFailure }),
    };
  }

  async function conversations(
    request: Request,
    { agent: name, limit = 20, cursor }: ConversationsQuery = {},
  ): Promise<Page<ConversationInfo, Cursor>> {
    const caller = await callerOf(request);
    checkLimit(limit);
    const given = await agentsFor(caller);
    const agents = given.filter(
      (agent) => name === undefined || agent.name === name,
    );
    if (name !== undefined && agents.length === 0)
      throw new ServerError(
        404,
        "agent_not_found",
        `agent "${name}" is not given to the caller`,
      );
    const page = await badRead(() =>
      runtime.conversations(caller, {
        agents: agents.map((agent) => agent.name),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    );
    const items: ConversationInfo[] = [];
    for (const kept of page.items)
      items.push(
        await infoOut(
          agents.find((agent) => agent.name === kept.agent)!,
          caller,
          kept,
        ),
      );
    return page.next === undefined ? { items } : { items, next: page.next };
  }

  async function conversation(request: Request, key: string) {
    const { caller, agent, kept } = await readable(request, key);
    return infoOut(agent, caller, kept);
  }

  async function update(
    request: Request,
    key: string,
    { title }: { title: string },
  ) {
    const { caller, agent } = await readable(request, key);
    let changed: Kept | undefined;
    try {
      changed = await runtime.update(key, { title });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      throw new ServerError(400, "bad_request", error.message, {
        cause: error,
      });
    }
    // Readable, so made: a conversation is never removed.
    return infoOut(agent, caller, changed!);
  }

  async function entries(
    request: Request,
    key: string,
    { limit = 50, cursor, ...query }: EntriesQuery = {},
  ): Promise<Page<EntryRecord, Cursor>> {
    await readable(request, key);
    checkLimit(limit);
    // Readable, so made: a conversation is never removed.
    return (await badRead(() => runtime.entries(key, query, limit, cursor)))!;
  }

  /** A run as the caller sees it: its unanswered questions shown, as a run gives them. */
  async function runOut(
    agent: AnyAgent,
    caller: Caller,
    info: RunInfo,
  ): Promise<RunInfo> {
    return shownInfo(info, (interrupt) => shown(agent, caller, interrupt));
  }

  async function runs(
    request: Request,
    key: string,
    { limit = 20, cursor }: RunsQuery = {},
  ): Promise<Page<RunInfo, Cursor>> {
    const { caller, agent } = await readable(request, key);
    checkLimit(limit);
    // Readable, so made: a conversation is never removed.
    const page = (await badRead(() =>
      runtime.runs(key, { limit, ...(cursor === undefined ? {} : { cursor }) }),
    ))!;
    const items: RunInfo[] = [];
    for (const info of page.items)
      items.push(await runOut(agent, caller, info));
    return page.next === undefined ? { items } : { items, next: page.next };
  }

  async function runOf(request: Request, key: string, runId: string) {
    const { caller, agent } = await readable(request, key);
    const info = await runtime.runOf(key, runId);
    if (!info)
      throw new ServerError(
        404,
        "run_not_found",
        `run "${runId}" is not found`,
      );
    return runOut(agent, caller, info);
  }

  async function stop(request: Request, key: string, runId: string) {
    await readable(request, key);
    const stopped = await runtime.stop(key, runId);
    if (stopped === undefined)
      throw new ServerError(
        404,
        "run_not_found",
        `run "${runId}" is not found`,
      );
    return { stopped: stopped === "stopped" };
  }

  const app = new Hono();
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/agents", async (c) => c.json({ agents: await agents(c.req.raw) }));
  app.get("/conversations", async (c) =>
    c.json(
      pageOut(
        await conversations(
          c.req.raw,
          dropUndefined(paramsOf(ConversationsParams, c.req.query())),
        ),
      ),
    ),
  );
  app.get("/conversations/:conversation", async (c) =>
    c.json(await conversation(c.req.raw, c.req.param("conversation"))),
  );
  app.patch("/conversations/:conversation", async (c) => {
    const body = UpdateBody.safeParse(
      await c.req.json().catch(() => undefined),
    );
    if (!body.success)
      throw new ServerError(400, "bad_request", z.prettifyError(body.error));
    return c.json(
      await update(c.req.raw, c.req.param("conversation"), body.data),
    );
  });
  app.get("/conversations/:conversation/runs", async (c) =>
    c.json(
      pageOut(
        await runs(
          c.req.raw,
          c.req.param("conversation"),
          dropUndefined(paramsOf(RunsParams, c.req.query())),
        ),
      ),
    ),
  );
  app.get("/conversations/:conversation/runs/:runId", async (c) =>
    c.json(
      await runOf(c.req.raw, c.req.param("conversation"), c.req.param("runId")),
    ),
  );
  app.post("/conversations/:conversation/runs/:runId/cancel", async (c) =>
    c.json(
      await stop(c.req.raw, c.req.param("conversation"), c.req.param("runId")),
    ),
  );
  app.route(
    "/chat",
    chatRoutes({
      runtime,
      readable,
      admit: async (request, agent, run) => {
        const { outcome } = await start(request, agent, run);
        // A chat follows its run through its stream: the outcome is not waited for here.
        void outcome.catch(onError);
      },
      shown: async (request, key, interrupt) => {
        const { caller, agent } = await readable(request, key);
        return shown(agent, caller, interrupt);
      },
      onError,
    }),
  );
  app.route(
    "/mcp",
    mcpRoutes({
      callerOf,
      agentsFor: async (caller) => agentsFor(caller),
      // Nobody can answer a question inside an MCP call: its runs are unattended.
      start: (request, agent, run, control) =>
        start(request, agent, run, control, false),
      connectUrl: async (caller, connection) =>
        connectUrl?.({ connection, caller }),
      onError,
    }),
  );
  app.get("/conversations/:conversation/entries", async (c) =>
    c.json(
      pageOut(
        await entries(
          c.req.raw,
          c.req.param("conversation"),
          dropUndefined(paramsOf(EntriesParams, c.req.query())),
        ),
      ),
    ),
  );
  app.post("/conversations/:conversation/runs/wait", async (c) => {
    const body = RunBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      throw new ServerError(400, "bad_request", z.prettifyError(body.error));
    const { agent, runId, input, whenBusy, command } = body.data;
    const conversation = c.req.param("conversation");
    const { outcome } = await start(
      c.req.raw,
      agent,
      input !== undefined
        ? {
            conversation,
            runId,
            input,
            ...(whenBusy === undefined ? {} : { whenBusy }),
          }
        : { conversation, runId, resume: command!.resume },
    );
    c.header("Content-Type", "application/json; charset=utf-8");
    // Admitted: 200 now, a newline each second while it runs so no proxy cuts it, then how it ended. A client that hung
    // up fails the writes, never the run: the same run id gives its result again.
    return stream(
      c,
      async (out) => {
        let writes = Promise.resolve();
        const timer = setInterval(() => {
          writes = writes
            .then(() => out.write("\n"))
            .then(
              () => undefined,
              () => undefined,
            );
        }, keepAliveMs);
        let ended: RunOutcome;
        try {
          ended = await outcome;
        } catch (error) {
          onError(error);
          ended = {
            status: "failed",
            error: { code: "internal", message: "internal error" },
          };
        } finally {
          clearInterval(timer);
        }
        await writes;
        await out.write(JSON.stringify({ conversation, runId, ...ended }));
      },
      async () => {},
    );
  });
  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "no such route" } }, 404),
  );
  app.onError((error, c) => {
    if (error instanceof ServerError) {
      return c.json(
        { error: { code: error.code, message: error.message } },
        error.status as ContentfulStatusCode,
      );
    }
    onError(error);
    return c.json(
      { error: { code: "internal", message: "internal error" } },
      500,
    );
  });

  return {
    fetch: async (request) => app.fetch(request),
    agents,
    run: async (request, agent, run, control) =>
      (await start(request, agent, run, control)).outcome,
    conversations,
    conversation,
    update,
    entries,
    runs,
    runOf,
    stop,
  };
}

/** An object without its undefined fields, as the operations take their options. */
function dropUndefined<T extends object>(
  value: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

/** The connection of this name among the ones an agent's tools use. */
function connectionOf(agent: AnyAgent, name: string): Connection | undefined {
  return agent.tools
    .flatMap((tool) => (tool.uses ?? []).filter(isConnection))
    .find((connection) => connection.name === name);
}

/** A run's refusal as the server answers it. Another caller's conversation is not found, as LangGraph shows it. */
function refusalOf(error: unknown, conversation: string) {
  if (!(error instanceof RunRefused)) return error;
  switch (error.reason) {
    case "other_caller":
      return new ServerError(
        404,
        "conversation_not_found",
        `conversation "${conversation}" is not found`,
        {
          cause: error,
        },
      );
    case "busy":
      return new ServerError(422, "busy", error.message, { cause: error });
    case "connection_failed":
      return new ServerError(502, "connection_failed", error.message, {
        cause: error,
      });
    default:
      return new ServerError(409, error.reason, error.message, {
        cause: error,
      });
  }
}
