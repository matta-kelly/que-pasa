/**
 * The server: a deployment's agents, reached from outside its process, after LangGraph's Agent Server. It asks the
 * deployment who is calling, which agents they are given and what context a conversation has, then runs the agent on
 * the deployment's runtime. Its HTTP API is LangGraph's routes in pi's words; its operations serve a way in that lives in
 * the same process, such as an MCP layer.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { stream } from "hono/streaming";
import { z } from "zod";
import type {
  Agent,
  Caller,
  Connection,
  ConnectionOwner,
  Json,
} from "../define/index.ts";
import {
  ConnectionsMissing,
  RunFailed,
  RunRefused,
  type Runtime,
} from "../loop/index.ts";

/** Any agent, as a deployment gives it. */
type AnyAgent = Agent<z.ZodObject | undefined, Json | undefined>;

/** A request the server refuses, with its HTTP status and a code a client can act on. */
export class ServerError extends Error {
  override readonly name: string = "ServerError";
  readonly status: 400 | 401 | 403 | 404 | 409 | 422;
  readonly code: string;
  constructor(
    status: 400 | 401 | 403 | 404 | 409 | 422,
    code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.status = status;
    this.code = code;
  }
}

/** What a deployment's hook throws to refuse a request: 403 `forbidden`. */
export class Refused extends ServerError {
  override readonly name = "Refused";
  constructor(message: string) {
    super(403, "forbidden", message);
  }
}

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
   * Where a person connects a connection: the deployment's page, from its control plane. Given with a run that needs a
   * login the caller has not given; left out, none is.
   */
  connectUrl?: (request: {
    connection: Connection;
    caller: Caller;
  }) => string | undefined | Promise<string | undefined>;
  /** Where an error the server did not expect is reported; `console.error` by default. */
  onError?: (error: unknown) => void;
};

/** A connection a caller has to connect before the run starts. */
export type ConnectionNeeded = {
  name: string;
  description?: string;
  owner: ConnectionOwner;
  /** The deployment's page to connect it, when it has one. */
  connectUrl?: string;
};

/** An agent as a caller sees it. Its input is always one text message. */
export type AgentInfo = { name: string; description?: string };

/** What a client asks for: one input on a conversation, by the client's own run id. */
export type RunRequest = { conversation: string; runId: string; input: string };

/**
 * How a run ended: with its result (the agent's text, or its output), or failed with pi's reason or `no_submit`. More
 * cases come with run life, such as a run that waits for an approval, so a client checks `status`.
 */
export type RunOutcome =
  | { status: "done"; result: unknown }
  | { status: "failed"; error: { code: string; message: string } }
  /** The run did not start: the caller has no login for these connections. Once they connect, the same run id runs. */
  | { status: "needs_connection"; connections: ConnectionNeeded[] };

/** How a client in the same process follows a run. */
export type RunControl = {
  /** Stops the run when it aborts. Left out, the run goes on whatever the client does, and the same run id gives its result. */
  signal?: AbortSignal;
  /** Called each second while the run goes on: for a client that must show it is alive, such as an MCP progress notification. */
  onKeepAlive?: () => void;
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
};

/** How long a run waits between keep-alive signals, as LangGraph's `waitKeepAlive`. */
const keepAliveMs = 1000;

const RunBody = z.object({
  agent: z.string().min(1),
  runId: z.string().min(1),
  input: z.string().min(1),
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
   * as a `ServerError`; what is left is how it ends.
   */
  async function start(
    request: Request,
    name: string,
    { conversation, runId, input }: RunRequest,
    { signal, onKeepAlive }: RunControl = {},
  ): Promise<{ outcome: Promise<RunOutcome> }> {
    for (const [field, value] of Object.entries({
      conversation,
      runId,
      input,
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
      ...(context === undefined ? {} : { context }),
      ...(signal ? { signal } : {}),
      onStarted: admitted,
    } as Parameters<Runtime["run"]>[2]);
    try {
      await Promise.race([started, running]);
    } catch (error) {
      if (error instanceof ConnectionsMissing) {
        return { outcome: needed(error.connections, caller) };
      }
      throw refusalOf(error, conversation);
    }
    return { outcome: outcomeOf(running, signal, onKeepAlive) };
  }

  /** The connections a caller has to connect, each with the deployment's page for it. */
  async function needed(
    connections: readonly Connection[],
    caller: Caller,
  ): Promise<RunOutcome> {
    const needs: ConnectionNeeded[] = [];
    for (const connection of connections) {
      const url = await connectUrl?.({ connection, caller });
      needs.push({
        name: connection.name,
        ...(connection.description === undefined
          ? {}
          : { description: connection.description }),
        owner: connection.owner,
        ...(url === undefined ? {} : { connectUrl: url }),
      });
    }
    return { status: "needs_connection", connections: needs };
  }

  async function outcomeOf(
    running: Promise<unknown>,
    signal: AbortSignal | undefined,
    onKeepAlive: (() => void) | undefined,
  ): Promise<RunOutcome> {
    const timer = onKeepAlive
      ? setInterval(onKeepAlive, keepAliveMs)
      : undefined;
    try {
      return { status: "done", result: await running };
    } catch (error) {
      if (error instanceof RunFailed) {
        return {
          status: "failed",
          error: { code: error.reason, message: error.message },
        };
      }
      if (signal?.aborted) {
        return {
          status: "failed",
          error: { code: "aborted", message: "the client stopped the run" },
        };
      }
      throw error;
    } finally {
      clearInterval(timer);
    }
  }

  const app = new Hono();
  app.get("/ok", (c) => c.json({ ok: true }));
  app.get("/agents", async (c) => c.json({ agents: await agents(c.req.raw) }));
  app.post("/conversations/:conversation/runs/wait", async (c) => {
    const body = RunBody.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success)
      throw new ServerError(400, "bad_request", z.prettifyError(body.error));
    const { agent, runId, input } = body.data;
    const conversation = c.req.param("conversation");
    const { outcome } = await start(c.req.raw, agent, {
      conversation,
      runId,
      input,
    });
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
  };
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
    default:
      return new ServerError(409, error.reason, error.message, {
        cause: error,
      });
  }
}
