import type { z } from "zod";
import { defineResource, type Resource } from "./resource.ts";

/**
 * Whose login a connection uses:
 * - user: each caller's own, so the agent acts as them, with their rights in the service
 * - shared: one login for the deployment, which its control plane lets some callers use
 */
export type ConnectionOwner = "user" | "shared";

/**
 * A link to one outside service, after LangChain's connections and que v1's connectors: a resource whose value is the
 * connection a tool acts through, such as a logged-in client. A tool lists it in `uses` and gets it with
 * `runtime.use(connection)`; it never gets the login. The deployment hands over the login (`openRuntime({ credentialFor
 * })`), and a run checks at its start that the caller has every one its agent's tools use.
 */
export type Connection<C = unknown> = Resource<C> & {
  readonly kind: "connection";
  /** What the service is, for a person asked to connect it. */
  readonly description?: string;
  readonly owner: ConnectionOwner;
  /** The login's shape, such as a URL, a database and an API key: a login the deployment hands over is checked against it. */
  readonly credential: z.ZodType;
  /** The connection, from a login that passed `credential`. */
  connect(credential: unknown): C | Promise<C>;
};

/** A connection, checked: its name is kebab-case, its owner one of the two, and its description not empty. */
export function defineConnection<S extends z.ZodType, C>(connection: {
  name: string;
  description?: string;
  owner: ConnectionOwner;
  credential: S;
  connect(credential: z.infer<S>): C | Promise<C>;
}): Connection<C> {
  const { name } = defineResource<C>(connection.name);
  if (connection.owner !== "user" && connection.owner !== "shared") {
    throw new Error(
      `connection "${name}": the owner must be "user" or "shared", not "${String(connection.owner)}"`,
    );
  }
  if (connection.description?.trim() === "") {
    throw new Error(`connection "${name}": the description is empty`);
  }
  return Object.freeze({
    ...connection,
    kind: "connection" as const,
    connect: (credential: unknown) =>
      connection.connect(credential as z.infer<S>),
  });
}

/** Whether a resource is a connection. */
export function isConnection(resource: Resource): resource is Connection {
  return (resource as Partial<Connection>).kind === "connection";
}
