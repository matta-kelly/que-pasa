import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAgent, defineTool } from "./index.ts";

const caller = { id: "matt" };

const products = defineTool({
  name: "read_products",
  description: "Read products by SKU.",
  schema: z.object({ sku: z.string() }),
  connection: "odoo",
  run: ({ sku }, runtime) => `${sku} for ${runtime.context.caller.id}`,
});

describe("defineTool", () => {
  it("gives back the tool, and its run takes the input and the runtime", () => {
    expect(products.name).toBe("read_products");
    expect(products.connection).toBe("odoo");
    expect(products.run({ sku: "A1" }, { context: { caller } })).toBe(
      "A1 for matt",
    );
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

  it("refuses an empty connection name", () => {
    expect(() => defineTool({ ...products, connection: "" })).toThrow(
      "connection name is empty",
    );
  });

  it("takes a tool with no connection", () => {
    const tool = defineTool({
      name: "now",
      description: "The time now.",
      schema: z.object({}),
      run: () => Date.now(),
    });
    expect(tool.connection).toBeUndefined();
  });
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
});
