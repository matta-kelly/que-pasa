/**
 * The chat surface: the AI SDK's chat protocol on que-pasa's server, so a frontend's `useChat` (or assistant-ui, or AI
 * Elements) reaches an agent with only `api` set. Its routes are the ones `useChat`'s `DefaultChatTransport` calls, and
 * the two the AI SDK's docs have an app add: history to load, and a stop. Each goes through the server's own checks,
 * and runs on the same runtime, conversations and run ids as the LangGraph routes.
 */
import {
  createUIMessageStreamResponse,
  isToolUIPart,
  type UIMessage,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
import type { Caller, Interrupt, Json } from "../../define/index.ts";
import type { RunInfo, Runtime } from "../../loop/index.ts";
import { ServerError } from "../errors.ts";
import {
  badRead,
  checkLimit,
  CursorParam,
  cursorOut,
  Limit,
  paramsOf,
} from "../page.ts";
import {
  assistantMessageOf,
  type ChatMessage,
  type RunTranscript,
  userMessageOf,
} from "./message.ts";
import { shownInfo } from "../questions.ts";
import { runEntries, runStream } from "./stream.ts";

/** What the chat surface needs of the server: its runtime, and its checks, so both surfaces refuse alike. */
export type ChatServer = {
  runtime: Runtime;
  /** The caller's conversation of this key, of an agent they are given; `ServerError` 404 otherwise. */
  readable: (
    request: Request,
    key: string,
  ) => Promise<{ caller: Caller; agent: { name: string } }>;
  /** Admit a run as the server admits one: every refusal throws `ServerError` before it is admitted. */
  admit: (
    request: Request,
    agent: string,
    run:
      | {
          conversation: string;
          runId: string;
          input: string;
          whenBusy?: "reject" | "followUp";
        }
      | { conversation: string; runId: string; resume: Record<string, Json> },
  ) => Promise<void>;
  /** A question as the caller sees it, such as a login's with the deployment's page. */
  shown: (
    request: Request,
    key: string,
    interrupt: Interrupt,
  ) => Promise<Interrupt>;
  onError: (error: unknown) => void;
};

/** How long a stream may be quiet before a keep-alive comment, so no proxy cuts it: Cloudflare's limit is 100 s. */
const keepAliveMs = 15_000;

/**
 * What `DefaultChatTransport` posts: the chat's id, its messages, and why; and what a frontend adds in its `body`: the
 * agent, for a conversation not made yet, and `whenBusy`. Other fields a frontend adds are let through.
 */
const ChatBody = z.looseObject({
  id: z.string().min(1),
  messages: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        role: z.enum(["system", "user", "assistant"]),
        parts: z.array(z.looseObject({ type: z.string() })),
      }),
    )
    .min(1),
  trigger: z.enum(["submit-message", "regenerate-message"]),
  messageId: z.string().optional(),
  agent: z.string().min(1).optional(),
  whenBusy: z.enum(["reject", "followUp"]).optional(),
});

/** The query string of the messages route: a page of runs. */
const MessagesParams = z.strictObject({ limit: Limit, cursor: CursorParam });

/** The stop route's body: the run to stop, so a stop that comes late never stops a run started after it. */
const StopBody = z.strictObject({ runId: z.string().min(1) });

/** The chat surface's routes, to mount at the server's `/chat`. */
export function chatRoutes(server: ChatServer): Hono {
  const { runtime } = server;
  const chat = new Hono();

  /** A run's stream as the response, from what the client holds of it. */
  function streamed(
    request: Request,
    key: string,
    runId: string,
    held?: ChatMessage,
  ) {
    return createUIMessageStreamResponse({
      stream: runStream({
        runtime,
        conversation: key,
        runId,
        ...(held ? { held } : {}),
        signal: request.signal,
        show: (interrupt) => server.shown(request, key, interrupt),
        fileUrl: fileUrlOf(request, key),
        onError: server.onError,
      }),
      keepAliveMs,
    });
  }

  /** A run's two messages, from its stored entries, its questions shown as the caller sees them. */
  async function messagesOf(request: Request, key: string, info: RunInfo) {
    const transcript: RunTranscript = {
      info: await shownInfo(info, (interrupt) =>
        server.shown(request, key, interrupt),
      ),
      entries: await runEntries(runtime, key)(info),
      fileUrl: fileUrlOf(request, key),
    };
    return {
      user: userMessageOf(transcript),
      assistant: assistantMessageOf(transcript),
    };
  }

  // useChat's send: a user message starts its run, by the message's id; an assistant message answers what its run asks.
  chat.post("/", async (c) => {
    const body = await bodyOf(c.req.raw, ChatBody);
    if (body.trigger === "regenerate-message")
      throw new ServerError(
        400,
        "regenerate_not_supported",
        "a conversation keeps its history: send a new message, not a regenerated one",
      );
    const key = body.id;
    const last = body.messages.at(-1)!;
    if (last.role === "user") {
      const text = textOf(last.parts);
      if (text === undefined)
        throw new ServerError(
          400,
          "bad_request",
          "a message to an agent is text: one or more text parts",
        );
      const agent = (await runtime.conversation(key))
        ? (await server.readable(c.req.raw, key)).agent.name
        : body.agent;
      if (agent === undefined)
        throw new ServerError(
          400,
          "bad_request",
          "a new conversation needs its agent in the body",
        );
      await server.admit(c.req.raw, body.agent ?? agent, {
        conversation: key,
        runId: last.id,
        input: text,
        ...(body.whenBusy === undefined ? {} : { whenBusy: body.whenBusy }),
      });
      return streamed(c.req.raw, key, last.id);
    }
    if (last.role === "assistant") {
      const answers = answersOf(last.parts);
      if (Object.keys(answers).length === 0)
        throw new ServerError(
          400,
          "bad_request",
          "an assistant message sent back carries its approval responses",
        );
      const { agent } = await server.readable(c.req.raw, key);
      const runId = (await runtime.conversation(key))?.runId;
      const info =
        runId === undefined ? undefined : await runtime.runOf(key, runId);
      if (!info || info.status !== "interrupted")
        throw new ServerError(
          409,
          "not_interrupted",
          `conversation "${key}" has no run waiting on an answer`,
        );
      // What the client holds before its answers: the stream goes on from there.
      const { assistant: held } = await messagesOf(c.req.raw, key, info);
      await server.admit(c.req.raw, agent.name, {
        conversation: key,
        runId: info.runId,
        resume: answers,
      });
      return streamed(c.req.raw, key, info.runId, held);
    }
    throw new ServerError(
      400,
      "bad_request",
      "the last message is a user or an assistant message",
    );
  });

  // useChat's resume: the run going on, replayed from its start, then live; 204 when none goes on.
  chat.get("/:id/stream", async (c) => {
    const key = c.req.param("id");
    await server.readable(c.req.raw, key);
    const runId = (await runtime.conversation(key))?.runId;
    if (runId === undefined) return c.body(null, 204);
    return streamed(c.req.raw, key, runId);
  });

  // The app's load: a page of runs, the newest first, each its user and assistant messages, in the order they came.
  chat.get("/:id/messages", async (c) => {
    const key = c.req.param("id");
    await server.readable(c.req.raw, key);
    const { limit = 20, cursor } = paramsOf(MessagesParams, c.req.query());
    checkLimit(limit);
    const page = (await badRead(() =>
      runtime.runs(key, {
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }),
    ))!;
    const messages: UIMessage[] = [];
    for (const info of [...page.items].reverse()) {
      // A steer is part of the run it joined.
      if (info.joined !== undefined) continue;
      const { user, assistant } = await messagesOf(c.req.raw, key, info);
      if (user) messages.push(user);
      if (assistant.parts.length > 0) messages.push(assistant);
    }
    return c.json(
      page.next === undefined
        ? { messages }
        : { messages, next: cursorOut(page.next) },
    );
  });

  // The stop the AI SDK's docs have an app add: useChat's stop() only leaves the stream.
  chat.post("/:id/stop", async (c) => {
    const key = c.req.param("id");
    await server.readable(c.req.raw, key);
    const { runId } = await bodyOf(c.req.raw, StopBody);
    const stopped = await runtime.stop(key, runId);
    if (stopped === undefined)
      throw new ServerError(
        404,
        "run_not_found",
        `run "${runId}" is not found`,
      );
    return c.json({ stopped: stopped === "stopped" });
  });

  return chat;
}

/** A request's JSON body, parsed, or 400 `bad_request`. */
async function bodyOf<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success)
    throw new ServerError(400, "bad_request", z.prettifyError(parsed.error));
  return parsed.data;
}

/** The text of a user message's parts, when it is all text and not empty. */
function textOf(parts: readonly { type: string }[]): string | undefined {
  if (parts.some((part) => part.type !== "text")) return undefined;
  const text = parts
    .map((part) => (part as { text?: unknown }).text)
    .filter((each): each is string => typeof each === "string")
    .join("");
  return text === "" ? undefined : text;
}

/**
 * The answers an assistant message sent back carries: each approval it responded to, by the question's id, as
 * LangChain's decisions: approved is `approve`, denied is `reject`, with the person's reason. Only a question the run
 * waits on is taken: any other is refused, `not_interrupted`.
 */
function answersOf(parts: readonly { type: string }[]): Record<string, Json> {
  const answers: Record<string, Json> = {};
  for (const part of parts as Parameters<typeof isToolUIPart>[0][]) {
    if (!isToolUIPart(part) || part.state !== "approval-responded") continue;
    const { id, approved, reason } = part.approval;
    answers[id] = approved
      ? { type: "approve" }
      : {
          type: "reject",
          ...(reason === undefined ? {} : { message: reason }),
        };
  }
  return answers;
}

/**
 * Where a client fetches a conversation's image: the server's file route, from the chat request's own URL, so a server
 * mounted under a path gives links under it. The chat's routes are `/chat` and `/chat/<id>/<what>`.
 */
function fileUrlOf(request: Request, key: string) {
  const url = new URL(request.url);
  const base = url.pathname.replace(/\/chat(?:\/[^/]+\/[^/]+)?\/?$/, "");
  return (fileId: string) =>
    `${url.origin}${base}/conversations/${encodeURIComponent(key)}/files/${encodeURIComponent(fileId)}`;
}
