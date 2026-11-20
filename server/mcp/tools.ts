/**
 * The MCP server a caller gets: one tool per agent they are given, after LangGraph's Agent Server. A call is one run, on
 * a conversation of its own, kept in the caller's history. Nobody attends it, as nobody can answer a question inside an
 * MCP call: a run that would ask stops before the step that asks acts, and says what is needed. Its outcome is the
 * tool's result, and a failure is a result the model reads (`isError`), never a protocol error.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { type CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Caller, Interrupt, Json } from "../../define/index.ts";
import {
  type ConnectionQuestion,
  ConnectionsMissing,
} from "../../loop/index.ts";
import { ServerError } from "../errors.ts";
import type { AnyAgent, RunOutcome } from "../server.ts";
import type { McpSurface } from "./routes.ts";

/** que-pasa's own name and version, as an MCP client shows the server it reached. */
const { name, version } = JSON.parse(
  readFileSync(findPackageJSON(import.meta.url)!, "utf8"),
) as { name: string; version: string };

/** A tool's input: every agent takes one text message. */
const Input = z.object({
  input: z
    .string()
    .min(1)
    .describe("The message to the agent: what to do, in words."),
});

/** The MCP server for one request: the caller's agents as tools. */
export function mcpServerOf({
  surface,
  request,
  caller,
  agents,
}: {
  surface: McpSurface;
  request: Request;
  caller: Caller;
  agents: readonly AnyAgent[];
}): McpServer {
  const server = new McpServer({ name, version });
  for (const agent of agents) {
    server.registerTool(
      agent.name,
      {
        ...(agent.description === undefined
          ? {}
          : { description: agent.description }),
        inputSchema: Input,
        ...(agent.output === undefined ? {} : { outputSchema: agent.output }),
      },
      async ({ input }, ctx): Promise<CallToolResult> => {
        // One id is the conversation's key and the run's: each call is one run, on a conversation of its own.
        const id = randomUUID();
        const token = ctx.mcpReq._meta?.progressToken;
        let seconds = 0;
        const onKeepAlive =
          token === undefined
            ? undefined
            : () => {
                seconds += 1;
                // A notice that fails has a client gone: the call's signal stops the run.
                ctx.mcpReq
                  .notify({
                    method: "notifications/progress",
                    params: {
                      progressToken: token,
                      progress: seconds,
                      message: `The agent is working: ${seconds} s.`,
                    },
                  })
                  .catch(() => {});
              };
        let outcome: RunOutcome;
        try {
          const started = await surface.start(
            request,
            agent.name,
            { conversation: id, runId: id, input },
            {
              // The client closes the call to cancel it, or goes away: either stops the run, as a person's stop does.
              signal: ctx.mcpReq.signal,
              ...(onKeepAlive === undefined ? {} : { onKeepAlive }),
            },
          );
          outcome = await started.outcome;
        } catch (error) {
          if (!(error instanceof ServerError)) throw error;
          return failed(await refusalText(error));
        }
        const result = resultOf(outcome, agent, request);
        if (outcome.status !== "done") return result;
        // The images its tools made, for the person, after the answer: MCP's image content.
        const images = await surface.images(id);
        return {
          ...result,
          content: [
            ...result.content,
            ...images.map(({ data, mediaType }) => ({
              type: "image" as const,
              data: Buffer.from(data).toString("base64"),
              mimeType: mediaType,
            })),
          ],
        };
      },
    );
  }
  return server;

  /** Why a run was refused, before anything of it was kept: for a missing login, where to connect it. */
  async function refusalText(error: ServerError): Promise<string> {
    if (!(error.cause instanceof ConnectionsMissing)) return error.message;
    const missing: string[] = [];
    for (const connection of error.cause.connections)
      missing.push(
        linked(
          connection.name,
          await surface.connectUrl(caller, connection),
          request,
        ),
      );
    return `No login for ${missing.join(", ")}. Connect it, then call again. Nothing ran.`;
  }
}

/** A run's outcome as the tool's result: its answer, or what stopped it. */
function resultOf(
  outcome: RunOutcome,
  agent: AnyAgent,
  request: Request,
): CallToolResult {
  switch (outcome.status) {
    case "done": {
      const { result } = outcome;
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        // An agent with an output gives it as the tool's structured result, and as its text.
        ...(agent.output === undefined
          ? {}
          : { structuredContent: result as Record<string, unknown> }),
      };
    }
    case "failed": {
      const { code, message } = outcome.error;
      const asked = (outcome.interrupts ?? []).map((interrupt) =>
        askedText(interrupt, request),
      );
      if (code === "needs_connection" && asked.length > 0)
        return failed(
          `The agent stopped before a step that needs a login: ${asked.join("; ")}. Connect it, then call again.`,
        );
      if (code === "needs_answer" && asked.length > 0)
        return failed(
          `The agent stopped to ask a person: ${asked.join("; ")}. Nobody can answer over MCP, so the step that asked did not run.`,
        );
      return failed(`The run failed (${code}): ${message}`);
    }
    case "interrupted":
      // A run nobody attends never waits on a question: it fails with it.
      throw new Error("an MCP run waits on a question, and nobody attends it");
  }
}

/** A question a run stopped on, in words: a login with where to connect it, else what the asker says. */
function askedText({ value }: Interrupt, request: Request): string {
  const connection = value as ConnectionQuestion & { connectUrl?: string };
  if (connection?.type === "connection")
    return linked(connection.name, connection.connectUrl, request);
  const description = (value as { description?: Json } | null)?.description;
  return typeof description === "string" ? description : JSON.stringify(value);
}

/**
 * A connection's name, with where to connect it, as a full link a person opens from any client: a link the deployment
 * gives relative to the server is resolved against the request, as a browser resolves it.
 */
function linked(name: string, url: string | undefined, request: Request) {
  if (url === undefined) return name;
  return `${name} (connect it at ${new URL(url, request.url).href})`;
}

/** A failure the model reads, and tells the person. */
function failed(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
