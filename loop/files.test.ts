import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import {
  MemoryStorage,
  ToolResultEntry,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAgent,
  defineTool,
  type ToolImage,
  withImages,
} from "../define/index.ts";
import { type FileStore, memoryFiles } from "../files/index.ts";
import {
  filesOf,
  maxImageBytes,
  openRuntime,
  type RunOptions,
  type Runtime,
} from "./index.ts";
import { resultOf, scripted } from "./scripted.fixture.ts";

const { faux, models, model } = scripted();
const caller = { id: "owner" };

/** What the render tool gives back, set by each test. */
let rendered: unknown;
const render = defineTool({
  name: "render",
  description: "Render barcodes.",
  schema: z.object({}),
  run: () => rendered,
});
const agent = defineAgent({
  name: "printer",
  model,
  instructions: "Print.",
  tools: [render],
});

const png = (name: string, bytes = [137, 80, 78, 71]): ToolImage => ({
  name,
  mediaType: "image/png",
  data: new Uint8Array(bytes),
});

/** Each request's tool results, as the model read them. */
const read: string[] = [];
const reading =
  (reply: ReturnType<typeof fauxAssistantMessage>) =>
  (request: { messages: Message[] }) => {
    for (const m of request.messages)
      if (m.role === "toolResult")
        read.push(
          m.content
            .map((b) => (b.type === "text" ? b.text : `[${b.type}]`))
            .join(""),
        );
    return reply;
  };

let runtime: Runtime | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

async function open(files?: FileStore) {
  read.length = 0;
  runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
    ...(files ? { files } : {}),
  });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("render", {}, { id: "r" })], {
      stopReason: "toolUse",
    }),
    reading(fauxAssistantMessage([fauxText("Done.")])),
  ]);
  await runtime
    .run(agent, "Print.", {
      conversation: "c",
      runId: "1",
      caller,
    } as RunOptions<undefined>)
    .then(resultOf);
  return runtime;
}

/** The render call's result entry. */
async function resultEntry(runtime: Runtime): Promise<EntryRecord> {
  const { items } = (await runtime.entries("c", {}, 50))!;
  return items.find((entry) => ToolResultEntry.is(entry))!;
}

describe("a tool's images", () => {
  it("are stored, and the conversation keeps their links: the model reads only the text", async () => {
    rendered = withImages("Rendered 2 barcodes.", [
      png("a.png"),
      png("b.png", [1, 2, 3]),
    ]);
    const runtime = await open(memoryFiles());
    expect(read).toEqual(["Rendered 2 barcodes."]);
    const entry = await resultEntry(runtime);
    const links = filesOf(entry);
    expect(links).toEqual([
      {
        id: expect.any(String),
        name: "a.png",
        mediaType: "image/png",
        size: 4,
      },
      {
        id: expect.any(String),
        name: "b.png",
        mediaType: "image/png",
        size: 3,
      },
    ]);
    // No bytes in the conversation: only the text and the links.
    expect(JSON.stringify(entry)).not.toContain("137,80");
    expect(await runtime.file("c", links[1]!.id)).toEqual({
      data: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      name: "b.png",
    });
  });

  it("each fail the call with why: no store, a type not an image's, an image too big, no name", async () => {
    const cases: [ToolImage[], FileStore | undefined, RegExp][] = [
      [[png("a.png")], undefined, /no file store/],
      [
        [{ ...png("a.svg"), mediaType: "image/svg+xml" as "image/png" }],
        memoryFiles(),
        /image\/svg\+xml, not one of/,
      ],
      [
        [{ ...png("big.png"), data: new Uint8Array(maxImageBytes + 1) }],
        memoryFiles(),
        /over 10485760/,
      ],
      [[png(" ")], memoryFiles(), /has no name/],
    ];
    for (const [images, files, why] of cases) {
      rendered = withImages("Rendered.", images);
      const runtime = await open(files);
      const result = (await resultEntry(runtime))
        .model?.[0] as ToolResultMessage;
      expect(result.isError).toBe(true);
      expect(read[0]).toMatch(why);
      await runtime.close();
    }
  });

  it("are none for a tool that gives a plain value: it is JSON text, as before", async () => {
    rendered = { content: "x", images: [] };
    const runtime = await open(memoryFiles());
    expect(read).toEqual([JSON.stringify({ content: "x", images: [] })]);
    expect(filesOf(await resultEntry(runtime))).toEqual([]);
  });

  it("are read back only by an id a call gave, on a conversation a run made", async () => {
    rendered = withImages("Rendered.", [png("a.png")]);
    const runtime = await open(memoryFiles());
    const [link] = filesOf(await resultEntry(runtime));
    expect(await runtime.file("none", link!.id)).toBeUndefined();
    expect(await runtime.file("c", "../../etc/passwd")).toBeUndefined();
    expect(await runtime.file("c", crypto.randomUUID())).toBeUndefined();
  });
});
