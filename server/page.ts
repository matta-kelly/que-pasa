/** Pages as the server gives them: pi's `Page`, its `next` a cursor a query string carries, and the checks on both. */
import {
  type Cursor,
  type Page,
  StorageRequestError,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import { ServerError } from "./errors.ts";

/** The most a page of conversations or entries holds. */
export const pageMax = 100;

/** A page's size from a query string, checked as the operations check it. */
export const Limit = z.coerce.number().optional();

/** A cursor in a query string: pi's cursor, as base64url JSON. */
export const CursorParam = z
  .string()
  .min(1)
  .transform((text, check) => {
    try {
      const cursor: unknown = JSON.parse(
        atob(text.replaceAll("-", "+").replaceAll("_", "/")),
      );
      if (
        typeof cursor === "object" &&
        cursor !== null &&
        !Array.isArray(cursor)
      )
        return cursor as Cursor;
    } catch {
      // Not base64url JSON: refused below.
    }
    check.addIssue({ code: "custom", message: "cursor is not a page's next" });
    return z.NEVER;
  })
  .optional();

/** A page as the routes give it: its `next` as base64url JSON, for a query string. */
export function pageOut<T>({ items, next }: Page<T, Cursor>) {
  return next === undefined ? { items } : { items, next: cursorOut(next) };
}

/** A cursor as a query string carries it: base64url JSON. */
export function cursorOut(cursor: Cursor): string {
  return btoa(JSON.stringify(cursor))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** A query string, parsed, or 400 `bad_request`. */
export function paramsOf<T>(
  schema: z.ZodType<T>,
  query: Record<string, string>,
): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success)
    throw new ServerError(400, "bad_request", z.prettifyError(parsed.error));
  return parsed.data;
}

/** A page's size, 1 to `pageMax`, or 400 `bad_request`. */
export function checkLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > pageMax)
    throw new ServerError(
      400,
      "bad_request",
      `limit must be a whole number from 1 to ${pageMax}`,
    );
}

/** A read whose query or cursor storage refuses, such as a cursor of another query, as 400 `bad_request`. */
export async function badRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof StorageRequestError)
      throw new ServerError(400, "bad_request", error.message, {
        cause: error,
      });
    throw error;
  }
}
