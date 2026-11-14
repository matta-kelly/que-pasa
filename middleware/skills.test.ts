import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineAgent, type Middleware } from "../define/index.ts";
import { openRuntime, provide } from "../loop/index.ts";
import { resultOf, scripted } from "../loop/scripted.fixture.ts";
import {
  type FileBackend,
  local,
  read_file,
  Sandbox,
} from "../sandbox/index.ts";
import { skills, skillsPrompt } from "./index.ts";

const made = { conversation: "chat-1", caller: { id: "matt" } };

let host = "";
let backend: FileBackend;

/** A skill's folder, with its SKILL.md. */
function skill(source: string, folder: string, head: string, body = "Steps.") {
  mkdirSync(join(host, source, folder), { recursive: true });
  writeFileSync(
    join(host, source, folder, "SKILL.md"),
    `---\n${head}\n---\n\n${body}\n`,
  );
}

beforeEach(() => {
  host = mkdtempSync(join(tmpdir(), "que-pasa-skills-"));
  skill(
    "skills",
    "quote",
    "name: quote\ndescription: Build and send a quote.\nallowed-tools: read_partners, send_quote",
    "1. Find the partner.\n2. Send it.",
  );
  skill(
    "skills",
    "returns",
    "name: returns\ndescription: The returns policy.\nlicense: MIT",
  );
  writeFileSync(join(host, "secret.md"), "not a skill");
  backend = local({ root: host });
});
afterEach(() => rmSync(host, { recursive: true, force: true }));

/** What skills adds to the system prompt, as the loop does it: load once, keep as JSON, render from what was kept. */
async function promptOf(middleware: Middleware) {
  const kept = await middleware.beforeAgent!(made);
  return middleware.systemPrompt!(JSON.parse(JSON.stringify(kept)));
}

describe("skills", () => {
  it("lists each skill with its description, its allowed tools and its path, in Deep Agents' prompt", async () => {
    const prompt = await promptOf(skills({ backend, sources: ["skills"] }));
    expect(prompt).toBe(
      skillsPrompt
        .replace(
          "{skills_locations}",
          "**Skills Skills**: `skills` (higher priority)",
        )
        .replace("{skills_load_warnings}", "")
        .replace(
          "{skills_list}",
          [
            "- **quote**: Build and send a quote.",
            "  -> Allowed tools: read_partners, send_quote",
            "  -> Read `skills/quote/SKILL.md` for full instructions",
            "- **returns**: The returns policy. (License: MIT)",
            "  -> Read `skills/returns/SKILL.md` for full instructions",
          ].join("\n"),
        ),
    );
  });

  it("lets a later source's skill win over an earlier one of its name, and labels a source by its parent", async () => {
    skill("team/skills", "quote", "name: quote\ndescription: The team's way.");
    const prompt = await promptOf(
      skills({ backend, sources: ["skills", "team/skills"] }),
    );
    expect(prompt).toContain(
      "**Skills Skills**: `skills`\n**Team Skills**: `team/skills` (higher priority)",
    );
    expect(prompt).toContain("- **quote**: The team's way.");
    expect(prompt).not.toContain("Build and send a quote.");
    expect(prompt).toContain("- **returns**");
  });

  it("leaves out a skill with no description or bad YAML, and a folder with no SKILL.md, and shows a source it cannot read", async () => {
    skill("skills", "nameless", "description: no name");
    skill("skills", "broken", "name: [unclosed");
    mkdirSync(join(host, "skills/empty"));
    const prompt = await promptOf(
      skills({ backend, sources: ["skills", "nope"] }),
    );
    expect(prompt).not.toMatch(/nameless|broken|empty/);
    expect(prompt).toContain("<skill_load_warnings>");
    expect(prompt).toContain(
      "- &quot;Cannot load skills from &#x27;nope&#x27;: file_not_found&quot;",
    );
  });

  it("says there is none when no source holds a skill, or the conversation kept none", async () => {
    const none = skills({ backend, sources: ["nope"] });
    expect(await promptOf(none)).toContain(
      "(No skills available yet. You can create skills in nope)",
    );
    expect(none.systemPrompt!(null)).toContain("(No skills available yet.");
  });

  it("refuses a prompt without its slots, and no source", () => {
    expect(() =>
      skills({ backend, sources: ["skills"], systemPrompt: "Skills." }),
    ).toThrow(/must hold \{skills_locations\}/);
    expect(() => skills({ backend, sources: [] })).toThrow(/no source/);
  });
});

describe("skills in a run", () => {
  const { faux, models, model } = scripted();
  /** The system prompt of each model request, and the tools it offered. */
  let prompts: string[] = [];
  let offered: string[][] = [];
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
      offered.push(
        request.messages.flatMap((m) =>
          m.role === "system"
            ? ((m as { toolsAdded?: { name: string }[] }).toolsAdded ?? []).map(
                (tool) => tool.name,
              )
            : [],
        ),
      );
      return reply;
    };
  const results = (messages: Message[]) =>
    messages.flatMap((m) =>
      m.role === "toolResult"
        ? [
            m.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join(""),
          ]
        : [],
    );

  beforeEach(() => {
    prompts = [];
    offered = [];
  });

  it("gives an agent with no file tools read_file over its skills, and nothing outside them", async () => {
    const seller = defineAgent({
      name: "seller",
      model,
      instructions: "Sell.",
      tools: [],
      middleware: [skills({ backend, sources: ["skills"] })],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [seller],
    });
    let messages: Message[] = [];
    faux.setResponses([
      seeing(
        fauxAssistantMessage(
          [
            fauxToolCall("read_file", {
              file_path: "skills/quote/SKILL.md",
              limit: 1000,
            }),
            fauxToolCall("read_file", { file_path: "secret.md" }),
          ],
          { stopReason: "toolUse" },
        ),
      ),
      seeing(fauxAssistantMessage([fauxText("Sent.")])),
    ]);
    try {
      await runtime
        .run(seller, "Quote acme.", {
          conversation: "c",
          runId: "1",
          caller: { id: "matt" },
          onMessages: (all) => (messages = all),
        })
        .then(resultOf);
    } finally {
      await runtime.close();
    }
    expect(offered[0]).toEqual(["ls", "read_file"]);
    expect(prompts[0]).toContain("Read `skills/quote/SKILL.md`");
    // The two calls run together, so their results come in either order.
    expect(results(messages).sort()).toEqual([
      expect.stringContaining("1. Find the partner."),
      "Error: File 'secret.md' not found",
    ]);
  });

  it("loads once per conversation: a skill added later is seen by a new conversation, not by the next run", async () => {
    const seller = defineAgent({
      name: "seller",
      model,
      instructions: "Sell.",
      tools: [],
      middleware: [skills({ backend, sources: ["skills"] })],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [seller],
    });
    const run = (conversation: string, runId: string) => {
      faux.setResponses([seeing(fauxAssistantMessage([fauxText("Ok.")]))]);
      return runtime
        .run(seller, "Hi.", {
          conversation,
          runId,
          caller: { id: "matt" },
        })
        .then(resultOf);
    };
    try {
      await run("a", "1");
      skill("skills", "invoices", "name: invoices\ndescription: Invoicing.");
      await run("a", "2");
      await run("b", "1");
    } finally {
      await runtime.close();
    }
    expect(prompts.map((p) => p.includes("invoices"))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("leaves an agent with its own read_file reading its skills with it", async () => {
    const coder = defineAgent({
      name: "coder",
      model,
      instructions: "Code.",
      tools: [read_file],
      middleware: [skills({ backend, sources: ["skills"] })],
    });
    const runtime = await openRuntime({
      storage: new MemoryStorage(),
      models,
      agents: [coder],
      resources: [provide(Sandbox, () => backend)],
    });
    let messages: Message[] = [];
    faux.setResponses([
      seeing(
        fauxAssistantMessage(
          [fauxToolCall("read_file", { file_path: "secret.md" })],
          { stopReason: "toolUse" },
        ),
      ),
      seeing(fauxAssistantMessage([fauxText("Ok.")])),
    ]);
    try {
      await runtime
        .run(coder, "Read.", {
          conversation: "c",
          runId: "1",
          caller: { id: "matt" },
          onMessages: (all) => (messages = all),
        })
        .then(resultOf);
    } finally {
      await runtime.close();
    }
    expect(offered[0]).toEqual(["read_file", "ls"]);
    // The sandbox's read_file, which reads the whole sandbox.
    expect(results(messages)).toEqual([expect.stringContaining("not a skill")]);
  });
});
