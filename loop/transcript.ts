import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Page,
  type SettledSubmissionRecord,
  SystemEntry,
} from "@earendil-works/pi-durable";

/** A reader of one conversation's raw history: a conversation, or a hook's api. */
type Entries = {
  entries(
    query: Omit<EntryQuery, "conversationId">,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>>;
};

/** The entries from `from` (the first, when left out) to `to` (the last), as their messages, oldest first, without the system entries. */
async function* messages(
  reader: Entries,
  range: { from?: EntryId; to?: EntryId },
  context: Context,
): AsyncGenerator<Message> {
  const query = {
    order: "ascending" as const,
    ...(range.from === undefined ? {} : { minEntryId: range.from }),
    ...(range.to === undefined ? {} : { maxEntryId: range.to }),
  };
  let cursor: Cursor | undefined;
  do {
    const page = await reader.entries(query, 100, cursor, context);
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "system") yield message;
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
}

/** The conversation's messages, oldest first, without the system entries; from the entry `from`, when given. */
export async function messagesOf(
  reader: Entries,
  context: Context,
  from?: EntryId,
): Promise<Message[]> {
  const all: Message[] = [];
  for await (const message of messages(
    reader,
    from === undefined ? {} : { from },
    context,
  ))
    all.push(message);
  return all;
}

/**
 * A page of the conversation's entries, as pi's `entries()` gives it, without its system entries: the instructions and
 * the tool definitions are the deployment's, not the client's. The page is filled to `limit` while the scan has more, and
 * `next` is pi's cursor, set only while it does, so pi's `ConversationTranscript` pages it as it pages pi's own.
 */
export async function entriesOf(
  reader: Entries,
  query: Omit<EntryQuery, "conversationId">,
  limit: number,
  cursor: Cursor | undefined,
  context: Context,
): Promise<Page<EntryRecord, Cursor>> {
  const items: EntryRecord[] = [];
  let next = cursor;
  do {
    // Never more than the page has room for, so pi's cursor continues right after the last entry given.
    const page = await reader.entries(
      query,
      limit - items.length,
      next,
      context,
    );
    items.push(...page.items.filter((entry) => !SystemEntry.is(entry)));
    next = page.next;
  } while (next !== undefined && items.length < limit);
  return next === undefined ? { items } : { items, next };
}

/** The text of a user message. */
export function userText(message: Message): string | undefined {
  if (message.role !== "user") return undefined;
  const { content } = message;
  return typeof content === "string"
    ? content
    : content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
}

/** The text of an assistant message. */
export function answerText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

/** Whether `messages` hold a successful result of the tool `name`. */
export function hasResult(messages: readonly Message[], name: string): boolean {
  return messages.some(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === name &&
      !message.isError,
  );
}

/**
 * What a run gave, read from its own submission and never from the rest of the conversation: its input, its answer, and,
 * when its answer called the tool `submit`, that call's successful result, whose details are the run's output.
 */
export type Outcome = {
  input?: Message;
  answer?: AssistantMessage;
  submitted?: { value: unknown };
};

/** A settled run's outcome, from its submission record: its input entry, its answer entry, and the results after it. */
export async function outcomeOf(
  reader: Entries,
  record: SettledSubmissionRecord,
  submit: string,
  context: Context,
): Promise<Outcome> {
  const outcome: Outcome = {};
  if (record.type !== "input") return outcome;
  if (record.entry !== undefined) {
    for await (const message of messages(
      reader,
      { from: record.entry, to: record.entry },
      context,
    )) {
      if (message.role === "user") outcome.input = message;
    }
  }
  if (record.answer === undefined) return outcome;
  // The answer, then the results of its calls, which follow it: a submit among them is the run's output.
  let calls: Set<string> | undefined;
  for await (const message of messages(
    reader,
    { from: record.answer },
    context,
  )) {
    if (!calls) {
      if (message.role !== "assistant") continue;
      outcome.answer = message;
      calls = new Set(
        message.content.flatMap((block) =>
          block.type === "toolCall" && block.name === submit ? [block.id] : [],
        ),
      );
      if (calls.size === 0) break;
      continue;
    }
    if (message.role !== "toolResult") break;
    if (calls.has(message.toolCallId) && !message.isError) {
      outcome.submitted = { value: message.details };
      break;
    }
  }
  return outcome;
}
