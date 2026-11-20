import type { z } from "zod";
import type { Resource } from "./resource.ts";
import type { Json, Runtime } from "./runtime.ts";

/** A function an agent can call: written once in a workspace, so any agent in it can be given it. */
export type Tool<
  S extends z.ZodObject = z.ZodObject,
  C extends Json | undefined = undefined,
> = {
  /** What the model calls it by: snake_case, at most 64 characters. */
  name: string;
  /** What it does and when to call it. The model reads it to choose. */
  description: string;
  /** The input the model must give. */
  schema: S;
  /** The resources it asks its run for, with `runtime.use`: a sandbox, a connection. It never holds one. */
  uses?: readonly Resource[];
  /**
   * "safe": a call a crash cut off runs again when the run resumes. Left out, it never runs twice: the model gets an
   * `interrupted` result and decides what to do. pi's own term.
   */
  replay?: "safe";
  /**
   * The call itself. What it gives back is the model's text: a string as it is, any other value as JSON. To give the
   * person images too, it gives back `withImages(content, images)`: the model reads only `content`.
   */
  run(input: z.infer<S>, runtime: Runtime<C>): unknown;
};

/** The image types a tool may give: the ones every browser shows. Not SVG, which can run script when served. */
export const imageTypes = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

/** An image type a tool may give. */
export type ImageType = (typeof imageTypes)[number];

/** An image a tool makes for the person, as bytes: its file name, its type, and its data. */
export type ToolImage = {
  name: string;
  mediaType: ImageType;
  data: Uint8Array;
};

/**
 * What a tool gives back to give the person images, after LangChain's `content_and_artifact`: `content` for the model,
 * `images` for the person, which the model never reads.
 */
export type WithImages = {
  readonly kind: "with-images";
  readonly content: string;
  readonly images: readonly ToolImage[];
};

/** A tool's result with images for the person: `content` is what the model reads. */
export function withImages(
  content: string,
  images: readonly ToolImage[],
): WithImages {
  return Object.freeze({
    kind: "with-images",
    content,
    images: Object.freeze([...images]),
  });
}

/** Whether a tool's result is one `withImages` made. */
export function isWithImages(result: unknown): result is WithImages {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as Partial<WithImages>).kind === "with-images"
  );
}

/**
 * A stored image, as a conversation keeps it: never its bytes, only what finds and shows it. Its bytes are fetched by
 * its id, from the conversation it belongs to.
 */
export type FileRef = {
  id: string;
  name: string;
  mediaType: ImageType;
  /** Its size, in bytes. */
  size: number;
};

const toolName = /^[a-z][a-z0-9_]{0,63}$/;

/** A tool, checked: its name is one the model providers take, and it says what it does. */
export function defineTool<
  S extends z.ZodObject,
  C extends Json | undefined = undefined,
>(tool: Tool<S, C>): Tool<S, C> {
  if (!toolName.test(tool.name)) {
    throw new Error(
      `tool "${tool.name}": the name must be snake_case, at most 64 characters`,
    );
  }
  if (tool.description.trim() === "") {
    throw new Error(`tool "${tool.name}": the description is empty`);
  }
  const uses = tool.uses ?? [];
  const named = new Set(uses.map((resource) => resource.name));
  if (named.size !== uses.length) {
    throw new Error(`tool "${tool.name}": a resource is in uses twice`);
  }
  return Object.freeze({
    ...tool,
    ...(tool.uses ? { uses: Object.freeze([...tool.uses]) } : {}),
  });
}
