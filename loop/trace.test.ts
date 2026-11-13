import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAgent,
  defineConnection,
  defineMiddleware,
  defineTool,
  type Middleware,
} from "../define/index.ts";
import { openRuntime } from "./index.ts";
import { scripted } from "./scripted.fixture.ts";
import { versionOf } from "./trace.ts";

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  trace.setGlobalTracerProvider(
    new TracerProvider({
      spanProcessors: [new SimpleSpanProcessor({ exporter })],
    }),
  );
});
afterEach(() => exporter.reset());

const caller = { id: "matt" };
const verdict = z.object({
  verdict: z.enum(["done", "raise"]),
  note: z.string(),
});
const stock = defineTool({
  name: "read_stock",
  description: "Read the stock of a SKU.",
  schema: z.object({ sku: z.string() }),
  run: () => "12",
});

/** One run on a fresh runtime, with the faux model's replies, and the spans it made. */
async function traced(
  replies: Parameters<ReturnType<typeof scripted>["faux"]["setResponses"]>[0],
  {
    output,
    captureContent = false,
    host = false,
    middleware,
  }: {
    output?: typeof verdict;
    captureContent?: boolean;
    host?: boolean;
    middleware?: readonly Middleware[];
  } = {},
) {
  exporter.reset();
  const { faux, models, model } = scripted();
  faux.setResponses(replies);
  const agent = defineAgent({
    name: "stock",
    model,
    instructions: "Read stock.",
    tools: [stock],
    ...(output ? { output } : {}),
    ...(middleware ? { middleware } : {}),
  });
  const runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
    captureContent,
  });
  const go = () =>
    runtime
      .run(agent, "How many A1?", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
      })
      .catch((error: unknown) => error);
  try {
    const outcome = host
      ? await trace
          .getTracer("host")
          .startActiveSpan("attempt", async (span) => {
            try {
              return await go();
            } finally {
              span.end();
            }
          })
      : await go();
    return { outcome, spans: exporter.getFinishedSpans(), model };
  } finally {
    await runtime.close();
  }
}

const named = (spans: readonly ReadableSpan[], prefix: string) =>
  spans.filter((span) => span.name.startsWith(prefix));
const only = (spans: readonly ReadableSpan[], prefix: string) => {
  const [span, ...more] = named(spans, prefix);
  if (!span || more.length > 0)
    throw new Error(
      `expected one span named ${prefix}, got ${named(spans, prefix).length}`,
    );
  return span;
};

const toolRun = [
  fauxAssistantMessage([fauxToolCall("read_stock", { sku: "A1" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage([fauxText("12 units.")]),
];

describe("a run's trace", () => {
  it("is an invoke_agent span with a chat span per model call and an execute_tool span per tool call under it", async () => {
    const { spans, model } = await traced(toolRun);
    const run = only(spans, "invoke_agent");
    expect(run.name).toBe("invoke_agent stock");
    expect(named(spans, "chat ")).toHaveLength(2);
    const tool = only(spans, "execute_tool");
    expect(tool.name).toBe("execute_tool read_stock");
    for (const child of [...named(spans, "chat "), tool]) {
      expect(child.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(run.spanContext().traceId);
    }
    const [provider, modelId] = model.split(":");
    expect(run.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.name": "stock",
      "gen_ai.conversation.id": "chat-1",
      "que_pasa.run.id": "run-1",
      "gen_ai.provider.name": provider,
      "gen_ai.request.model": modelId,
      "enduser.id": "matt",
      "que_pasa.resumed": false,
    });
    expect(run.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(run.attributes["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);
    expect(run.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it("puts on each chat span its model, its finish reason and its tokens", async () => {
    const { spans } = await traced(toolRun);
    const [first, second] = named(spans, "chat ");
    expect(first?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "toolUse",
    ]);
    expect(second?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "stop",
    ]);
    expect(first?.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(first?.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(only(spans, "execute_tool").attributes).toMatchObject({
      "gen_ai.tool.name": "read_stock",
      "gen_ai.tool.type": "function",
    });
  });

  it("hangs from the host's span when the run is started in one", async () => {
    const { spans } = await traced(toolRun, { host: true });
    const host = only(spans, "attempt");
    const run = only(spans, "invoke_agent");
    expect(run.parentSpanContext?.spanId).toBe(host.spanContext().spanId);
    expect(run.spanContext().traceId).toBe(host.spanContext().traceId);
    // The run ends inside the host's span: the exporter gets spans in the order they end.
    expect(spans.indexOf(run)).toBeLessThan(spans.indexOf(host));
  });

  it("records no message content unless the host asks for it", async () => {
    const off = (await traced(toolRun)).spans;
    for (const span of off) {
      for (const key of Object.keys(span.attributes)) {
        expect(key).not.toMatch(
          /messages|instructions|definitions|arguments|result/,
        );
      }
    }
    const on = (await traced(toolRun, { captureContent: true })).spans;
    expect(
      only(on, "invoke_agent").attributes["gen_ai.system_instructions"],
    ).toContain("Read stock.");
    expect(
      only(on, "invoke_agent").attributes["gen_ai.tool.definitions"],
    ).toContain("read_stock");
    expect(
      only(on, "invoke_agent").attributes["gen_ai.input.messages"],
    ).toContain("How many A1?");
    expect(
      only(on, "invoke_agent").attributes["gen_ai.output.messages"],
    ).toContain("12 units.");
    expect(
      named(on, "chat ")[1]?.attributes["gen_ai.input.messages"],
    ).toContain("read_stock");
    expect(
      only(on, "execute_tool").attributes["gen_ai.tool.call.arguments"],
    ).toContain("A1");
    expect(only(on, "execute_tool").attributes["gen_ai.tool.call.result"]).toBe(
      "12",
    );
  });

  it("records the system prompt as the model gets it: each middleware's section from its run, then the instructions", async () => {
    const notes = defineMiddleware<string>({
      name: "notes",
      beforeAgent: () => "Stock is counted daily.",
      systemPrompt: (state) => state ?? undefined,
    });
    const on = (
      await traced(toolRun, { captureContent: true, middleware: [notes] })
    ).spans;
    expect(
      JSON.parse(
        String(
          only(on, "invoke_agent").attributes["gen_ai.system_instructions"],
        ),
      ),
    ).toEqual([
      { type: "text", content: "Stock is counted daily." },
      { type: "text", content: "Read stock." },
    ]);
  });

  it("marks a tool call that failed with its error type", async () => {
    const { faux, models, model } = scripted();
    const broken = defineTool({
      name: "broken",
      description: "Fails.",
      schema: z.object({}),
      run: () => {
        throw new Error("no stock system");
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("broken", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("It failed.")]),
    ]);
    const agent = defineAgent({
      name: "broken",
      model,
      instructions: "Try.",
      tools: [broken],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
    });
    try {
      await runtime.run(agent, "Go", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
      });
    } finally {
      await runtime.close();
    }
    const tool = only(exporter.getFinishedSpans(), "execute_tool");
    expect(tool.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool.attributes["error.type"]).toBeTypeOf("string");
  });

  it("marks a run that ended with no submit as failed, with an event for each reminder", async () => {
    const { outcome, spans } = await traced(
      [
        fauxAssistantMessage([fauxText("Done.")]),
        fauxAssistantMessage([fauxText("Done.")]),
        fauxAssistantMessage([fauxText("Done.")]),
      ],
      { output: verdict },
    );
    expect(outcome).toBeInstanceOf(Error);
    const run = only(spans, "invoke_agent");
    expect(run.status.code).toBe(SpanStatusCode.ERROR);
    expect(run.attributes["error.type"]).toBe("no_submit");
    expect(
      run.events.filter((event) => event.name === "que_pasa.reminder"),
    ).toHaveLength(2);
  });

  it("is one trace per run of a conversation, each tagged with the conversation and the run, with the run's own usage and content", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Paris, the capital and largest city of France."),
      ]),
      fauxAssistantMessage([fauxText("Rome.")]),
    ]);
    const agent = defineAgent({
      name: "geo",
      model,
      instructions: "Answer.",
      tools: [],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
      captureContent: true,
    });
    try {
      await runtime.run(agent, "Capital of France?", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
      });
      await runtime.run(agent, "And of Italy?", {
        conversation: "chat-1",
        runId: "run-2",
        caller,
      });
    } finally {
      await runtime.close();
    }
    const [first, second] = named(exporter.getFinishedSpans(), "invoke_agent");
    expect(first?.attributes).toMatchObject({
      "gen_ai.conversation.id": "chat-1",
      "que_pasa.run.id": "run-1",
    });
    expect(second?.attributes).toMatchObject({
      "gen_ai.conversation.id": "chat-1",
      "que_pasa.run.id": "run-2",
    });
    expect(first?.spanContext().traceId).not.toBe(
      second?.spanContext().traceId,
    );
    const output = (span: ReadableSpan | undefined) =>
      span?.attributes["gen_ai.usage.output_tokens"] as number;
    expect(output(second)).toBeGreaterThan(0);
    expect(output(second)).toBeLessThan(output(first));
    expect(second?.attributes["gen_ai.input.messages"]).toContain(
      "And of Italy?",
    );
    expect(second?.attributes["gen_ai.input.messages"]).not.toContain(
      "Capital of France?",
    );
    expect(second?.attributes["gen_ai.output.messages"]).toContain("Rome.");
  });

  it("never holds a connection's login, with content captured", async () => {
    const { faux, models, model } = scripted();
    const crm = defineConnection({
      name: "crm",
      owner: "user",
      credential: z.object({ token: z.string() }),
      connect: ({ token }) => ({ rows: token.length }),
    });
    const count = defineTool({
      name: "count_rows",
      description: "Count the CRM's rows.",
      schema: z.object({}),
      uses: [crm],
      run: async (_input, runtime) => `${(await runtime.use(crm)).rows} rows`,
    });
    const agent = defineAgent({
      name: "counter",
      model,
      instructions: "Count.",
      tools: [count],
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("count_rows", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
      captureContent: true,
      credentialFor: () => ({ token: "tok-very-secret" }),
    });
    try {
      await runtime.run(agent, "Count.", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
      });
    } finally {
      await runtime.close();
    }
    const spans = exporter.getFinishedSpans();
    expect(JSON.stringify(spans.map((span) => span.attributes))).toContain(
      "15 rows",
    );
    expect(
      JSON.stringify(
        spans.map((span) => ({ a: span.attributes, e: span.events })),
      ),
    ).not.toContain("tok-very-secret");
  });

  it("gives an agent one version on one model, and another when what it is changes", () => {
    const { model } = scripted();
    const agent = defineAgent({
      name: "stock",
      model,
      instructions: "Read stock.",
      tools: [stock],
    });
    const same = defineAgent({
      name: "stock",
      model,
      instructions: "Read stock.",
      tools: [stock],
    });
    const changed = defineAgent({
      name: "stock",
      model,
      instructions: "Read stock, briefly.",
      tools: [stock],
    });
    expect(versionOf(agent, model)).toBe(versionOf(same, model));
    expect(versionOf(agent, model)).not.toBe(versionOf(changed, model));
    expect(versionOf(agent, model)).not.toBe(versionOf(agent, "other:model"));
    const noted = defineAgent({
      name: "stock",
      model,
      instructions: "Read stock.",
      tools: [stock],
      middleware: [defineMiddleware({ name: "notes" })],
    });
    expect(versionOf(noted, model)).not.toBe(versionOf(agent, model));
  });
});
