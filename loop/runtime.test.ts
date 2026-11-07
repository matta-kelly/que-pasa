import {
  type Message,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool, type Runtime } from "../define/index.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Json, Agent } from "../define/index.ts";
import { openRuntime, type RunOptions, type RunUsage } from "./index.ts";
import { scripted } from "./scripted.fixture.ts";

const caller = { id: "matt" };

/** One run on a fresh runtime in memory, closed after: what most tests need. */
async function once<
  O extends z.ZodObject | undefined,
  C extends Json | undefined,
>(
  agent: Agent<O, C>,
  input: string,
  { models, ...options }: Omit<RunOptions<C>, "runId"> & { models: Models },
) {
  const runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  try {
    return await runtime.run(agent, input, {
      runId: "run-1",
      ...options,
    } as RunOptions<C>);
  } finally {
    await runtime.close();
  }
}
const verdict = z.object({
  verdict: z.enum(["done", "raise"]),
  note: z.string(),
});

describe("a run", () => {
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
      once(agent, "Capital of France?", { caller, models }),
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

    await expect(once(agent, "How many A1?", { caller, models })).resolves.toBe(
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
      once(agent, "Judge this.", { caller, models }),
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
      once(agent, "Judge this.", { caller, models }),
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
      once(agent, "Judge this.", { caller, models }),
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

    await expect(
      once(agent, "Judge this.", { caller, models }),
    ).rejects.toThrow("no submit");
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

    await expect(
      once(agent, "Judge this.", { caller, models }),
    ).rejects.toThrow('a tool is named "submit"');
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

    await once(agent, "Where?", {
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
      once(agent, "Hi", { caller, models, signal: AbortSignal.abort(reason) }),
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
      once(agent, "Go", { caller, models, signal: controller.signal }),
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

    await once(agent, "Capital of France?", {
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
      once(agent, "Judge this.", {
        caller,
        models,
        onUsage: (usage) => reports.push(usage),
      }),
    ).rejects.toThrow("no submit");
    expect(reports).toHaveLength(1);
  });

  it("lets the model leave out a field with a default, and the tool gets the default", async () => {
    const { faux, models, model } = scripted();
    const reads: { path: string; offset: number }[] = [];
    const read = defineTool({
      name: "read_file",
      description: "Read a file.",
      schema: z.object({ path: z.string(), offset: z.number().default(0) }),
      run: (input) => {
        reads.push(input);
        return "contents";
      },
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("read_file", { path: "a.ts" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "done", note: "read" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const agent = defineAgent({
      name: "reader",
      model,
      instructions: "Read.",
      tools: [read],
      output: verdict,
    });

    await once(agent, "Read a.ts", { caller, models });
    expect(reads).toEqual([{ path: "a.ts", offset: 0 }]);
  });

  it("lets the model leave out a submit field with a default", async () => {
    const { faux, models, model } = scripted();
    const output = z.object({
      verdict: z.enum(["done", "raise"]),
      note: z.string().default("none"),
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("submit", { verdict: "done" })], {
        stopReason: "toolUse",
      }),
    ]);
    const agent = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output,
    });

    await expect(
      once(agent, "Judge this.", { caller, models }),
    ).resolves.toEqual({ verdict: "done", note: "none" });
  });

  describe("onMessages", () => {
    /** Each message as its role and its text or tool call, to compare in order. */
    function brief(messages: Message[]) {
      return messages.map((message) => {
        if (message.role === "user") {
          const content = message.content;
          return `user: ${typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("")}`;
        }
        if (message.role === "assistant") {
          return `assistant: ${message.content
            .map((b) =>
              b.type === "text"
                ? b.text
                : b.type === "toolCall"
                  ? `call ${b.name}`
                  : "",
            )
            .join("")}`;
        }
        if (message.role === "toolResult") {
          return `result ${message.toolName}: ${message.content.map((b) => (b.type === "text" ? b.text : "")).join("")}`;
        }
        return message.role;
      });
    }

    it("gives the whole conversation in order, with each tool call and its result", async () => {
      const { faux, models, model } = scripted();
      const stock = defineTool({
        name: "read_stock",
        description: "Read stock.",
        schema: z.object({ sku: z.string() }),
        run: () => "12",
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
      const calls: Message[][] = [];

      await once(agent, "How many A1?", {
        caller,
        models,
        onMessages: (messages) => calls.push(messages),
      });
      expect(calls).toHaveLength(1);
      expect(brief(calls[0] ?? [])).toEqual([
        "user: How many A1?",
        "assistant: call read_stock",
        "result read_stock: 12",
        "assistant: 12 units.",
      ]);
    });

    it("keeps the reminders the run sent, and the submit and its result", async () => {
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
      let seen: Message[] = [];

      await once(agent, "Judge this.", {
        caller,
        models,
        onMessages: (messages) => (seen = messages),
      });
      expect(brief(seen)).toEqual([
        "user: Judge this.",
        "assistant: It is done.",
        "user: You have not given your result. Call submit with it.",
        "assistant: call submit",
        "result submit: Result received.",
      ]);
    });

    it("is called for a run that fails, before run() rejects", async () => {
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
      const calls: Message[][] = [];

      await expect(
        once(agent, "Judge this.", {
          caller,
          models,
          onMessages: (messages) => calls.push(messages),
        }),
      ).rejects.toThrow("no submit");
      expect(calls).toHaveLength(1);
      expect(
        calls[0]?.filter((message) => message.role === "assistant"),
      ).toHaveLength(3);
    });

    it("is called for a run its signal stops", async () => {
      const { faux, models, model } = scripted();
      const controller = new AbortController();
      const stop = defineTool({
        name: "stop",
        description: "Stops.",
        schema: z.object({}),
        run: () => {
          controller.abort(new Error("time limit"));
          return "stopped";
        },
      });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("stop", {})], {
          stopReason: "toolUse",
        }),
      ]);
      const agent = defineAgent({
        name: "stop",
        model,
        instructions: "Go.",
        tools: [stop],
      });
      const calls: Message[][] = [];

      await expect(
        once(agent, "Go", {
          caller,
          models,
          signal: controller.signal,
          onMessages: (messages) => calls.push(messages),
        }),
      ).rejects.toThrow("time limit");
      expect(calls).toHaveLength(1);
      expect(brief(calls[0] ?? []).slice(0, 2)).toEqual([
        "user: Go",
        "assistant: call stop",
      ]);
    });
  });
});

describe("a runtime", () => {
  function setup() {
    const { faux, models, model } = scripted();
    const geo = defineAgent({
      name: "geo",
      model,
      instructions: "Answer briefly.",
      tools: [],
    });
    const judge = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });
    return { faux, models, geo, judge };
  }

  it("gives back the result of a run started again with its run id, with no model call", async () => {
    const { faux, models, geo } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    try {
      await expect(
        runtime.run(geo, "Capital of France?", { runId: "a", caller }),
      ).resolves.toBe("Paris.");
      await expect(
        runtime.run(geo, "Capital of France?", { runId: "a", caller }),
      ).resolves.toBe("Paris.");
      expect(faux.state.callCount).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("runs several agents, each run on its own", async () => {
    const { faux, models, geo, judge } = setup();
    faux.setResponses([
      fauxAssistantMessage([fauxText("Paris.")]),
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "raise", note: "no" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo, judge],
    });
    try {
      await expect(
        runtime.run(geo, "Capital of France?", { runId: "a", caller }),
      ).resolves.toBe("Paris.");
      await expect(
        runtime.run(judge, "Judge this.", { runId: "b", caller }),
      ).resolves.toEqual({
        verdict: "raise",
        note: "no",
      });
    } finally {
      await runtime.close();
    }
  });

  it("reports each run's own usage, not the runtime's total", async () => {
    const { faux, models, geo } = setup();
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Paris, the capital and largest city of France."),
      ]),
      fauxAssistantMessage([fauxText("Rome.")]),
    ]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    const spent: number[] = [];
    const onUsage = (usage: RunUsage) =>
      spent.push(
        Object.values(usage.models).reduce((sum, u) => sum + u.output, 0),
      );
    try {
      await runtime.run(geo, "Capital of France?", {
        runId: "a",
        caller,
        onUsage,
      });
      await runtime.run(geo, "Capital of Italy?", {
        runId: "b",
        caller,
        onUsage,
      });
      expect(spent).toHaveLength(2);
      expect(spent[1]).toBeLessThan(spent[0] ?? 0);
      expect(spent[1]).toBeGreaterThan(0);
    } finally {
      await runtime.close();
    }
  });

  it("refuses an agent it was not opened with", async () => {
    const { models, geo, judge } = setup();
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    try {
      await expect(
        runtime.run(judge, "Judge this.", { runId: "a", caller }),
      ).rejects.toThrow('agent "judge" was not given when the runtime opened');
    } finally {
      await runtime.close();
    }
  });

  it("refuses a run id that belongs to another agent's run", async () => {
    const { faux, models, geo, judge } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo, judge],
    });
    try {
      await runtime.run(geo, "Capital of France?", { runId: "a", caller });
      await expect(
        runtime.run(judge, "Judge this.", { runId: "a", caller }),
      ).rejects.toThrow('run "a" is of agent "geo", not "judge"');
    } finally {
      await runtime.close();
    }
  });

  it("refuses two agents of one name", async () => {
    const { models, geo } = setup();
    await expect(
      openRuntime({ storage: new MemoryStorage(), models, agents: [geo, geo] }),
    ).rejects.toThrow('two agents are named "geo"');
  });
});

describe("a run's model", () => {
  function setup() {
    const faux = fauxProvider({ models: [{ id: "main" }, { id: "fallback" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const geo = defineAgent({
      name: "geo",
      model: `${faux.provider.id}:main`,
      instructions: "Answer.",
      tools: [],
    });
    return { faux, models, geo, fallback: `${faux.provider.id}:fallback` };
  }
  const modelsOf = (messages: Message[]) =>
    messages.flatMap((message) =>
      message.role === "assistant" ? [message.model] : [],
    );

  it("is the agent's, when the run is given none", async () => {
    const { faux, models, geo } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    let seen: Message[] = [];
    await once(geo, "Capital of France?", {
      caller,
      models,
      onMessages: (m) => (seen = m),
    });
    expect(modelsOf(seen)).toEqual(["main"]);
  });

  it("is the one the run is given, in place of the agent's", async () => {
    const { faux, models, geo, fallback } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    let seen: Message[] = [];
    await once(geo, "Capital of France?", {
      caller,
      models,
      model: fallback,
      onMessages: (m) => (seen = m),
    });
    expect(modelsOf(seen)).toEqual(["fallback"]);
  });

  it("is kept: the run started again with another model is the same run", async () => {
    const { faux, models, geo, fallback } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    try {
      await runtime.run(geo, "Capital of France?", {
        runId: "a",
        caller,
        model: fallback,
      });
      let seen: Message[] = [];
      await expect(
        runtime.run(geo, "Capital of France?", {
          runId: "a",
          caller,
          onMessages: (m) => (seen = m),
        }),
      ).resolves.toBe("Paris.");
      expect(modelsOf(seen)).toEqual(["fallback"]);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await runtime.close();
    }
  });

  it("refuses a model that is not provider:model-id", async () => {
    const { models, geo } = setup();
    await expect(
      once(geo, "Hi", { caller, models, model: "fallback" }),
    ).rejects.toThrow('the model must be "provider:model-id", not "fallback"');
  });
});
