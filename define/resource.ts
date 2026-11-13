declare const valueType: unique symbol;

/**
 * Something a tool needs that the host gives each conversation: a sandbox, or a connection. It holds no value,
 * only its name and the type of its value: the host provides the value per conversation (`openRuntime({ resources })`),
 * and a tool asks for it with `runtime.use(resource)`.
 */
export type Resource<T = unknown> = {
  /** kebab-case: the host provides it by this name. */
  readonly name: string;
  /** The type of its value; never set. */
  readonly [valueType]?: T;
};

const resourceName = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** A resource, checked: its name is kebab-case. */
export function defineResource<T>(name: string): Resource<T> {
  if (!resourceName.test(name)) {
    throw new Error(`resource "${name}": the name must be kebab-case`);
  }
  return Object.freeze({ name });
}
