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
import {
  defineAgent,
  defineMiddleware,
  defineResource,
  defineTool,
  type Runtime,
} from "../define/index.ts";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import type { Json, Agent } from "../define/index.ts";
import {
  openRuntime,
  provide,
  type RunOptions,
  type RunUsage,
} from "./index.ts";
import { reminder } from "./extension.ts";
import { scripted } from "./scripted.fixture.ts";

const caller = { id: "matt" };

/** One run on a fresh runtime in memory, closed after: what most tests need. */
async function once<
  O extends z.ZodObject | undefined,
  C extends Json | undefined,
>(
  agent: Agent<O, C>,
  input: string,
  {
    models,
    ...options
  }: Omit<RunOptions<C>, "conversation" | "runId"> & { models: Models },
) {
  const runtime = await openRuntime({
    storage: new MemoryStorage(),
    models,
    agents: [agent],
  });
  try {
    return await runtime.run(agent, input, {
      conversation: "chat-1",
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
        runtime.run(geo, "Capital of France?", {
          conversation: "a",
          runId: "a",
          caller,
        }),
      ).resolves.toBe("Paris.");
      await expect(
        runtime.run(geo, "Capital of France?", {
          conversation: "a",
          runId: "a",
          caller,
        }),
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
        runtime.run(geo, "Capital of France?", {
          conversation: "a",
          runId: "a",
          caller,
        }),
      ).resolves.toBe("Paris.");
      await expect(
        runtime.run(judge, "Judge this.", {
          conversation: "b",
          runId: "b",
          caller,
        }),
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
        conversation: "a",
        runId: "a",
        caller,
        onUsage,
      });
      await runtime.run(geo, "Capital of Italy?", {
        conversation: "b",
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
        runtime.run(judge, "Judge this.", {
          conversation: "a",
          runId: "a",
          caller,
        }),
      ).rejects.toThrow('agent "judge" was not given when the runtime opened');
    } finally {
      await runtime.close();
    }
  });

  it("refuses a run on a conversation that is another agent's", async () => {
    const { faux, models, geo, judge } = setup();
    faux.setResponses([fauxAssistantMessage([fauxText("Paris.")])]);
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo, judge],
    });
    try {
      await runtime.run(geo, "Capital of France?", {
        conversation: "a",
        runId: "a",
        caller,
      });
      await expect(
        runtime.run(judge, "Judge this.", {
          conversation: "a",
          runId: "a",
          caller,
        }),
      ).rejects.toThrow('conversation "a" is of agent "geo", not "judge"');
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
        conversation: "a",
        runId: "a",
        caller,
        model: fallback,
      });
      let seen: Message[] = [];
      await expect(
        runtime.run(geo, "Capital of France?", {
          conversation: "a",
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

describe("a run's resources", () => {
  const box = defineResource<{ root: string }>("box");
  const where = defineTool({
    name: "where",
    description: "Say where the box is.",
    schema: z.object({}),
    uses: [box],
    run: async (_input, runtime: Runtime<{ root: string }>) =>
      (await runtime.use(box)).root,
  });
  const twice = () => [
    fauxAssistantMessage([fauxToolCall("where", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxToolCall("where", {})], {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage([fauxText("Done.")]),
  ];

  it("are resolved by the host from the conversation, once per run, and given to its tools", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses(twice());
    const agent = defineAgent({
      name: "boxed",
      model,
      instructions: "Say where.",
      tools: [where],
    });
    const seen: string[] = [];
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
      resources: [
        provide(box, ({ conversation, caller, context }) => {
          seen.push(`${conversation} ${caller.id} ${JSON.stringify(context)}`);
          return { root: (context as { root: string }).root };
        }),
      ],
    });
    let messages: Message[] = [];
    try {
      await runtime.run(agent, "Where?", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
        context: { root: "/work" },
        onMessages: (all) => (messages = all),
      });
    } finally {
      await runtime.close();
    }
    expect(seen).toEqual(['chat-1 matt {"root":"/work"}']);
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => JSON.stringify(m.content))).toEqual([
      expect.stringContaining("/work"),
      expect.stringContaining("/work"),
    ]);
  });

  it("are refused at open when a tool uses one the host does not provide", async () => {
    const { models, model } = scripted();
    const agent = defineAgent({
      name: "boxed",
      model,
      instructions: "Say where.",
      tools: [where],
    });
    await expect(
      openRuntime({ storage: new MemoryStorage(), models, agents: [agent] }),
    ).rejects.toThrow(
      'tool "where" uses resource "box", which is not provided',
    );
  });

  it("are refused to a tool that does not declare it", async () => {
    const { faux, models, model } = scripted();
    const sneaky = defineTool({
      name: "where",
      description: "Say where the box is.",
      schema: z.object({}),
      run: async (_input, runtime) => (await runtime.use(box)).root,
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("where", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const agent = defineAgent({
      name: "boxed",
      model,
      instructions: "Say where.",
      tools: [sneaky],
    });
    let messages: Message[] = [];
    await once(agent, "Where?", {
      caller,
      models,
      onMessages: (all) => (messages = all),
    });
    const result = messages.find((m) => m.role === "toolResult");
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain(
      "which it does not declare in uses",
    );
  });

  it("are refused when one is provided twice", async () => {
    const { models } = scripted();
    await expect(
      openRuntime({
        storage: new MemoryStorage(),
        models,
        agents: [],
        resources: [
          provide(box, () => ({ root: "a" })),
          provide(box, () => ({ root: "b" })),
        ],
      }),
    ).rejects.toThrow('resource "box" is provided twice');
  });

  it("are resolved again after a resolve that failed", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses(twice());
    const agent = defineAgent({
      name: "boxed",
      model,
      instructions: "Say where.",
      tools: [where],
    });
    let calls = 0;
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
      resources: [
        provide(box, () => {
          calls += 1;
          if (calls === 1) throw new Error("not up yet");
          return { root: "/work" };
        }),
      ],
    });
    let messages: Message[] = [];
    try {
      await runtime.run(agent, "Where?", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
        context: { root: "/work" },
        onMessages: (all) => (messages = all),
      });
    } finally {
      await runtime.close();
    }
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results.map((m) => m.isError)).toEqual([true, false]);
    expect(calls).toBe(2);
  });
});

describe("a run's middleware", () => {
  /** A scripted model that answers each call, and keeps the system prompt it was given. */
  function seeing() {
    const { faux, models, model } = scripted();
    const prompts: string[] = [];
    // The system prompt, as the model gets it: each system message's sections, in the order pi renders them.
    const answer = (text: string) => (context: { messages: Message[] }) => {
      prompts.push(
        context.messages
          .flatMap((m) =>
            m.role === "system"
              ? Object.values(
                  (m as { sections?: Record<string, string> }).sections ?? {},
                )
              : [],
          )
          .join("\n"),
      );
      return fauxAssistantMessage([fauxText(text)]);
    };
    return { faux, models, model, prompts, answer };
  }

  it("adds its section to the system prompt the model gets, from the state its run kept, before the instructions", async () => {
    const { faux, models, model, prompts, answer } = seeing();
    faux.setResponses([answer("Done.")]);
    const notes = defineMiddleware<{ note: string }>({
      name: "notes",
      beforeAgent: ({ caller }) => ({ note: `notes for ${caller.id}` }),
      systemPrompt: (state) => state?.note,
    });
    const agent = defineAgent({
      name: "noted",
      model,
      instructions: "Answer from your notes.",
      tools: [],
      middleware: [notes],
    });
    await once(agent, "Go.", { caller, models });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt).toContain("notes for matt");
    expect(prompt.indexOf("notes for matt")).toBeLessThan(
      prompt.indexOf("Answer from your notes."),
    );
  });

  it("runs beforeAgent once per conversation: a run started again, and a later run, keep what it gave", async () => {
    const { faux, models, model, prompts, answer } = seeing();
    faux.setResponses([answer("One."), answer("Two.")]);
    let calls = 0;
    const counted = defineMiddleware<{ call: number }>({
      name: "counted",
      beforeAgent: () => ({ call: (calls += 1) }),
      systemPrompt: (state) => `call ${state?.call}`,
    });
    const agent = defineAgent({
      name: "counting",
      model,
      instructions: "Answer.",
      tools: [],
      middleware: [counted],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
    });
    try {
      const go = (runId: string) =>
        runtime.run(agent, "Go.", { conversation: "chat-1", runId, caller });
      await go("run-1");
      await go("run-1");
      await go("run-2");
    } finally {
      await runtime.close();
    }
    expect(calls).toBe(1);
    expect(prompts).toEqual([
      expect.stringContaining("call 1"),
      expect.stringContaining("call 1"),
    ]);
  });

  it("fails a run whose beforeAgent throws, keeping nothing: the run started again starts fresh", async () => {
    const { faux, models, model, prompts, answer } = seeing();
    faux.setResponses([answer("Done.")]);
    let fail = true;
    const flaky = defineMiddleware<string>({
      name: "flaky",
      beforeAgent: () => {
        if (fail) throw new Error("the source is not there yet");
        return "loaded";
      },
      systemPrompt: (state) => state ?? undefined,
    });
    const agent = defineAgent({
      name: "flaky-agent",
      model,
      instructions: "Answer.",
      tools: [],
      middleware: [flaky],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
    });
    try {
      await expect(
        runtime.run(agent, "Go.", {
          conversation: "run-1",
          runId: "run-1",
          caller,
        }),
      ).rejects.toThrow("the source is not there yet");
      fail = false;
      await expect(
        runtime.run(agent, "Go.", {
          conversation: "run-1",
          runId: "run-1",
          caller,
        }),
      ).resolves.toBe("Done.");
    } finally {
      await runtime.close();
    }
    expect(prompts).toEqual([expect.stringContaining("loaded")]);
  });
});

describe("a conversation", () => {
  /** The user texts of a request, oldest first. */
  const asked = (messages: readonly Message[]) =>
    messages.flatMap((m) =>
      m.role === "user" && typeof m.content === "string" ? [m.content] : [],
    );

  it("keeps its history across runs: a later run's model gets the earlier runs' messages, and each run gives its own answer", async () => {
    const { faux, models, model } = scripted();
    const requests: string[][] = [];
    const answer = (text: string) => (context: { messages: Message[] }) => {
      requests.push(asked(context.messages));
      return fauxAssistantMessage([fauxText(text)]);
    };
    faux.setResponses([answer("Paris."), answer("Rome.")]);
    const geo = defineAgent({
      name: "geo",
      model,
      instructions: "Answer briefly.",
      tools: [],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    try {
      const ask = (runId: string, input: string) =>
        runtime.run(geo, input, { conversation: "chat-1", runId, caller });
      await expect(ask("run-1", "Capital of France?")).resolves.toBe("Paris.");
      await expect(ask("run-2", "And of Italy?")).resolves.toBe("Rome.");
      // A run started again gives back its own answer, not the conversation's last.
      await expect(ask("run-1", "Capital of France?")).resolves.toBe("Paris.");
    } finally {
      await runtime.close();
    }
    expect(requests).toEqual([
      ["Capital of France?"],
      ["Capital of France?", "And of Italy?"],
    ]);
    expect(faux.state.callCount).toBe(2);
  });

  it("gives each run its own submit, and reminds a run that has not submitted, though an earlier run did", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "raise", note: "first" })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("Fixed now.")]),
      fauxAssistantMessage(
        [fauxToolCall("submit", { verdict: "done", note: "second" })],
        { stopReason: "toolUse" },
      ),
    ]);
    const judge = defineAgent({
      name: "judge",
      model,
      instructions: "Judge.",
      tools: [],
      output: verdict,
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [judge],
    });
    let messages: Message[] = [];
    try {
      const go = (runId: string) =>
        runtime.run(judge, "Judge this.", {
          conversation: "chat-1",
          runId,
          caller,
          onMessages: (all) => (messages = all),
        });
      await expect(go("run-1")).resolves.toEqual({
        verdict: "raise",
        note: "first",
      });
      await expect(go("run-2")).resolves.toEqual({
        verdict: "done",
        note: "second",
      });
    } finally {
      await runtime.close();
    }
    expect(asked(messages)).toEqual(["Judge this.", "Judge this.", reminder]);
  });

  it("refuses a run while another goes on, naming it, and the one going on still gives its result", async () => {
    const { faux, models, model } = scripted();
    let release = () => {};
    let started = () => {};
    const going = new Promise<void>((resolve) => (started = resolve));
    const wait = defineTool({
      name: "wait",
      description: "Wait.",
      schema: z.object({}),
      run: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("waited");
          started();
        }),
    });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("wait", {})], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage([fauxText("Done.")]),
    ]);
    const agent = defineAgent({
      name: "waiter",
      model,
      instructions: "Wait.",
      tools: [wait],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
    });
    try {
      const first = runtime.run(agent, "Wait.", {
        conversation: "chat-1",
        runId: "run-1",
        caller,
      });
      await going;
      await expect(
        runtime.run(agent, "Again.", {
          conversation: "chat-1",
          runId: "run-2",
          caller,
        }),
      ).rejects.toThrow(
        'conversation "chat-1": run "run-1" goes on, so run "run-2" is refused',
      );
      release();
      await expect(first).resolves.toBe("Done.");
    } finally {
      await runtime.close();
    }
  });

  it("refuses a run that gives it another caller or context than its first run made it with", async () => {
    const { faux, models, model } = scripted();
    const where = defineTool({
      name: "where",
      description: "Say where.",
      schema: z.object({}),
      run: (_input, runtime: Runtime<{ root: string }>) => runtime.context.root,
    });
    faux.setResponses([fauxAssistantMessage([fauxText("Here.")])]);
    const agent = defineAgent({
      name: "where",
      model,
      instructions: "Say where.",
      tools: [where],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [agent],
    });
    try {
      const go = (runId: string, who: string, root: string) =>
        runtime.run(agent, "Where?", {
          conversation: "chat-1",
          runId,
          caller: { id: who },
          context: { root },
        });
      await go("run-1", "matt", "/work");
      await expect(go("run-2", "sam", "/work")).rejects.toThrow(
        'conversation "chat-1" acts for "matt", not "sam"',
      );
      await expect(go("run-2", "matt", "/other")).rejects.toThrow(
        'conversation "chat-1" was made with another context',
      );
    } finally {
      await runtime.close();
    }
  });

  it("runs each run on its own model, and a run started again keeps its own", async () => {
    const faux = fauxProvider({ models: [{ id: "main" }, { id: "fallback" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxText("Paris.")]),
      fauxAssistantMessage([fauxText("Rome.")]),
    ]);
    const geo = defineAgent({
      name: "geo",
      model: `${faux.provider.id}:main`,
      instructions: "Answer.",
      tools: [],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    let messages: Message[] = [];
    try {
      const go = (runId: string, model?: string) =>
        runtime.run(geo, "Capital?", {
          conversation: "chat-1",
          runId,
          caller,
          ...(model ? { model } : {}),
          onMessages: (all) => (messages = all),
        });
      await go("run-1");
      await go("run-2", `${faux.provider.id}:fallback`);
      await expect(go("run-2")).resolves.toBe("Rome.");
    } finally {
      await runtime.close();
    }
    expect(
      messages.flatMap((m) => (m.role === "assistant" ? [m.model] : [])),
    ).toEqual(["main", "fallback"]);
  });

  it("reports each run's own usage, and the runs' usage sums to what the conversation spent", async () => {
    const { faux, models, model } = scripted();
    faux.setResponses([
      fauxAssistantMessage([
        fauxText("Paris, the capital and largest city of France."),
      ]),
      fauxAssistantMessage([fauxText("Rome.")]),
    ]);
    const geo = defineAgent({
      name: "geo",
      model,
      instructions: "Answer briefly.",
      tools: [],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [geo],
    });
    const spent: number[] = [];
    let messages: Message[] = [];
    try {
      for (const [runId, input] of [
        ["run-1", "Capital of France?"],
        ["run-2", "And of Italy?"],
      ] as const) {
        await runtime.run(geo, input, {
          conversation: "chat-1",
          runId,
          caller,
          onUsage: (usage) =>
            spent.push(
              Object.values(usage.models).reduce((n, u) => n + u.output, 0),
            ),
          onMessages: (all) => (messages = all),
        });
      }
    } finally {
      await runtime.close();
    }
    const answered = messages.flatMap((m) =>
      m.role === "assistant" ? [m.usage.output] : [],
    );
    expect(spent).toEqual(answered);
    expect(spent[1]).toBeLessThan(spent[0] ?? 0);
    expect(spent[1]).toBeGreaterThan(0);
  });
});
