import type { ConversationOf, Resource } from "../define/index.ts";

export type { ConversationOf };

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
 * on in this process.
 */
export function createResources(providers: readonly Provider[]) {
  const byName = new Map<string, Provider>();
  for (const provider of providers) {
    const { name } = provider.resource;
    if (byName.has(name))
      throw new Error(`resource "${name}" is provided twice`);
    byName.set(name, provider);
  }
  const resolved = new Map<string, Map<string, Promise<unknown>>>();

  return {
    /** Throws when a resource a tool uses has no provider: at open, never in a run. */
    check(uses: readonly { tool: string; resource: Resource }[]) {
      for (const { tool, resource } of uses) {
        if (!byName.has(resource.name)) {
          throw new Error(
            `tool "${tool}" uses resource "${resource.name}", which is not provided`,
          );
        }
      }
    },
    /** The conversation's value of a resource. */
    use<T>(of: ConversationOf, resource: Resource<T>): Promise<T> {
      const provider = byName.get(resource.name);
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
