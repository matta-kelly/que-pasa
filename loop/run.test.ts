import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool, type Runtime } from "../define/index.ts";
import { run, type RunUsage } from "./index.ts";

/** A scripted model: each test queues the replies it gives, in order. */
function scripted() {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  return { faux, models, model: `${model.provider}:${model.id}` };
}

const caller = { id: "matt" };
const verdict = z.object({
  verdict: z.enum(["done", "raise"]),
  note: z.string(),
});

describe("run", () => {
  it("gives back the answer as text, for an agent with no output", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const agent = defineAgent({
      name: "geo",
      model,
      instructions: "Answer briefly.",
      tools: [],
    });

    await expect(
      run(agent, "Capital of France?", { caller, models }),
    ).resolves.toBe("Paris.");
  });

  it("calls a tool with its checked input and the run's caller, and gives the model its result", async () => {
    const { faux, models, model } = scripted();
    const calls: { sku: string; caller: string }[] = [];
    const stock = defineTool({
      name: "read_stock",
      description: "Read the stock of a SKU.",
      schema: z.object({ sku: z.string() }),
      run: ({ sku }, runtime) => {
        calls.push({ sku, caller: runtime.caller.id });
        return { sku, units: 12 };
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_stock", { sku: "A1" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("12 units.")]),
    ]);
    const agent = defineAgent({
      name: "stock",
      model,
      instructions: "Read stock.",
      tools: [stock],
    });

    await expect(run(agent, "How many A1?", { caller, models })).resolves.toBe(
      "12 units.",
    );
    expect(calls).toEqual([{ sku: "A1", caller: "matt" }]);
    expect(faux.state.callCount).toBe(2);
  });

  it("gives back the submitted output, and makes no model call after it", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "done", note: "ok" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });

    await expect(
      run(agent, "Judge this.", { caller, models }),
    ).resolves.toEqual({ verdict: "done", note: "ok" });
    expect(faux.state.callCount).toBe(1);
  });

  it("sends a submit that fails the schema back to the model, which tries again", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "maybe", note: "?" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "raise", note: "unclear" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });

    await expect(
      run(agent, "Judge this.", { caller, models }),
    ).resolves.toEqual({
      verdict: "raise",
      note: "unclear",
    });
    expect(faux.state.callCount).toBe(2);
  });

  it("reminds an agent that answers in text instead of submitting", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage([fauxText("It is done.")]),
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "done", note: "ok" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });

    await expect(
      run(agent, "Judge this.", { caller, models }),
    ).resolves.toEqual({ verdict: "done", note: "ok" });
  });

  it("fails when the agent never submits, after two reminders", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Really done.")]),
      fauxAssistantMessage([fauxText("Still done.")]),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });

    await expect(run(agent, "Judge this.", { caller, models })).rejects.toThrow(
      "no submit",
    );
    expect(faux.state.callCount).toBe(3);
  });

  it("refuses an agent with an output and a tool named submit", async () => {
    const { models, model } = scripted();
    const submit = defineTool({
      name: "submit",
      description: "Clash.",
      schema: z.object({}),
      run: () => "",
    });
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [submit],
      output: verdict,
    });

    await expect(run(agent, "Judge this.", { caller, models })).rejects.toThrow(
      'a tool is named "submit"',
    );
  });

  it("gives each tool the context the run was given", async () => {
    const { faux, models, model } = scripted();
    type Sandbox = { container: string };
    const seen: string[] = [];
    const where = defineTool({
      name: "where",
      description: "Say which container the run is in.",
      schema: z.object({}),
      run: (_input, runtime: Runtime<Sandbox>) => {
        seen.push(runtime.context.container);
        return runtime.context.container;
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("where", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("In attempt-1.")]),
    ]);
    const agent = defineAgent({
      name: "where",
      model,
      instructions: "Say where.",
      tools: [where],
    });

    await run(agent, "Where?", {
      caller,
      models,
      context: { container: "attempt-1" },
    });
    expect(seen).toEqual(["attempt-1"]);
  });

  it("rejects at once on a signal already aborted, with no model call", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([fauxAssistantMessage([fauxText("Too late.")])]);
    const agent = defineAgent({
      name: "geo",
      model,
      instructions: "Answer.",
      tools: [],
    });
    const reason = new Error("time limit");

    await expect(
      run(agent, "Hi", { caller, models, signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(faux.state.callCount).toBe(0);
  });

  it("stops a run that is going when its signal aborts, and makes no model call after it", async () => {
    const { faux, models, model } = scripted();
    const controller = new AbortController();
    const reason = new Error("time limit");
    const slow = defineTool({
      name: "slow",
      description: "Takes long.",
      schema: z.object({}),
      run: () => {
        controller.abort(reason);
        return "late";
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("slow", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Should not be asked.")]),
    ]);
    const agent = defineAgent({
      name: "slow",
      model,
      instructions: "Work.",
      tools: [slow],
    });

    await expect(
      run(agent, "Go", { caller, models, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(faux.state.callCount).toBe(1);
  });

  it("reports what the run spent, once, keyed by its model", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const agent = defineAgent({
      name: "geo",
      model,
      instructions: "Answer briefly.",
      tools: [],
    });
    const reports: RunUsage[] = [];

    await run(agent, "Capital of France?", {
      caller,
      models,
      onUsage: (usage) => reports.push(usage),
    });
    expect(reports).toHaveLength(1);
    const spent = reports[0]?.models[model.replace(":", "/")];
    expect(spent?.totalTokens).toBeGreaterThan(0);
  });

  it("reports what a failed run spent too", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Done.")]),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });
    const reports: RunUsage[] = [];

    await expect(
      run(agent, "Judge this.", {
        caller,
        models,
        onUsage: (usage) => reports.push(usage),
      }),
    ).rejects.toThrow("no submit");
    expect(reports).toHaveLength(1);
  });
});
