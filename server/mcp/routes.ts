/**
 * The MCP surface: the Model Context Protocol on que-pasa's server, so an MCP client (Claude Code, an IDE, another
 * agent) reaches a deployment's agents as tools. Served with the MCP SDK's own handler, stateless, as the protocol's
 * 2026-07-28 revision is, and to a 2025-era client too: each request stands alone, and asks the server's own questions
 * first, so this surface refuses as the others do.
 */
import {
  createMcpHandler,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { Hono } from "hono";
import type { Caller, Connection } from "../../define/index.ts";
import type { AnyAgent, RunControl, RunOutcome } from "../server.ts";
import { mcpServerOf } from "./tools.ts";
import type { StoredFile } from "../../files/index.ts";

/** What the MCP surface needs of the server: its checks, and its runs, so every surface refuses and runs alike. */
export type McpSurface = {
  /** Who is calling; `ServerError` 401 when the deployment does not know. */
  callerOf: (request: Request) => Promise<Caller>;
  /** The agents the caller is given. */
  agentsFor: (caller: Caller) => Promise<readonly AnyAgent[]>;
  /**
   * Admit a run nobody attends, as the server admits one: every refusal throws `ServerError` before it is admitted, and
   * what is left is how it ends.
   */
  start: (
    request: Request,
    agent: string,
    run: { conversation: string; runId: string; input: string },
    control: RunControl,
  ) => Promise<{ outcome: Promise<RunOutcome> }>;
  /** The images the tools of a conversation made, in the order they were made. */
  images: (conversation: string) => Promise<StoredFile[]>;
  /** Where the caller connects a connection: the deployment's page, as it gives it. */
  connectUrl: (
    caller: Caller,
    connection: Connection,
  ) => Promise<string | undefined>;
  onError: (error: unknown) => void;
};

/** The MCP surface's route, to mount at the server's `/mcp`. */
export function mcpRoutes(surface: McpSurface): Hono {
  const mcp = new Hono();
  mcp.all("/", async (c) => {
    const request = c.req.raw;
    // A page in a browser on another site may not call it: the protocol's guard against DNS rebinding. A client that is
    // not a browser sends no Origin.
    const refused = originValidationResponse(request, [
      new URL(request.url).hostname,
    ]);
    if (refused) return refused;
    const caller = await surface.callerOf(request);
    const agents = await surface.agentsFor(caller);
    // A handler per request, as the protocol keeps nothing between requests: its tools are the caller's agents now.
    const handler = createMcpHandler(
      () => mcpServerOf({ surface, request, caller, agents }),
      {
        // Progress reaches the client while a run goes on, so a client that times out a quiet call keeps waiting.
        responseMode: "sse",
        onerror: surface.onError,
      },
    );
    return handler.fetch(request);
  });
  return mcp;
}
