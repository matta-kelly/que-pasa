/**
 * One process of a crash test (crash.test.ts): it opens a runtime on a SQLite file and runs one run, in one of two
 * phases. "first" goes until the scenario's crash point, prints CRASH_POINT and waits there to be killed. "second" opens
 * the same file, runs the same run id again, and prints its outcome as one RESULT line.
 *
 *   node crash.fixture.ts <scenario> <first|second> <sqlite file> <log file>
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
import { z } from "zod";
import { defineAgent, defineTool, type Runtime } from "../define/index.ts";
import { openRuntime } from "./index.ts";

type Scenario = "model" | "unsafe-tool" | "safe-tool" | "after-submit";
const [scenario, phase, file, log] = process.argv.slice(2) as [
  Scenario,
  "first" | "second",
  string,
  string,
];

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

/** The step tool: it logs each run of itself with the context its run was given, and in the first phase waits there. */
const step = defineTool({
  name: "step",
  description: "Do the step.",
  schema: z.object({}),
  ...(scenario === "safe-tool" ? { replay: "safe" as const } : {}),
  run: async (_input, runtime: Runtime<{ tag: string }>) => {
    appendFileSync(log, `${runtime.context.tag}\n`);
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
        "after-submit": [submit],
      }[scenario],
);

const runtime = await openRuntime({
  storage: await openNodeSqliteStorage(file),
  models,
  agents: [agent],
});
let messages: Message[] = [];
const running = runtime.run(agent, "Go.", {
  runId: "run-1",
  caller: { id: "crash-test" },
  context: { tag: phase },
  onMessages: (all) => (messages = all),
});

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
