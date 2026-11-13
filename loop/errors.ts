import type { Connection, Interrupt } from "../define/index.ts";

/** Why a run was refused before it was admitted: nothing of it was kept. */
export type RefusedReason =
  /** Its conversation is of another agent. */
  | "other_agent"
  /** Its conversation acts for another caller. */
  | "other_caller"
  /** Its conversation was made with another context. */
  | "other_context"
  /** A run goes on on its conversation. */
  | "busy"
  /** The caller has no login for a connection the agent's tools use. */
  | "needs_connection"
  /** A connection could not be made, or could not say who it is logged in as, at the run's start. */
  | "connection_failed"
  /** Answers named a question the run does not wait on, or the run was never started or has ended. */
  | "not_interrupted";

/** A run refused before it was admitted, with why. The same run asked again later may be admitted. */
export class RunRefused extends Error {
  override readonly name: string = "RunRefused";
  readonly reason: RefusedReason;
  constructor(reason: RefusedReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.reason = reason;
  }
}

/**
 * A run refused because its caller has no login for connections its agent's tools use: the person connects them, and the
 * same run, asked again, starts.
 */
export class ConnectionsMissing extends RunRefused {
  override readonly name = "ConnectionsMissing";
  readonly connections: readonly Connection[];
  constructor(connections: readonly Connection[], message: string) {
    super("needs_connection", message);
    this.connections = connections;
  }
}

/**
 * A run that was admitted and ended with no result: pi's reason (`aborted`, `model_error`, `restart_limit` and the
 * others), `no_submit` for an agent with an output that never submitted, or, for a run nobody attends, the question a
 * call asked before it acted: `needs_connection` for a login, `needs_answer` for anything else.
 */
export class RunFailed extends Error {
  override readonly name = "RunFailed";
  readonly reason: string;
  /** The questions it stopped on, when it stopped on any. */
  readonly interrupts: readonly Interrupt[];
  constructor(
    reason: string,
    message: string,
    interrupts: readonly Interrupt[] = [],
  ) {
    super(message);
    this.reason = reason;
    this.interrupts = interrupts;
  }
}
