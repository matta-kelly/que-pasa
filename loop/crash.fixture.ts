/**
 * One process of a crash test (crash.test.ts): it opens a runtime on a SQLite file and runs one run, in one of two
 * phases. "first" goes until the scenario's crash point, prints CRASH_POINT and waits there to be killed; in the
 * second-run scenario, a first run on the same conversation ends before it. "second" opens the same file, runs the same
 * run id again, and prints its outcome as one RESULT line. The first phase runs inside a
 * host span, as a host would, and prints its ids as one HOST line; every span is written to the spans file as it ends,
 * so the spans of a killed process are kept.
 *
 *   node crash.fixture.ts <scenario> <first|second> <sqlite file> <log file> <spans file>
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { z } from "zod";
import {
  defineAgent,
  defineResource,
  defineTool,
  type Runtime,
} from "../define/index.ts";
import { memory } from "../middleware/index.ts";
import { local } from "../sandbox/index.ts";
import { openRuntime, provide } from "./index.ts";

type Scenario =
  | "model"
  | "unsafe-tool"
  | "safe-tool"
  | "resource"
  | "memory"
  | "after-submit"
  | "second-run";
const [scenario, phase, file, log, spans] = process.argv.slice(2) as [
  Scenario,
  "first" | "second",
  string,
  string,
  string,
];

/** Each span, as one JSON line in the spans file, written when it ends. */
const toFile = {
  export(ended: ReadableSpan[], done: (result: { code: 0 }) => void) {
    for (const span of ended) {
      const { traceId, spanId } = span.spanContext();
      const line = {
        name: span.name,
        traceId,
        spanId,
        parentSpanId: span.parentSpanContext?.spanId,
        attributes: span.attributes,
      };
      appendFileSync(spans, `${JSON.stringify(line)}\n`);
    }
    done({ code: 0 });
  },
  shutdown: async () => {},
};
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(
  new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: toFile })],
  }),
);

const crashPoint = () => {
  console.log("CRASH_POINT");
  return new Promise<never>(() => {});
};

const faux = fauxProvider({
  models: [{ id: "main" }, { id: "fallback" }],
  ...(scenario === "model" && phase === "first" ? { tokensPerSecond: 2 } : {}),
});
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();
const submit = fauxAssistantMessage(
  [fauxToolCall("submit", { verdict: "done", note: "ok" })],
  {
    stopReason: "toolUse",
  },
);

/** What the host provides each run: resolved from the context the run was started with, and named by this process. */
const tag = defineResource<string>("tag");

/**
 * The step tool: it logs each run of itself with the context its run was given, or in the resource scenario with the
 * run's resource, and in the first phase waits there.
 */
const step = defineTool({
  name: "step",
  description: "Do the step.",
  schema: z.object({}),
  uses: [tag],
  ...(scenario === "safe-tool" ||
  scenario === "resource" ||
  scenario === "memory"
    ? { replay: "safe" as const }
    : {}),
  run: async (_input, runtime: Runtime<{ tag: string }>) => {
    const seen =
      scenario === "resource" ? await runtime.use(tag) : runtime.context.tag;
    appendFileSync(log, `${seen}\n`);
    return phase === "first" ? crashPoint() : "stepped";
  },
});
/**
 * In the memory scenario, the agent's memory file, beside the log: each phase writes its own text first, so the second
 * phase's file has changed since the run started.
 */
const folder = dirname(log);
if (scenario === "memory")
  writeFileSync(`${folder}/memory.md`, `memory of the ${phase} phase\n`);
const agent = defineAgent({
  name: "worker",
  model: `${model.provider}:${model.id}`,
  instructions: "Do the step, then submit.",
  tools: [step],
  output: z.object({ verdict: z.enum(["done", "raise"]), note: z.string() }),
  ...(scenario === "memory"
    ? {
        middleware: [
          memory({ backend: local({ root: folder }), sources: ["memory.md"] }),
        ],
      }
    : {}),
});

/** The system prompt of each model request of this process, as its sections' text. */
const prompts: string[] = [];
const seeing =
  (reply: ReturnType<typeof fauxAssistantMessage>) =>
  (request: { messages: Message[] }) => {
    prompts.push(
      request.messages
        .flatMap((m) =>
          m.role === "system"
            ? Object.values(
                (m as { sections?: Record<string, string> }).sections ?? {},
              )
            : [],
        )
        .join("\n"),
    );
    return reply;
  };

faux.setResponses(
  phase === "second"
    ? scenario === "after-submit"
      ? []
      : [seeing(submit)]
    : {
        model: [
          fauxAssistantMessage([
            fauxText("A long answer that is still being written. ".repeat(20)),
          ]),
        ],
        "unsafe-tool": [
          fauxAssistantMessage([fauxToolCall("step", {})], {
            stopReason: "toolUse",
          }),
        ],
        "safe-tool": [
          fauxAssistantMessage([fauxToolCall("step", {})], {
            stopReason: "toolUse",
          }),
        ],
        resource: [
          fauxAssistantMessage([fauxToolCall("step", {})], {
            stopReason: "toolUse",
          }),
        ],
        memory: [
          fauxAssistantMessage([fauxToolCall("step", {})], {
            stopReason: "toolUse",
          }),
        ],
        "after-submit": [submit],
        "second-run": [
          fauxAssistantMessage(
            [fauxToolCall("submit", { verdict: "raise", note: "first run" })],
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage([fauxToolCall("step", {})], {
            stopReason: "toolUse",
          }),
        ],
      }[scenario],
);

const runtime = await openRuntime({
  storage: await openNodeSqliteStorage(file),
  models,
  agents: [agent],
  resources: [
    provide(
      tag,
      ({ context }) => `${(context as { tag: string }).tag} in ${phase}`,
    ),
  ],
});
let messages: Message[] = [];
const go = (runId: string, model?: string) =>
  runtime.run(agent, "Go.", {
    conversation: "chat-1",
    runId,
    caller: { id: "crash-test" },
    // Each phase gives the context the conversation was made with, as every run on it must.
    context: { tag: "first" },
    ...(model ? { model } : {}),
    onMessages: (all) => (messages = all),
  });
// The second-run scenario's run is the conversation's second, on the fallback model: the first ends before it starts.
const runId = scenario === "second-run" ? "run-2" : "run-1";
if (scenario === "second-run" && phase === "first") await go("run-1");
// The host's span of the first phase never ends: its process is killed.
const host = trace.getTracer("host").startSpan("attempt");
if (phase === "first")
  console.log(
    `HOST ${host.spanContext().traceId} ${host.spanContext().spanId}`,
  );
const running =
  phase === "first"
    ? context.with(trace.setSpan(context.active(), host), () =>
        go(
          runId,
          scenario === "second-run"
            ? `${faux.provider.id}:fallback`
            : undefined,
        ),
      )
    : go(runId);

if (phase === "first") {
  if (scenario === "model") setTimeout(() => void crashPoint(), 300);
  await running;
  if (scenario === "after-submit") await crashPoint();
} else {
  const value = await running;
  const brief = messages.map((message) =>
    message.role === "toolResult"
      ? `${message.toolName}${message.isError ? " error" : ""}`
      : message.role,
  );
  const ran = readFileSync(log, { encoding: "utf8", flag: "a+" })
    .split("\n")
    .filter(Boolean);
  const answeredBy = messages.flatMap((message) =>
    message.role === "assistant" ? [message.model] : [],
  );
  console.log(
    `RESULT ${JSON.stringify({ value, calls: faux.state.callCount, ran, messages: brief, models: answeredBy, prompts })}`,
  );
  await runtime.close();
}
