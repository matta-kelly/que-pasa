import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineAgent,
  defineMiddleware,
  defineResource,
  defineTool,
} from "./index.ts";

const caller = { id: "matt" };
const odoo = defineResource<{ login: string }>("odoo");
const runtime = {
  caller,
  context: undefined,
  use: () => Promise.reject(new Error("no resources here")),
};

const products = defineTool({
  name: "read_products",
  description: "Read products by SKU.",
  schema: z.object({ sku: z.string() }),
  uses: [odoo],
  run: ({ sku }, runtime) => `${sku} for ${runtime.caller.id}`,
});

describe("defineTool", () => {
  it("gives back the tool, and its run takes the input and the runtime", () => {
    expect(products.name).toBe("read_products");
    expect(products.uses).toEqual([odoo]);
    expect(products.run({ sku: "A1" }, runtime)).toBe("A1 for matt");
  });

  it.each(["readProducts", "read-products", "1read", "", "a".repeat(65)])(
    "refuses the name %j",
    (name) => {
      expect(() => defineTool({ ...products, name })).toThrow("snake_case");
    },
  );

  it("refuses an empty description", () => {
    expect(() => defineTool({ ...products, description: " " })).toThrow(
      "description is empty",
    );
  });

  it("refuses a resource in uses twice", () => {
    expect(() => defineTool({ ...products, uses: [odoo, odoo] })).toThrow(
      "in uses twice",
    );
  });

  it("takes a tool that uses no resource", () => {
    const tool = defineTool({
      name: "now",
      description: "The time now.",
      schema: z.object({}),
      run: () => Date.now(),
    });
    expect(tool.uses).toBeUndefined();
  });
});

describe("defineResource", () => {
  it("gives back a resource with its name", () => {
    expect(odoo.name).toBe("odoo");
  });

  it.each(["Odoo", "odoo_login", "1odoo", ""])(
    "refuses the name %j",
    (name) => {
      expect(() => defineResource(name)).toThrow("kebab-case");
    },
  );
});

const salesRep = {
  name: "sales-rep",
  model: "anthropic:claude-sonnet-5-5",
  instructions: "You help wholesale reps with orders.",
  tools: [products],
};

describe("defineAgent", () => {
  it("gives back the agent, with no output when none is given", () => {
    const agent = defineAgent(salesRep);
    expect(agent.name).toBe("sales-rep");
    expect(agent.tools.map((t) => t.name)).toEqual(["read_products"]);
    expect(agent.output).toBeUndefined();
  });

  it("keeps the output schema", () => {
    const output = z.object({ verdict: z.enum(["done", "raise"]) });
    expect(defineAgent({ ...salesRep, output }).output).toBe(output);
  });

  it.each(["SalesRep", "sales_rep", "sales--rep", "-sales", ""])(
    "refuses the name %j",
    (name) => {
      expect(() => defineAgent({ ...salesRep, name })).toThrow("kebab-case");
    },
  );

  it.each(["claude-sonnet-5-5", "anthropic:", ":claude", "anthropic: claude"])(
    "refuses the model %j",
    (model) => {
      expect(() => defineAgent({ ...salesRep, model })).toThrow(
        "provider:model-id",
      );
    },
  );

  it("refuses empty instructions", () => {
    expect(() => defineAgent({ ...salesRep, instructions: "\n" })).toThrow(
      "instructions are empty",
    );
  });

  it("refuses two tools of one name", () => {
    expect(() =>
      defineAgent({ ...salesRep, tools: [products, products] }),
    ).toThrow('two tools are named "read_products"');
  });

  it("is fixed once defined: its tool list cannot be changed", () => {
    const agent = defineAgent(salesRep);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.tools)).toBe(true);
  });

  it("keeps its middleware in order, fixed once defined", () => {
    const first = defineMiddleware({ name: "first" });
    const second = defineMiddleware({ name: "second" });
    const agent = defineAgent({ ...salesRep, middleware: [first, second] });
    expect(agent.middleware).toEqual([first, second]);
    expect(Object.isFrozen(agent.middleware)).toBe(true);
  });

  it("refuses two middleware of one name", () => {
    const memory = defineMiddleware({ name: "memory" });
    expect(() =>
      defineAgent({ ...salesRep, middleware: [memory, memory] }),
    ).toThrow('two middleware are named "memory"');
  });
});

describe("defineMiddleware", () => {
  it("gives back the middleware, fixed, with its hooks", () => {
    const middleware = defineMiddleware<{ n: number }>({
      name: "count",
      beforeAgent: () => ({ n: 1 }),
      systemPrompt: (state) => `n is ${state?.n ?? 0}`,
    });
    expect(Object.isFrozen(middleware)).toBe(true);
    expect(middleware.systemPrompt!({ n: 2 })).toBe("n is 2");
    expect(middleware.systemPrompt!(null)).toBe("n is 0");
  });

  it.each(["Memory", "the_memory", "1memory", ""])(
    "refuses the name %j",
    (name) => {
      expect(() => defineMiddleware({ name })).toThrow("kebab-case");
    },
  );
});
