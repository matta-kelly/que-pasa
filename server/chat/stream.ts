/**
 * A run's assistant message as the AI SDK's UI message stream: each new value of the conversation gives the message
 * again, and the stream sends what changed since the last, so a client that applies the chunks holds the same message.
 * From an empty message it is a full replay, as `useChat`'s resume expects; from the message a client already has, it
 * continues it, as after an approval.
 */
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
  createUIMessageStream,
  type DynamicToolUIPart,
  type UIMessageChunk,
} from "ai";
import type { Interrupt } from "../../define/index.ts";
import { shownInfo } from "../questions.ts";
import type { RunInfo, Runtime } from "../../loop/index.ts";
import {
  answerId,
  type ChatDataParts,
  type ChatMessage,
  type ChatPart,
  assistantMessageOf,
} from "./message.ts";

type Chunk = UIMessageChunk<never, ChatDataParts>;

/** The order a tool call's states come in: a call never goes back, apart from a new question. */
const toolRank: Record<DynamicToolUIPart["state"], number> = {
  "input-streaming": 0,
  "input-available": 1,
  "approval-requested": 2,
  "approval-responded": 3,
  "output-available": 4,
  "output-error": 4,
  "output-denied": 4,
};

/**
 * What a client holds of one assistant message, and the chunks that bring it to the next value. Parts only grow,
 * apart from the step being written: when pi retries a response, the step's parts are replaced, with `reset-step`.
 */
export class MessageDiff {
  #sent: ChatPart[];
  #stepOpen: boolean;
  readonly #messageId: string;

  /** Starting from `held`, the parts the client already has. */
  constructor(messageId: string, held: readonly ChatPart[] = []) {
    this.#messageId = messageId;
    this.#sent = [...held];
    this.#stepOpen = held.some((part) => part.type === "step-start");
  }

  /** The chunks that bring the client's message to `parts`. */
  next(parts: readonly ChatPart[]): Chunk[] {
    const chunks: Chunk[] = [];
    const differs = this.#sent.findIndex(
      (sent, index) => !follows(sent, parts[index]),
    );
    if (differs !== -1) {
      const step = this.#sent.findLastIndex(
        (part) => part.type === "step-start",
      );
      if (differs <= step)
        throw new Error(
          `message "${this.#messageId}": part ${differs} changed before the step being written`,
        );
      // The step being written was replaced, as when pi retries a response: the client drops it, then gets it again.
      chunks.push({ type: "reset-step" });
      this.#sent = this.#sent.slice(0, step + 1);
    }
    this.#sent.forEach((sent, index) =>
      chunks.push(...this.#update(index, sent, parts[index]!)),
    );
    for (let index = this.#sent.length; index < parts.length; index += 1)
      chunks.push(...this.#update(index, undefined, parts[index]!));
    this.#sent = [...parts];
    return chunks;
  }

  /** The chunks that close the message's last step, once nothing more comes in it. */
  end(): Chunk[] {
    if (!this.#stepOpen) return [];
    this.#stepOpen = false;
    return [{ type: "finish-step" }];
  }

  #update(index: number, from: ChatPart | undefined, to: ChatPart): Chunk[] {
    const id = `${this.#messageId}:${index}`;
    switch (to.type) {
      case "step-start": {
        if (from) return [];
        // A new step closes the one before it.
        const closed = this.end();
        this.#stepOpen = true;
        return [...closed, { type: "start-step" }];
      }
      case "text":
      case "reasoning": {
        const was = from as typeof to | undefined;
        const kind = to.type;
        const chunks: Chunk[] = [];
        if (!was) chunks.push({ type: `${kind}-start`, id });
        const delta = to.text.slice(was?.text.length ?? 0);
        if (delta) chunks.push({ type: `${kind}-delta`, id, delta });
        if (to.state === "done" && was?.state !== "done")
          chunks.push({ type: `${kind}-end`, id });
        return chunks;
      }
      case "dynamic-tool":
        return toolChunks(from as DynamicToolUIPart | undefined, to);
      case "data-steer":
      case "data-note":
        return from
          ? []
          : [
              {
                type: to.type,
                ...(to.id === undefined ? {} : { id: to.id }),
                data: to.data,
              },
            ];
      default:
        return [];
    }
  }
}

/** Whether `next` continues `sent`: the same part, only grown. */
function follows(sent: ChatPart, next: ChatPart | undefined): boolean {
  if (!next || next.type !== sent.type) return false;
  switch (sent.type) {
    case "text":
    case "reasoning": {
      const grown = next as typeof sent;
      return sent.state === "done"
        ? grown.text === sent.text
        : grown.text.startsWith(sent.text);
    }
    case "dynamic-tool": {
      const call = next as DynamicToolUIPart;
      return (
        call.toolCallId === sent.toolCallId &&
        (toolRank[call.state] >= toolRank[sent.state] ||
          call.approval?.id !== sent.approval?.id ||
          call.state === "approval-requested")
      );
    }
    default:
      return JSON.stringify(sent) === JSON.stringify(next);
  }
}

/** The chunks that bring a tool call from what the client holds to its next state. */
function toolChunks(
  from: DynamicToolUIPart | undefined,
  to: DynamicToolUIPart,
): Chunk[] {
  const chunks: Chunk[] = [];
  const call = {
    toolCallId: to.toolCallId,
    toolName: to.toolName,
    dynamic: true,
  } as const;
  if (!from && to.state === "input-streaming")
    chunks.push({ type: "tool-input-start", ...call });
  if (
    to.state !== "input-streaming" &&
    (!from || from.state === "input-streaming")
  )
    chunks.push({ type: "tool-input-available", ...call, input: to.input });
  const asked = to.approval;
  if (
    asked &&
    (from?.approval?.id !== asked.id ||
      (to.state === "approval-requested" &&
        from.state !== "approval-requested"))
  ) {
    chunks.push({
      type: "tool-approval-request",
      approvalId: asked.id,
      toolCallId: to.toolCallId,
      approvalDescriptor: asked.descriptor,
      ...(asked.requestReason === undefined
        ? {}
        : { reason: asked.requestReason }),
    });
  }
  if (
    asked?.approved !== undefined &&
    (chunks.some((chunk) => chunk.type === "tool-approval-request") ||
      from?.approval?.approved === undefined)
  ) {
    chunks.push({
      type: "tool-approval-response",
      approvalId: asked.id,
      approved: asked.approved,
      ...(asked.reason === undefined ? {} : { reason: asked.reason }),
    });
  }
  if (toolRank[to.state] === 4 && (!from || toolRank[from.state] < 4)) {
    if (to.state === "output-available")
      chunks.push({
        type: "tool-output-available",
        toolCallId: to.toolCallId,
        output: to.output,
        dynamic: true,
      });
    else if (to.state === "output-error")
      chunks.push({
        type: "tool-output-error",
        toolCallId: to.toolCallId,
        errorText: to.errorText,
        dynamic: true,
      });
    else chunks.push({ type: "tool-output-denied", toolCallId: to.toolCallId });
  }
  return chunks;
}

/** What a run's stream reads, and how a question is shown to a client. */
export type RunStreamOptions = {
  runtime: Runtime;
  conversation: string;
  runId: string;
  /** The message the client already holds of this run; a full replay when left out. */
  held?: ChatMessage;
  /** Ends the stream, as when the client goes away; the run goes on. */
  signal?: AbortSignal;
  /** A question as a client gets it, such as a login's with the deployment's page. */
  show: (interrupt: Interrupt) => Promise<Interrupt>;
  /** How long the stream may be quiet before a keep-alive comment. */
  keepAliveMs?: number;
  onError: (error: unknown) => void;
};

/**
 * A run's assistant message, streamed from what the client holds until the run ends or waits on questions: done,
 * `finish`; waiting, its questions as approval requests, then `finish`; failed, `error`; stopped, `abort`. Read from the
 * conversation as it changes, so a stream opened at any time, also in another process after a crash, says the same.
 */
export function runStream({
  runtime,
  conversation,
  runId,
  held,
  signal,
  show,
  onError,
}: RunStreamOptions) {
  return createUIMessageStream<ChatMessage>({
    onError: (error) => {
      onError(error);
      return "internal error";
    },
    execute: async ({ writer }) => {
      const messageId = answerId(runId);
      const diff = new MessageDiff(messageId, held?.parts ?? []);
      const transcript = runEntries(runtime, conversation);
      writer.write({ type: "start", messageId });
      const views = await runtime.watch(conversation, {
        ...(signal ? { signal } : {}),
      });
      if (!views) throw new Error(`conversation "${conversation}" is missing`);
      for await (const view of views) {
        const found = await runtime.runOf(conversation, runId);
        if (!found) throw new Error(`run "${runId}" is missing`);
        const info = await shownInfo(found, show);
        const going =
          info.status === "running" || info.status === "interrupted";
        const message = assistantMessageOf({
          info,
          entries: await transcript(info),
          ...(going ? { live: view.live } : {}),
        });
        for (const chunk of diff.next(message.parts)) writer.write(chunk);
        const end = endOf(info);
        if (!end) continue;
        for (const chunk of [...diff.end(), ...end]) writer.write(chunk);
        return;
      }
    },
  });
}

/** How a stream ends for a run that will not go on now, or nothing while it does. */
function endOf(info: RunInfo): Chunk[] | undefined {
  switch (info.status) {
    case "done":
      return [{ type: "finish", finishReason: "stop" }];
    case "interrupted":
      return [{ type: "finish", finishReason: "tool-calls" }];
    case "failed":
      return [
        { type: "error", errorText: info.failure!.message },
        { type: "finish", finishReason: "error" },
      ];
    case "stopped":
      return [{ type: "abort", reason: "stopped" }];
    default:
      return undefined;
  }
}

/**
 * A run's entries, read as they come: each read takes only the entries after the last it has, within the run's range,
 * so a long run is read once.
 */
export function runEntries(runtime: Runtime, conversation: string) {
  const held: EntryRecord[] = [];
  return async (info: RunInfo): Promise<readonly EntryRecord[]> => {
    if (!info.entries) return held;
    const { first, last } = info.entries;
    const after = held.at(-1)?.id;
    let cursor;
    do {
      const page = await runtime.entries(
        conversation,
        {
          order: "ascending",
          minEntryId:
            after === undefined ? first : ((after + 1) as typeof first),
          ...(last === undefined ? {} : { maxEntryId: last }),
        },
        100,
        cursor,
      );
      if (!page) throw new Error(`conversation "${conversation}" is missing`);
      held.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return held;
  };
}
