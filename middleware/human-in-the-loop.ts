/**
 * Approvals: a person decides on a tool call before it runs, after LangChain's `HumanInTheLoopMiddleware` in its
 * per-call mode. A call of a gated tool asks with one interrupt, and goes on with the decision: approve runs it, edit
 * runs it with other arguments, reject gives the model the refusal, and respond gives the model the person's message
 * as the result, LangChain's words for each. Who decides, and how the question reaches them, is the deployment's.
 */
import { z } from "zod";
import {
  defineMiddleware,
  type Json,
  type Middleware,
} from "../define/index.ts";

/** What a person may decide on a call, LangChain's. */
export type Decision = "approve" | "edit" | "reject" | "respond";

/** How a tool is gated: true for every decision, or the decisions allowed and the words shown to the person. */
export type InterruptOn =
  true | { allowedDecisions?: readonly Decision[]; description?: string };

/** The question a gated call asks, LangChain's `ToolApprovalRequest`. */
export type ApprovalQuestion = {
  type: "tool_approval";
  name: string;
  args: { [key: string]: Json };
  description: string;
  allowedDecisions: Decision[];
};

const decisions: readonly Decision[] = ["approve", "edit", "reject", "respond"];

const Answer = z.discriminatedUnion("type", [
  z.object({ type: z.literal("approve") }),
  z.object({
    type: z.literal("edit"),
    editedAction: z.object({
      name: z.string(),
      args: z.record(z.string(), z.json()),
    }),
  }),
  z.object({ type: z.literal("reject"), message: z.string().optional() }),
  z.object({ type: z.literal("respond"), message: z.string() }),
]);

/**
 * Ask a person before each call of the tools in `interruptOn`, by name. The other tools run as they are.
 * - `interruptOn`: a tool's name, to `true` for every decision, or to the decisions allowed and a description
 */
export function humanInTheLoop({
  interruptOn,
}: {
  interruptOn: Readonly<Record<string, InterruptOn>>;
}): Middleware {
  for (const [tool, on] of Object.entries(interruptOn)) {
    const allowed =
      on === true ? decisions : (on.allowedDecisions ?? decisions);
    if (allowed.length === 0) {
      throw new Error(`human-in-the-loop: tool "${tool}" allows no decision`);
    }
  }
  return defineMiddleware({
    name: "human-in-the-loop",
    async wrapToolCall(request, handler) {
      const on = interruptOn[request.name];
      if (on === undefined) return handler();
      const allowedDecisions = [
        ...(on === true ? decisions : (on.allowedDecisions ?? decisions)),
      ];
      const question: ApprovalQuestion = {
        type: "tool_approval",
        name: request.name,
        args: request.args,
        description:
          (on === true ? undefined : on.description) ??
          `Tool execution requires approval\n\nTool: ${request.name}\nArgs: ${JSON.stringify(request.args)}`,
        allowedDecisions,
      };
      const allowed = Answer.refine(
        (answer) => allowedDecisions.includes(answer.type),
        {
          message: `the decision must be one of ${allowedDecisions.join(", ")}`,
        },
      ).refine(
        (answer) =>
          answer.type !== "edit" || answer.editedAction.name === request.name,
        { message: `an edit keeps the tool, "${request.name}"` },
      );
      const answer = await request.interrupt(question, allowed);
      switch (answer.type) {
        case "approve":
          return handler();
        case "edit":
          return handler(answer.editedAction.args);
        case "reject":
          return {
            status: "error",
            content: answer.message
              ? `User rejected the tool call for \`${request.name}\` with reason: ${answer.message}`
              : `User rejected the tool call for \`${request.name}\` with id ${request.id}. The tool was not executed. Do not retry this tool call unless the user explicitly requests it.`,
          };
        case "respond":
          return { status: "success", content: answer.message };
      }
    },
  });
}
