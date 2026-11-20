import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasPodman } from "../sandbox/podman.fixture.ts";
import { startGarage } from "./garage.fixture.ts";
import {
  fileKey,
  type FileStore,
  folderFiles,
  memoryFiles,
  s3Files,
} from "./index.ts";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);

/** What every store holds to: a file put is the file got, by its key alone. */
function conforms(name: string, open: () => FileStore) {
  describe(name, () => {
    it("gives back a file put: its bytes, its type and its name", async () => {
      const store = open();
      const key = fileKey(7, "a");
      await store.put(key, {
        data: png,
        mediaType: "image/png",
        name: "bär code 1.png",
      });
      expect(await store.get(key)).toEqual({
        data: png,
        mediaType: "image/png",
        name: "bär code 1.png",
      });
    });

    it("gives undefined for a key with no file", async () => {
      expect(await open().get(fileKey(7, "none"))).toBeUndefined();
    });

    it("replaces a file put again at its key, and keeps each key apart", async () => {
      const store = open();
      await store.put(fileKey(7, "b"), {
        data: png,
        mediaType: "image/png",
        name: "one.png",
      });
      await store.put(fileKey(8, "b"), {
        data: new Uint8Array([1]),
        mediaType: "image/gif",
        name: "other.gif",
      });
      await store.put(fileKey(7, "b"), {
        data: new Uint8Array([2, 3]),
        mediaType: "image/webp",
        name: "two.webp",
      });
      expect(await store.get(fileKey(7, "b"))).toEqual({
        data: new Uint8Array([2, 3]),
        mediaType: "image/webp",
        name: "two.webp",
      });
      expect((await store.get(fileKey(8, "b")))?.name).toBe("other.gif");
    });
  });
}

conforms("memoryFiles", () => memoryFiles());

const folder = mkdtempSync(join(tmpdir(), "que-pasa-files-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
conforms("folderFiles", () => folderFiles({ root: folder }));

describe("folderFiles, its keys", () => {
  it("refuses a key that reaches outside its root", async () => {
    const store = folderFiles({ root: folder });
    await expect(store.get("../outside")).rejects.toBeInstanceOf(RangeError);
  });
});

// A real S3-compatible bucket, where podman is: the release's runner has it, the dev image does not.
describe.runIf(hasPodman)("s3Files, on Garage", () => {
  let garage: Awaited<ReturnType<typeof startGarage>> | undefined;
  beforeAll(async () => {
    garage = await startGarage();
  }, 120_000);
  afterAll(() => garage?.stop());
  conforms("put and get", () => s3Files(garage!));

  it("refuses a request its keys do not sign", async () => {
    const store = s3Files({ ...garage!, secretAccessKey: "2".repeat(64) });
    await expect(store.get(fileKey(7, "a"))).rejects.toThrow(/S3 get/);
  });
});
