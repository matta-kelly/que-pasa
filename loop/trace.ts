/**
 * A run's trace: OpenTelemetry spans in the GenAI conventions (semconv 1.43.0), made live from pi's hooks, through the
 * OpenTelemetry API only. The host owns the SDK and the exporter; with none, every call here is a no-op.
 *
 *   invoke_agent <agent>     one per run, per process that works on it: a segment
 *   ├─ chat <model>          one per model request
 *   ├─ execute_tool <tool>   one per tool call, submit included
 *   └─ que_pasa.reminder     an event per reminder the run sent
 *
 * A conversation's runs are its own traces, one each, tagged with the conversation's key. A segment's parent is the trace
 * parent its run's document keeps: the host's span when the run was started in one, or else the run's first segment. So
 * every segment of a run, also one that resumes after a crash in a new process, is in one trace. Message content is
 * recorded only when the host asks for it.
 */

import { createHash } from "node:crypto";
import {
  BACKGROUND_CONTEXT,
  type Context,
} from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  type ConversationId,
  type DocumentReader,
  defineExtension,
  type Extension,
  GenerationTask,
  type Harness,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import {
  type Attributes,
  context as otel,
  diag,
  ROOT_CONTEXT,
  type Span,
  type SpanContext,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { ATTR_ERROR_TYPE } from "@opentelemetry/semantic-conventions";
import {
  ATTR_ENDUSER_ID,
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_AGENT_VERSION,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM_INSTRUCTIONS,
  ATTR_GEN_AI_TOOL_CALL_ARGUMENTS,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_CALL_RESULT,
  ATTR_GEN_AI_TOOL_DEFINITIONS,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
} from "@opentelemetry/semantic-conventions/incubating";
import { parseModel } from "../define/index.ts";
import { jsonSchema } from "./call.ts";
import {
  type AnyAgent,
  identitiesOf,
  identityText,
  reminder,
  submitTool,
  toolsOf,
} from "./extension.ts";
import {
  ConversationDoc,
  type ConversationState,
  MiddlewareDoc,
  RunDoc,
  type RunState,
  type TraceParent,
} from "./state.ts";
import { type Outcome, outcomeOf } from "./transcript.ts";
import { usageOf } from "./usage.ts";

/** The trace extension's name: every run's conversation selects it, after its agent's. */
export const traceExtensionName = "que-pasa.trace";

const tracer = trace.getTracer("que-pasa");

/** The trace parent to keep for a run started now: the host's active span, if it has one. */
export function activeParent(): TraceParent | undefined {
  const span = trace.getSpanContext(otel.active());
  return span && trace.isSpanContextValid(span) ? parentOf(span) : undefined;
}

/** Marks a moment of a tool call in its trace. */
export type ToolEvent = (
  id: ConversationId,
  callId: string,
  name: string,
  attributes: Attributes,
  reader: DocumentReader,
  context: Context,
) => Promise<void>;

/** A segment: this process's invoke_agent span of one run, and its open model and tool spans. */
type Segment = {
  span: Span;
  /** The run's model, "provider:model-id". */
  model: string;
  chat?: Span;
  tools: Map<string, Span>;
  ended: boolean;
  /** Settles when the segment has ended. */
  done?: Promise<void>;
};

/** The tracing of one runtime: its pi extension, and the segments of the runs it works on in this process. */
export function createTracing({
  agents,
  captureContent,
}: {
  agents: ReadonlyMap<string, AnyAgent>;
  captureContent: boolean;
}) {
  let harness: Harness | undefined;
  /** The runs this process admitted: a segment of any other run is a resumed one. */
  const started = new Set<string>();
  const segments = new Map<string, Promise<Segment | undefined>>();
  const keyOf = (id: ConversationId, runId: string) =>
    JSON.stringify([id, runId]);

  /**
   * The segment in this process of the conversation's run going on, its last, opened on first use. Undefined for a
   * conversation that is no agent's.
   */
  async function segmentOf(
    id: ConversationId,
    reader: DocumentReader,
    context: Context,
  ) {
    const kept = await reader.snapshot(ConversationDoc, id, context);
    const runId = kept?.runs.at(-1);
    if (!kept || runId === undefined) return undefined;
    const key = keyOf(id, runId);
    let segment = segments.get(key);
    if (!segment) {
      segment = open(id, kept, runId, reader, context);
      segments.set(key, segment);
    }
    return segment;
  }

  async function open(
    id: ConversationId,
    kept: ConversationState,
    runId: string,
    reader: DocumentReader,
    context: Context,
  ): Promise<Segment | undefined> {
    const run = await reader.snapshot(RunDoc, id, runId, context);
    const agent = agents.get(kept.agent);
    if (!run || !agent || !harness) return undefined;
    const parent = run.trace
      ? trace.setSpanContext(ROOT_CONTEXT, { ...run.trace, isRemote: true })
      : ROOT_CONTEXT;
    const span = tracer.startSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${agent.name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: runAttributes(
          agent,
          kept,
          runId,
          run,
          !started.has(keyOf(id, runId)),
          captureContent ? await systemOf(agent, id, reader, context) : [],
        ),
      },
      parent,
    );
    const segment: Segment = {
      span,
      model: run.model,
      tools: new Map(),
      ended: false,
    };
    // The run's first segment is the parent of the ones after it, when the run has no host span to keep.
    if (!run.trace && trace.isSpanContextValid(span.spanContext())) {
      await harness.commit(async (tx) => {
        (await tx.doc(RunDoc, id, runId, null)).trace = parentOf(
          span.spanContext(),
        );
      }, BACKGROUND_CONTEXT);
    }
    segment.done = endWhenSettled(harness, id, runId, agent, segment);
    return segment;
  }

  /**
   * The segment's one owner of its end: the run's settlement, with its usage, its status and, opted in, its input and
   * output. A run whose agent has an output and ended with no submit failed, as run() reports it.
   */
  async function endWhenSettled(
    on: Harness,
    id: ConversationId,
    runId: string,
    agent: AnyAgent,
    segment: Segment,
  ) {
    try {
      const record = await on.commit(
        (tx) => tx.submissionByRequest(id, runId),
        BACKGROUND_CONTEXT,
      );
      const submission =
        record && (await on.submission(record.id, BACKGROUND_CONTEXT));
      const settled = await submission?.wait(BACKGROUND_CONTEXT);
      const conversation = await on.conversation(id, BACKGROUND_CONTEXT);
      if (!settled || !conversation || segment.ended) return;
      const outcome = await outcomeOf(
        conversation,
        settled,
        submitTool,
        BACKGROUND_CONTEXT,
      );
      const spent = Object.values(
        (await usageOf(on, id, runId, BACKGROUND_CONTEXT)).models,
      );
      const total = (count: (usage: (typeof spent)[number]) => number) =>
        spent.reduce((sum, usage) => sum + count(usage), 0);
      segment.span.setAttributes({
        [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: total(
          (u) => u.input + u.cacheRead + u.cacheWrite,
        ),
        [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: total((u) => u.output),
        [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: total((u) => u.cacheRead),
        ...(captureContent ? runContent(outcome) : {}),
      });
      const failure =
        settled.status !== "done"
          ? settled.reason
          : agent.output && !outcome.submitted
            ? "no_submit"
            : undefined;
      end(segment, failure);
    } catch (error) {
      // A close ends the wait; closeAll has ended the segment.
      if (!segment.ended)
        diag.error("que-pasa: a run's trace could not end", error);
    }
  }

  /** End a segment and anything still open in it, with the run's failure as the error, if it failed. */
  function end(segment: Segment, failure: string | undefined) {
    segment.ended = true;
    for (const open of [segment.chat, ...segment.tools.values()]) {
      if (open) fail(open, failure ?? "run_ended").end();
    }
    if (failure) fail(segment.span, failure);
    segment.span.end();
  }

  const traced = defineExtension({
    name: traceExtensionName,
    hooks: [
      hook(GenerationTask, {
        beforeRequest: (request, api, context) =>
          safely(async () => {
            const segment = await segmentOf(api.conversationId, api, context);
            if (!segment) return;
            // A request that never answered: an attempt the abort or a retry left behind.
            if (segment.chat) fail(segment.chat, "superseded").end();
            const last = request.messages.at(-1);
            if (last?.role === "user" && textOf(last.content) === reminder)
              segment.span.addEvent("que_pasa.reminder");
            const model = parseModel(segment.model);
            segment.chat = tracer.startSpan(
              `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model.modelId}`,
              {
                kind: SpanKind.CLIENT,
                attributes: {
                  [ATTR_GEN_AI_OPERATION_NAME]:
                    GEN_AI_OPERATION_NAME_VALUE_CHAT,
                  [ATTR_GEN_AI_PROVIDER_NAME]: model.provider,
                  [ATTR_GEN_AI_REQUEST_MODEL]: model.modelId,
                  ...(captureContent
                    ? {
                        [ATTR_GEN_AI_INPUT_MESSAGES]: json(
                          request.messages.map(toGenAi),
                        ),
                      }
                    : {}),
                },
              },
              trace.setSpan(ROOT_CONTEXT, segment.span),
            );
          }),
        afterResponse: (message, api, context) =>
          safely(async () => {
            const segment = await segmentOf(api.conversationId, api, context);
            if (!segment?.chat) return;
            segment.chat.setAttributes(
              responseAttributes(message, captureContent),
            );
            if (
              message.stopReason === "error" ||
              message.stopReason === "aborted"
            )
              fail(segment.chat, message.stopReason);
            segment.chat.end();
            delete segment.chat;
          }),
      }),
      hook(ToolTask, {
        beforeTool: (call, api, context) =>
          safely(async () => {
            const segment = await segmentOf(api.conversationId, api, context);
            if (segment)
              segment.tools.set(
                call.id,
                toolSpan(segment, call, captureContent),
              );
          }),
        afterTool: (call, result, api, context) =>
          safely(async () => {
            const segment = await segmentOf(api.conversationId, api, context);
            if (!segment) return;
            // A result pi wrote with no call in this process, such as an interrupted one after a resume, starts here.
            const span =
              segment.tools.get(call.id) ??
              toolSpan(segment, call, captureContent);
            segment.tools.delete(call.id);
            if (captureContent)
              span.setAttribute(
                ATTR_GEN_AI_TOOL_CALL_RESULT,
                textOf(result.output ?? []),
              );
            if (result.isError)
              fail(span, result.diagnostics?.[0]?.code ?? "tool_error");
            span.end();
          }),
      }),
    ],
  });

  return {
    extension: traced as Extension,
    /** The harness the segments read and wait on: bound once it is open, before any run goes on. */
    bind(on: Harness) {
      harness = on;
    },
    /** A run this process admitted, so its first segment is not a resumed one. */
    start(id: ConversationId, runId: string) {
      started.add(keyOf(id, runId));
    },
    /**
     * Mark a moment of a tool call on its execute_tool span, such as a question it asks and its answer: never fails the
     * call.
     */
    toolEvent: ((id, callId, name, attributes, reader, context) =>
      safely(async () => {
        const segment = await segmentOf(id, reader, context);
        segment?.tools.get(callId)?.addEvent(name, attributes);
      })) satisfies ToolEvent,
    /** Settles when the run's segment in this process, if it has one, has ended. */
    async ended(id: ConversationId, runId: string) {
      await (
        await segments.get(keyOf(id, runId))
      )?.done;
    },
    /** End every open segment: the runs are kept, and go on in the next process, in a segment of their own. */
    async closeAll() {
      for (const pending of segments.values()) {
        const segment = await pending;
        if (segment && !segment.ended) {
          segment.span.addEvent("que_pasa.closed");
          end(segment, undefined);
        }
      }
      segments.clear();
    },
  };
}

/** The attributes of a run's invoke_agent span: what the run is, and, opted in, what its agent was given. */
function runAttributes(
  agent: AnyAgent,
  conversation: ConversationState,
  runId: string,
  run: RunState,
  resumed: boolean,
  system: readonly string[],
): Attributes {
  const model = parseModel(run.model);
  const tools = toolDefinitions(agent);
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
    [ATTR_GEN_AI_AGENT_NAME]: agent.name,
    [ATTR_GEN_AI_AGENT_VERSION]: versionOf(agent, run.model),
    [ATTR_GEN_AI_CONVERSATION_ID]: conversation.conversation,
    "que_pasa.run.id": runId,
    [ATTR_GEN_AI_PROVIDER_NAME]: model.provider,
    [ATTR_GEN_AI_REQUEST_MODEL]: model.modelId,
    [ATTR_ENDUSER_ID]: conversation.caller.id,
    "que_pasa.resumed": resumed,
    ...(system.length > 0
      ? {
          [ATTR_GEN_AI_SYSTEM_INSTRUCTIONS]: json(
            system.map((content) => ({ type: "text", content })),
          ),
          [ATTR_GEN_AI_TOOL_DEFINITIONS]: json(tools),
        }
      : {}),
  };
}

/**
 * The system prompt the run's model is given, in its parts and order: each middleware's section from the state the run
 * keeps, then the agent's instructions.
 */
async function systemOf(
  agent: AnyAgent,
  id: ConversationId,
  reader: DocumentReader,
  context: Context,
): Promise<string[]> {
  const parts: string[] = [];
  for (const middleware of agent.middleware ?? []) {
    if (!middleware.systemPrompt) continue;
    const kept = await reader.snapshot(
      MiddlewareDoc,
      id,
      middleware.name,
      context,
    );
    const text = middleware.systemPrompt(kept?.state ?? null);
    if (text !== undefined) parts.push(text);
  }
  const identities = identityText(
    agent,
    await identitiesOf(reader, id, context),
  );
  if (identities !== undefined) parts.push(identities);
  return [...parts, agent.instructions];
}

/** The tools as the model is given them: the agent's and its middleware's, and submit when it has an output. */
function toolDefinitions(agent: AnyAgent) {
  const tools = toolsOf(agent).map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: jsonSchema(tool.schema),
  }));
  return agent.output
    ? [
        ...tools,
        {
          type: "function",
          name: submitTool,
          parameters: jsonSchema(agent.output),
        },
      ]
    : tools;
}

/** The hash of what makes the agent what it is on this model: its instructions, its middleware, its tools, its output and the model. */
export function versionOf(agent: AnyAgent, model: string): string {
  const parts = {
    instructions: agent.instructions,
    // Left out with none, so an agent with no middleware keeps the version it had.
    ...(agent.middleware?.length
      ? { middleware: agent.middleware.map((middleware) => middleware.name) }
      : {}),
    tools: toolDefinitions(agent),
    model,
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A run's input and output, opted in: its input, and its answer (with its submit call, for an agent with an output). */
function runContent({ input, answer: output }: Outcome): Attributes {
  return {
    ...(input ? { [ATTR_GEN_AI_INPUT_MESSAGES]: json([toGenAi(input)]) } : {}),
    ...(output
      ? { [ATTR_GEN_AI_OUTPUT_MESSAGES]: json([toGenAi(output)]) }
      : {}),
  };
}

function responseAttributes(
  message: AssistantMessage,
  captureContent: boolean,
): Attributes {
  return {
    [ATTR_GEN_AI_RESPONSE_MODEL]: message.model,
    ...(message.responseId
      ? { [ATTR_GEN_AI_RESPONSE_ID]: message.responseId }
      : {}),
    [ATTR_GEN_AI_RESPONSE_FINISH_REASONS]: [message.stopReason],
    // The conventions count input tokens with the cached ones in; pi-ai counts them apart.
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]:
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: message.usage.output,
    [ATTR_GEN_AI_USAGE_CACHE_READ_INPUT_TOKENS]: message.usage.cacheRead,
    ...(message.usage.reasoning === undefined
      ? {}
      : {
          [ATTR_GEN_AI_USAGE_REASONING_OUTPUT_TOKENS]: message.usage.reasoning,
        }),
    ...(captureContent
      ? { [ATTR_GEN_AI_OUTPUT_MESSAGES]: json([toGenAi(message)]) }
      : {}),
  };
}

function toolSpan(
  segment: Segment,
  call: { id: string; name: string; arguments: unknown },
  captureContent: boolean,
) {
  return tracer.startSpan(
    `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${call.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
        [ATTR_GEN_AI_TOOL_NAME]: call.name,
        [ATTR_GEN_AI_TOOL_CALL_ID]: call.id,
        [ATTR_GEN_AI_TOOL_TYPE]: "function",
        ...(captureContent
          ? { [ATTR_GEN_AI_TOOL_CALL_ARGUMENTS]: json(call.arguments) }
          : {}),
      },
    },
    trace.setSpan(ROOT_CONTEXT, segment.span),
  );
}

/** Mark a span failed, with the reason as its error type. */
function fail(span: Span, reason: string): Span {
  span.setAttribute(ATTR_ERROR_TYPE, reason);
  span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
  return span;
}

/** Run a hook's tracing so that it never fails the run: pi blocks a tool call whose beforeTool throws. */
async function safely(work: () => Promise<void>): Promise<undefined> {
  try {
    await work();
  } catch (error) {
    diag.error("que-pasa: tracing failed", error);
  }
  return undefined;
}

function parentOf(span: SpanContext): TraceParent {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    traceFlags: span.traceFlags,
  };
}

// The GenAI conventions' message shape: a role and its parts.
type Part =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_call"; id: string; name: string; arguments: unknown }
  | { type: "tool_call_response"; id: string; response: string };
type GenAiMessage = { role: string; parts: Part[]; finish_reason?: string };

const json = (value: unknown) => JSON.stringify(value);

function textOf(
  content: UserMessage["content"] | ToolResultMessage["content"],
): string {
  return typeof content === "string"
    ? content
    : content
        .map((block) =>
          block.type === "text" ? block.text : `[${block.mimeType}]`,
        )
        .join("");
}

/** A pi-ai message as the GenAI conventions write it. */
function toGenAi(message: Message): GenAiMessage {
  switch (message.role) {
    case "user":
      return {
        role: "user",
        parts: [{ type: "text", content: textOf(message.content) }],
      };
    case "assistant":
      return {
        role: "assistant",
        parts: message.content.map((block): Part => {
          if (block.type === "text")
            return { type: "text", content: block.text };
          if (block.type === "thinking")
            return { type: "reasoning", content: block.thinking };
          return {
            type: "tool_call",
            id: block.id,
            name: block.name,
            arguments: block.arguments,
          };
        }),
        finish_reason: message.stopReason,
      };
    case "toolResult":
      return {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: message.toolCallId,
            response: textOf(message.content),
          },
        ],
      };
    default:
      return { role: message.role, parts: [] };
  }
}
