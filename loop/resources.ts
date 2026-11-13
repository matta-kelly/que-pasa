import {
  type Caller,
  type Connection,
  type ConversationOf,
  isConnection,
  type Json,
  type Resource,
} from "../define/index.ts";

export type { ConversationOf };

/**
 * The deployment's logins, from its control plane: for a `user` connection the caller's own, for a `shared` one the one
 * login when the caller may use it, or undefined when there is none. que-pasa keeps no login: it asks when a run starts,
 * when a tool first needs the connection in a process, and again after the service refused it.
 */
export type CredentialFor = (request: {
  connection: Connection;
  caller: Caller;
}) => Json | undefined | Promise<Json | undefined>;

/** What resolving a connection throws when the deployment has no login for the caller. */
export class NoLogin extends Error {
  override readonly name = "NoLogin";
  readonly connection: Connection;
  constructor(connection: Connection, caller: Caller) {
    super(
      `connection "${connection.name}": there is no login for "${caller.id}"`,
    );
    this.connection = connection;
  }
}

/** The host's value of one resource, per conversation. */
export type Provider<T = unknown> = {
  readonly resource: Resource<T>;
  resolve(conversation: ConversationOf): T | Promise<T>;
};

/**
 * The host's value of a resource for each conversation, resolved from the conversation as its first run made it: every
 * run on it, also one that resumes in a new process, gets the same one.
 */
export function provide<T>(
  resource: Resource<T>,
  resolve: (conversation: ConversationOf) => T | Promise<T>,
): Provider<T> {
  return Object.freeze({ resource, resolve });
}

/**
 * The host's providers, and each conversation's resolved values: resolved once per conversation while a run on it goes
 * on in this process. A connection's value is resolved from the deployment's login for the conversation's caller,
 * through its own `connect`.
 */
export function createResources(
  providers: readonly Provider[],
  credentialFor: CredentialFor | undefined,
) {
  const byName = new Map<string, Provider>();
  for (const provider of providers) {
    const { name } = provider.resource;
    if (byName.has(name))
      throw new Error(`resource "${name}" is provided twice`);
    if (isConnection(provider.resource))
      throw new Error(
        `resource "${name}" is a connection: the deployment gives its logins with credentialFor, not provide`,
      );
    byName.set(name, provider);
  }

  /**
   * The caller's login for a connection, checked against its credential; undefined when the deployment has none. A login
   * that does not fit throws: the deployment's control plane holds a wrong one.
   */
  async function loginOf(connection: Connection, caller: Caller) {
    const login = await credentialFor?.({ connection, caller });
    if (login === undefined) return undefined;
    const checked = connection.credential.safeParse(login);
    if (!checked.success) {
      // The paths only: the login's values never go in a message.
      const paths = checked.error.issues.map(
        (issue) => issue.path.join(".") || "(the login)",
      );
      throw new Error(
        `connection "${connection.name}": the login for "${caller.id}" does not fit its credential at ${paths.join(", ")}`,
      );
    }
    return { credential: checked.data as unknown };
  }

  /** The connection's provider: the caller's login, checked, then connected. */
  const connected = (connection: Connection): Provider => ({
    resource: connection,
    async resolve({ caller }) {
      const login = await loginOf(connection, caller);
      if (!login) throw new NoLogin(connection, caller);
      return connection.connect(login.credential);
    },
  });
  const providerOf = (resource: Resource) =>
    isConnection(resource) ? connected(resource) : byName.get(resource.name);
  const resolved = new Map<string, Map<string, Promise<unknown>>>();

  return {
    /** Throws when a resource a tool uses has no provider: at open, never in a run. */
    check(uses: readonly { tool: string; resource: Resource }[]) {
      for (const { tool, resource } of uses) {
        if (isConnection(resource)) {
          if (!credentialFor) {
            throw new Error(
              `tool "${tool}" uses connection "${resource.name}", and the runtime has no credentialFor`,
            );
          }
          continue;
        }
        if (!byName.has(resource.name)) {
          throw new Error(
            `tool "${tool}" uses resource "${resource.name}", which is not provided`,
          );
        }
      }
    },
    /** The conversation's value of a resource. */
    use<T>(of: ConversationOf, resource: Resource<T>): Promise<T> {
      const provider = providerOf(resource);
      if (!provider)
        throw new Error(`resource "${resource.name}" is not provided`);
      const values =
        resolved.get(of.conversation) ??
        resolved.set(of.conversation, new Map()).get(of.conversation)!;
      let value = values.get(resource.name);
      if (!value) {
        const { conversation, caller, context } = of;
        value = Promise.resolve(
          provider.resolve({
            conversation,
            caller,
            ...(context === undefined ? {} : { context }),
          }),
        );
        // A failed resolve is not kept: the next call tries again.
        value.catch(() => values.delete(resource.name));
        values.set(resource.name, value);
      }
      return value as Promise<T>;
    },
    /**
     * The connections of `connections` the caller has no login for: a run that needs one does not start. A login that does
     * not fit its credential throws.
     */
    async missing(caller: Caller, connections: readonly Connection[]) {
      const missing: Connection[] = [];
      for (const connection of connections) {
        if (!(await loginOf(connection, caller))) missing.push(connection);
      }
      return missing;
    },
    /** Drop one value of a conversation, such as a connection whose login the service refused: the next use resolves it again. */
    drop(conversation: string, resource: string) {
      resolved.get(conversation)?.delete(resource);
    },
    /** Drop a conversation's values, when its run ends. */
    forget(conversation: string) {
      resolved.delete(conversation);
    },
    /** Drop every conversation's values, when the runtime closes. */
    clear() {
      resolved.clear();
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
