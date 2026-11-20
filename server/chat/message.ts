/**
 * A run as the AI SDK's chat shows it: its input as a user message, and everything the agent did for it as one
 * assistant message, after `useChat`'s `UIMessage`. One pure function of what pi keeps, so the stream, a replay after a
 * reload, and a page of history read back are the same message.
 */
import type {
  AssistantMessage,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  CompactionEntry,
  type EntryRecord,
  type LiveState,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { DynamicToolUIPart, UIMessage } from "ai";
import type { Json } from "../../define/index.ts";
import { NoteEntry, type Question, type RunInfo } from "../../loop/index.ts";

/**
 * The data parts a chat's messages carry: a steer, a message that joined the run while it went on; a note, a message
 * put in the conversation for its runs to read, which started no run; and a compaction, the summary that took the place
 * of the conversation's older part.
 */
export type ChatDataParts = {
  steer: { text: string };
  note: { text: string };
  compaction: { summary: string };
};

/** A chat's message: a frontend gives it to `useChat<ChatMessage>()` to type its parts. */
export type ChatMessage = UIMessage<never, ChatDataParts>;

/** One part of a chat's message. */
export type ChatPart = ChatMessage["parts"][number];

/** What a run's messages are made from: how it stands, its entries, and pi's live state while it goes on. */
export type RunTranscript = {
  info: RunInfo;
  /** Its entries, in order, from its input's: `entries()` over its range. */
  entries: readonly EntryRecord[];
  /** pi's live state, when it is the run going on: the answer being written. */
  live?: LiveState;
};

/** The id of a run's assistant message: stable, so a replay replaces the message it continues. */
export const answerId = (runId: string) => `${runId}:answer`;

/** A run's input as a user message, by the run's id: the id `useChat` gave it is the run's. */
export function userMessageOf({
  info,
  entries,
}: RunTranscript): ChatMessage | undefined {
  const input = entries[0];
  const text =
    input && UserEntry.is(input)
      ? textOf(input.model?.[0]?.content)
      : info.input;
  return text === undefined
    ? undefined
    : { id: info.runId, role: "user", parts: [{ type: "text", text }] };
}

/**
 * What the agent did for a run, as one assistant message: each model response a step, with its text, its reasoning
 * and its tool calls, each call carrying its question and its result; a steer where it joined; a note where it was
 * placed, during the run or after it; a compaction where its summary was placed; and, while the run goes on, the response being written. A response pi retried is left out, as the stream's `reset-step` removes it.
 */
export function assistantMessageOf({
  info,
  entries,
  live,
}: RunTranscript): ChatMessage {
  const parts: ChatPart[] = [];
  const calls = new Map<string, number>();
  const steers = new Map(
    info.steers.flatMap(({ runId, entry }) =>
      entry === undefined ? [] : [[entry, runId] as const],
    ),
  );
  let step = 0;
  for (const entry of entries.slice(1)) {
    if (UserEntry.is(entry)) {
      const steer = steers.get(entry.id);
      const text = textOf(entry.model?.[0]?.content);
      // Not a steer: a harness's own reminder to the model, not a person's.
      if (steer !== undefined && text !== undefined)
        parts.push({ type: "data-steer", id: steer, data: { text } });
    } else if (NoteEntry.is(entry)) {
      const text = textOf(entry.model?.[0]?.content);
      if (text !== undefined)
        parts.push({
          type: "data-note",
          id: entry.data.noteId,
          data: { text },
        });
    } else if (CompactionEntry.is(entry)) {
      const summary = textOf(entry.model?.[0]?.content);
      if (summary !== undefined)
        parts.push({
          type: "data-compaction",
          id: String(entry.id),
          data: { summary },
        });
    } else if (AssistantEntry.is(entry)) {
      const message = entry.model?.[0] as AssistantMessage | undefined;
      if (!message || message.stopReason === "error") continue;
      stepOf(parts, calls, message, `${info.runId}:${step}`, "done");
      step += 1;
    } else if (ToolResultEntry.is(entry)) {
      const result = entry.model?.[0] as ToolResultMessage | undefined;
      const at = result && calls.get(result.toolCallId);
      if (result && at !== undefined)
        parts[at] = resultOf(parts[at] as DynamicToolUIPart, result);
    }
  }
  const writing = live?.generation?.message as AssistantMessage | undefined;
  if (writing && writing.content.length > 0)
    stepOf(parts, calls, writing, `${info.runId}:${step}`, "streaming");
  for (const question of latestQuestions(info.questions)) {
    const at = calls.get(question.callId);
    if (at !== undefined)
      parts[at] = askedOf(parts[at] as DynamicToolUIPart, question);
  }
  return { id: answerId(info.runId), role: "assistant", parts };
}

/** One model response as a step: a step boundary, then its blocks, in order. */
function stepOf(
  parts: ChatPart[],
  calls: Map<string, number>,
  message: AssistantMessage,
  step: string,
  state: "streaming" | "done",
) {
  parts.push({ type: "step-start" });
  message.content.forEach((block, index) => {
    switch (block.type) {
      case "text":
        parts.push({ type: "text", text: block.text, state });
        break;
      case "thinking":
        if (block.redacted) break;
        parts.push({
          type: "reasoning",
          id: `${step}:${index}`,
          text: block.thinking,
          state,
        });
        break;
      case "toolCall":
        calls.set(block.id, parts.length);
        parts.push(
          state === "streaming"
            ? {
                type: "dynamic-tool",
                toolName: block.name,
                toolCallId: block.id,
                state: "input-streaming",
                input: block.arguments,
              }
            : {
                type: "dynamic-tool",
                toolName: block.name,
                toolCallId: block.id,
                state: "input-available",
                input: block.arguments,
              },
        );
        break;
    }
  });
}

/** A call once its result is in: its output, its error, or, when the person rejected it, denied. */
function resultOf(
  call: DynamicToolUIPart,
  result: ToolResultMessage,
): DynamicToolUIPart {
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const base = {
    type: "dynamic-tool" as const,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
  };
  return result.isError
    ? { ...base, state: "output-error", errorText: text }
    : { ...base, state: "output-available", output: text };
}

/** The question that decides each call: its last, as a call asks again after an answer that did not fit, or a login. */
function latestQuestions(questions: readonly Question[]): Question[] {
  const byCall = new Map<string, Question>();
  for (const question of questions) byCall.set(question.callId, question);
  return [...byCall.values()];
}

/**
 * A call with its question: waiting on it, answered, or, once the result is in, with the person's decision on it. A
 * call the person rejected, which ran nothing, is denied.
 */
function askedOf(
  call: DynamicToolUIPart,
  question: Question,
): DynamicToolUIPart {
  const asked = {
    id: question.id,
    descriptor: question.value,
    ...(reasonOf(question.value) === undefined
      ? {}
      : { requestReason: reasonOf(question.value)! }),
  };
  const base = {
    type: "dynamic-tool" as const,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    input: call.input,
  };
  if (question.answer === undefined)
    return { ...base, state: "approval-requested", approval: asked };
  const approved = approvedBy(question.answer);
  const decided = {
    ...asked,
    approved,
    ...(messageOf(question.answer) === undefined
      ? {}
      : { reason: messageOf(question.answer)! }),
  };
  if (!approved)
    return call.state === "output-error" ||
      call.state === "output-available" ||
      call.state === "output-denied"
      ? { ...base, state: "output-denied", approval: { ...decided, approved } }
      : { ...base, state: "approval-responded", approval: decided };
  switch (call.state) {
    case "output-available":
      return {
        ...base,
        state: "output-available",
        output: call.output,
        approval: { ...decided, approved: true },
      };
    case "output-error":
      return {
        ...base,
        state: "output-error",
        errorText: call.errorText,
        approval: { ...decided, approved: true },
      };
    default:
      return { ...base, state: "approval-responded", approval: decided };
  }
}

/**
 * Whether an answer let the call through to a result: every decision but LangChain's `reject` does. `respond` gives the
 * person's message as the call's output, in place of the tool's.
 */
function approvedBy(answer: Json): boolean {
  return fieldOf(answer, "type") !== "reject";
}

/** What the person said with an answer, when they said anything. */
function messageOf(answer: Json): string | undefined {
  const message = fieldOf(answer, "message");
  return typeof message === "string" ? message : undefined;
}

/** Why a question was asked, in words, when its asker gave them: an approval's or a login's description. */
function reasonOf(value: Json): string | undefined {
  const description = fieldOf(value, "description");
  return typeof description === "string" ? description : undefined;
}

function fieldOf(value: Json, key: string): Json | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value[key]
    : undefined;
}

/** The text of a user message's content. */
function textOf(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .flatMap((block: { type?: string; text?: string }) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
}
