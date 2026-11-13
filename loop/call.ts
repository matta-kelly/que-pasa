/**
 * A tool call, as a run makes it: the check of the connections the tool uses, the agent's middleware around it, then the
 * tool. Each may stop the call before the tool's code runs to ask a person, LangGraph's `interrupt()`: the question and
 * the answer are kept in the run's document, and the wait is held in memory, so a call that reruns after a restart finds
 * its question and waits again, or goes on with its answer.
 *
 * pi reruns a call a crash cut off only when its tool is replay-safe, so every que-pasa tool is replay-safe to pi, and
 * the call keeps the tool's own rule: a marker kept just before the tool's code runs tells a rerun that the tool had
 * started, and a tool not marked safe then ends as pi ends it, interrupted.
 */
import {
  awaitWithContext,
  type Context,
  withCancel,
} from "@earendil-works/chord/context";
import type { WatchHandle } from "@earendil-works/chord";
import {
  type ConversationId,
  defineTool as definePiTool,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  type Connection,
  isConnection,
  type Json,
  LoginRejected,
  type Middleware,
  type Runtime,
  type ServiceIdentity,
  type Tool,
  type ToolCallHandler,
  type ToolCallRequest,
  type ToolMessage,
} from "../define/index.ts";
import { NoLogin, type Resources } from "./resources.ts";
import { type Asked, ConversationDoc, RunDoc } from "./state.ts";
import type { ToolEvent } from "./trace.ts";

/** Any tool, as an agent holds it. */
type AnyTool = Tool<z.ZodObject, Json | undefined>;

/** The memo that marks a call's tool as started. */
const startedMemo = "que-pasa.started";

/** What a connection question asks: the person connects the service, then answers. Any answer checks again. */
export type ConnectionQuestion = {
  type: "connection";
  name: string;
  description?: string;
  owner: Connection["owner"];
};

/** A que-pasa tool as a pi tool, with the agent's middleware around each call. */
export function toPiTool(
  tool: AnyTool,
  middleware: readonly Middleware[],
  resources: Resources,
  event: ToolEvent,
) {
  return definePiTool({
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema(tool.schema),
    replay: "safe",
    execute: async (args, api, context) => {
      const message = await call(
        tool,
        middleware,
        resources,
        args as { [key: string]: Json },
        api,
        event,
        context,
      );
      return {
        output: [{ type: "text", text: message.content }],
        ...(message.status === "error" ? { isError: true } : {}),
      };
    },
  });
}

/**
 * The JSON Schema of what the model must give: the input shape, so a field with a default is not required. Without the
 * `$schema` key a tool's parameters do not take.
 */
export function jsonSchema(schema: z.ZodObject): object {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: "input" });
  delete json["$schema"];
  return json;
}

/** One call: the connections, the middleware, outermost first, then the tool. */
async function call(
  tool: AnyTool,
  middleware: readonly Middleware[],
  resources: Resources,
  args: { [key: string]: Json },
  api: ToolExecutionApi,
  event: ToolEvent,
  context: Context,
): Promise<ToolMessage> {
  const { conversationId, callId } = api;
  const kept = await api.snapshot(ConversationDoc, conversationId, context);
  const runId = kept?.runs.at(-1);
  if (!kept || runId === undefined)
    throw new Error("the conversation has no run going on");
  const { conversation, caller, context: made } = kept;
  const of = {
    conversation,
    caller,
    ...(made === undefined ? {} : { context: made }),
  };
  // This invocation's mark: a rerun after a restart has another, so it finds the tool started by an earlier one.
  const invocation = randomUUID();
  let started = false;
  const counts = new Map<string, number>();

  /** Ask, as `asker`, and wait for the answer: the n-th question of an asker in a call keeps its id across reruns. */
  async function interrupt<A>(
    asker: string,
    value: Json,
    answer?: z.ZodType<A>,
  ): Promise<A> {
    if (started) {
      throw new Error(
        `tool "${tool.name}": a call asks before its tool starts, never after`,
      );
    }
    const n = counts.get(asker) ?? 0;
    counts.set(asker, n + 1);
    const id = `${callId}:${asker}:${n}`;
    const given = await ask(api, runId!, id, value, answer, event, context);
    await event(
      conversationId,
      callId,
      "que_pasa.resume",
      { "que_pasa.interrupt.id": id },
      api,
      context,
    );
    return given;
  }

  // Each connection the tool uses, before anything else: a missing login is asked for, then checked again.
  for (const connection of (tool.uses ?? []).filter(isConnection)) {
    for (;;) {
      try {
        await resources.use(of, connection);
        break;
      } catch (error) {
        if (!(error instanceof NoLogin)) throw error;
        if (connection.owner === "shared") {
          return {
            status: "error",
            content: `No access to ${connection.name}: the person you act for may not use its shared login. Tell them; do not try again.`,
          };
        }
        const question: ConnectionQuestion = {
          type: "connection",
          name: connection.name,
          ...(connection.description === undefined
            ? {}
            : { description: connection.description }),
          owner: connection.owner,
        };
        await interrupt(`connection-${connection.name}`, question);
      }
    }
    await identify(api, runId, connection, resources, of, context);
  }

  const runtime: Runtime<Json | undefined> = {
    caller,
    context: made,
    use: async (resource) => {
      if (!(tool.uses ?? []).some((used) => used.name === resource.name)) {
        throw new Error(
          `tool "${tool.name}" uses resource "${resource.name}", which it does not declare in uses`,
        );
      }
      return resources.use(of, resource);
    },
  };

  const run: ToolCallHandler = async (edited) => {
    const input = tool.schema.parse(edited ?? args);
    started = true;
    if (
      (await api.memo(startedMemo, invocation, context)) !== invocation &&
      tool.replay !== "safe"
    ) {
      // As pi ends a call that is not replay-safe: the tool may have acted, so it never runs twice.
      const message = `Tool ${tool.name} was interrupted and may have partially run`;
      api.diagnostic({ severity: "error", message, code: "interrupted" });
      return { status: "error", content: message };
    }
    try {
      const result = await tool.run(input, runtime);
      return {
        status: "success",
        content: typeof result === "string" ? result : JSON.stringify(result),
      };
    } catch (error) {
      // The next call asks the deployment for the login again.
      if (error instanceof LoginRejected)
        resources.drop(conversation, error.connection);
      throw error;
    }
  };

  // The middleware wrap the tool in order: the first is outermost, as LangChain composes them.
  const wrapped = middleware.reduceRight<ToolCallHandler>(
    (handler, layer) =>
      layer.wrapToolCall
        ? (edited) => layer.wrapToolCall!(request(layer.name, edited), handler)
        : handler,
    run,
  );

  /** The call as a middleware gets it: its questions are asked in its name. */
  function request(
    asker: string,
    edited: { [key: string]: Json } | undefined,
  ): ToolCallRequest {
    return {
      name: tool.name,
      args: edited ?? args,
      id: callId,
      caller,
      context: made,
      interrupt: (value, answer) => interrupt(asker, value, answer),
    };
  }

  return wrapped();
}

/**
 * Who a connection is logged in as, once it is connected, when its run does not know yet: a run that started without
 * the login asks once the person connects it, so the system prompt says who "me" is from the next request on.
 */
async function identify(
  api: ToolExecutionApi,
  runId: string,
  connection: Connection,
  resources: Resources,
  of: Parameters<Resources["use"]>[0],
  context: Context,
) {
  if (!connection.whoami) return;
  const kept = await api.snapshot(RunDoc, api.conversationId, runId, context);
  if (kept?.identities?.[connection.name]) return;
  const who = await connection.whoami(await resources.use(of, connection));
  await api.commit(async (tx) => {
    const run = await tx.doc(RunDoc, api.conversationId, runId, null);
    run.identities = { ...run.identities, [connection.name]: identityOf(who) };
  }, context);
}

/** A service identity as plain JSON, as a run keeps it. */
export function identityOf(who: ServiceIdentity): ServiceIdentity {
  return {
    id: who.id,
    name: who.name,
    ...(who.email === undefined ? {} : { email: who.email }),
  };
}

/**
 * Ask one question and wait for its answer. The question is kept in the run's document first; a run nobody attends then
 * stops, and fails with it. An answer that does not fit is refused, kept as the question's error, and waited for again.
 */
async function ask<A>(
  api: ToolExecutionApi,
  runId: string,
  id: string,
  value: Json,
  answer: z.ZodType<A> | undefined,
  event: ToolEvent,
  context: Context,
): Promise<A> {
  const { conversationId, callId } = api;
  const attended = await api.commit(async (tx) => {
    const run = await tx.doc(RunDoc, conversationId, runId, null);
    run.interrupts ??= {};
    run.interrupts[id] ??= { callId, value };
    return run.attended === true;
  }, context);
  await event(
    conversationId,
    callId,
    "que_pasa.interrupt",
    { "que_pasa.interrupt.id": id },
    api,
    context,
  );
  if (!attended) {
    // Nobody can answer: the run stops here, before the tool acts. A rerun after a restart stops it again.
    const conversation = await api.conversation(conversationId, context);
    void conversation?.abort(context).catch(() => {});
    return awaitWithContext(new Promise<never>(() => {}), context);
  }
  for (;;) {
    const given = await answerOf(api, conversationId, runId, id, context);
    if (answer === undefined) return given as A;
    const checked = answer.safeParse(given);
    if (checked.success) return checked.data;
    const error = z.prettifyError(checked.error);
    await api.commit(async (tx) => {
      const asked = (await tx.doc(RunDoc, conversationId, runId, null))
        .interrupts?.[id];
      if (!asked) return;
      delete asked.answer;
      asked.error = error;
    }, context);
  }
}

/** The answer to a question, once a person gives it: watched in the run's document, while the call waits. */
async function answerOf(
  api: ToolExecutionApi,
  conversationId: ConversationId,
  runId: string,
  id: string,
  context: Context,
): Promise<Json> {
  const { context: watching, cancel } = withCancel(context);
  try {
    const watch = await api.watchDoc(RunDoc, conversationId, runId, watching);
    if (!watch) throw new Error(`run "${runId}": its document is missing`);
    const asked = await until(watch, (run) => answered(run.interrupts?.[id]));
    return asked.answer!;
  } finally {
    cancel();
  }
}

/** The question, when it has an answer. */
function answered(asked: Asked | undefined): Asked | undefined {
  return asked && Object.hasOwn(asked, "answer") ? asked : undefined;
}

/** The first value of a watch that `pick` finds something in. Rejects when the watch ends first, such as on an abort. */
export function until<T, R>(
  watch: WatchHandle<T>,
  pick: (value: T) => R | undefined,
): Promise<R> {
  const now = pick(watch.value);
  if (now !== undefined) {
    void watch.stop();
    return Promise.resolve(now);
  }
  return new Promise<R>((resolve, reject) => {
    watch.start(async (change) => {
      if (change.kind !== "value") return;
      const found = pick(change.value);
      if (found === undefined) return;
      resolve(found);
      void watch.stop();
    });
    void watch.closed.then((end) =>
      reject(new Error(`the watch ended before the answer: ${end.kind}`)),
    );
  });
}
