import type { Caller, Json, Resource } from "../define/index.ts";
import type { RunState } from "./state.ts";

/** What a provider resolves a resource from: the run as it was started, read from its run document. */
export type RunOf = {
  runId: string;
  caller: Caller;
  /** Absent when the run was given none. */
  context?: Json;
};

/** The host's value of one resource, per run. */
export type Provider<T = unknown> = {
  readonly resource: Resource<T>;
  resolve(run: RunOf): T | Promise<T>;
};

/**
 * The host's value of a resource for each run, resolved from the run as it was started: a run that resumes in a new
 * process gets the same one.
 */
export function provide<T>(
  resource: Resource<T>,
  resolve: (run: RunOf) => T | Promise<T>,
): Provider<T> {
  return Object.freeze({ resource, resolve });
}

/** The host's providers, and each run's resolved values: resolved once per run while it goes on in this process. */
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
    /** The run's value of a resource. */
    use<T>(run: RunState, resource: Resource<T>): Promise<T> {
      const provider = byName.get(resource.name);
      if (!provider)
        throw new Error(`resource "${resource.name}" is not provided`);
      const values =
        resolved.get(run.runId) ??
        resolved.set(run.runId, new Map()).get(run.runId)!;
      let value = values.get(resource.name);
      if (!value) {
        const { runId, caller, context } = run;
        value = Promise.resolve(
          provider.resolve({
            runId,
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
    /** Drop a run's values, when it ends. */
    forget(runId: string) {
      resolved.delete(runId);
    },
    /** Drop every run's values, when the runtime closes. */
    clear() {
      resolved.clear();
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
