import { AwsClient } from "aws4fetch";
import { imageTypes } from "../define/index.ts";
import type { FileStore } from "./store.ts";

/** Where an S3-compatible bucket is, and the keys to it: S3, Cloudflare R2, MinIO, Garage and the rest. */
export type S3Options = {
  /** The service's URL, such as `https://<account>.r2.cloudflarestorage.com` or `http://minio:9000`. */
  endpoint: string;
  bucket: string;
  /** The region the keys sign for: R2 takes `auto`; MinIO and Garage take what they were set up with. */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

/**
 * A store in an S3-compatible bucket: S3's `PutObject` and `GetObject`, path-style (`<endpoint>/<bucket>/<key>`), so
 * one shape reaches every S3-compatible service. A file's type is its object's `Content-Type`, its name the object's
 * `x-amz-meta-name`, URL-encoded, as S3 metadata is ASCII. Requests are signed with SigV4 by `aws4fetch`.
 */
export function s3Files({
  endpoint,
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
}: S3Options): FileStore {
  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: "s3",
    region,
  });
  const base = `${endpoint.replace(/\/+$/, "")}/${encodeURIComponent(bucket)}`;
  const urlOf = (key: string) =>
    `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

  async function failed(response: Response, what: string) {
    const body = await response.text().catch(() => "");
    return new Error(
      `S3 ${what}: ${response.status} ${response.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`,
    );
  }

  return {
    put: async (key, { data, mediaType, name }) => {
      const response = await client.fetch(urlOf(key), {
        method: "PUT",
        // A copy on its own buffer: fetch takes an ArrayBuffer, not a view of a shared one.
        body: data.slice().buffer,
        headers: {
          "content-type": mediaType,
          "x-amz-meta-name": encodeURIComponent(name),
        },
      });
      if (!response.ok) throw await failed(response, `put "${key}"`);
      await response.body?.cancel();
    },
    get: async (key) => {
      const response = await client.fetch(urlOf(key));
      if (response.status === 404) {
        await response.body?.cancel();
        return undefined;
      }
      if (!response.ok) throw await failed(response, `get "${key}"`);
      const mediaType = response.headers.get("content-type") ?? "";
      if (!(imageTypes as readonly string[]).includes(mediaType))
        throw new Error(
          `S3 get "${key}": its type "${mediaType}" is not an image's`,
        );
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        mediaType: mediaType as (typeof imageTypes)[number],
        name: decodeURIComponent(response.headers.get("x-amz-meta-name") ?? ""),
      };
    },
  };
}
