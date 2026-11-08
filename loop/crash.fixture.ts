/**
 * One process of a crash test (crash.test.ts): it opens a runtime on a SQLite file and runs one run, in one of two
 * phases. "first" goes until the scenario's crash point, prints CRASH_POINT and waits there to be killed. "second" opens
 * the same file, runs the same run id again, and prints its outcome as one RESULT line. The first phase runs inside a
 * host span, as a host would, and prints its ids as one HOST line; every span is written to the spans file as it ends,
 * so the spans of a killed process are kept.
 *
 *   node crash.fixture.ts <scenario> <first|second> <sqlite file> <log file> <spans file>
 */
import { appendFileSync, readFileSync } from "node:fs";
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
import { openRuntime, provide } from "./index.ts";

type Scenario =
  "model" | "unsafe-tool" | "safe-tool" | "resource" | "after-submit";
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

const faux = fauxProvider(
  scenario === "model" && phase === "first" ? { tokensPerSecond: 2 } : {},
);
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
  ...(scenario === "safe-tool" || scenario === "resource"
    ? { replay: "safe" as const }
    : {}),
  run: async (_input, runtime: Runtime<{ tag: string }>) => {
    const seen =
      scenario === "resource" ? await runtime.use(tag) : runtime.context.tag;
    appendFileSync(log, `${seen}\n`);
    return phase === "first" ? crashPoint() : "stepped";
  },
});
const agent = defineAgent({
  name: "worker",
  model: `${model.provider}:${model.id}`,
  instructions: "Do the step, then submit.",
  tools: [step],
  output: z.object({ verdict: z.enum(["done", "raise"]), note: z.string() }),
});

faux.setResponses(
  phase === "second"
    ? scenario === "after-submit"
      ? []
      : [submit]
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
        "after-submit": [submit],
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
const go = () =>
  runtime.run(agent, "Go.", {
    runId: "run-1",
    caller: { id: "crash-test" },
    context: { tag: phase },
    onMessages: (all) => (messages = all),
  });
// The host's span of the first phase never ends: its process is killed.
const host = trace.getTracer("host").startSpan("attempt");
if (phase === "first")
  console.log(
    `HOST ${host.spanContext().traceId} ${host.spanContext().spanId}`,
  );
const running =
  phase === "first"
    ? context.with(trace.setSpan(context.active(), host), go)
    : go();

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
  console.log(
    `RESULT ${JSON.stringify({ value, calls: faux.state.callCount, ran, messages: brief })}`,
  );
  await runtime.close();
}
