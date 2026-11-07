import type { Context } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import type {
  Cursor,
  EntryQuery,
  EntryRecord,
  Page,
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

/** The conversation's messages, oldest first, without the system entries: every page of its raw history. */
export async function messagesOf(
  reader: Entries,
  context: Context,
): Promise<Message[]> {
  const messages: Message[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await reader.entries(
      { order: "ascending" },
      100,
      cursor,
      context,
    );
    for (const entry of page.items) {
      for (const message of entry.model ?? []) {
        if (message.role !== "system") messages.push(message);
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return messages;
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

/** The text of the last assistant message: the answer of an agent with no output. */
export function answerOf(messages: readonly Message[]): string {
  const answer = messages.findLast((message) => message.role === "assistant");
  if (!answer || answer.role !== "assistant") return "";
  return answer.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

/** The details of the last successful result of the tool `name`: where the submit tool keeps the run's output. */
export function resultOf(
  messages: readonly Message[],
  name: string,
): { value: unknown } | undefined {
  const result = messages.findLast(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === name &&
      !message.isError,
  );
  return result?.role === "toolResult" ? { value: result.details } : undefined;
}
