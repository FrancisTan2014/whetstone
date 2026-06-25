import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createImageResourceStore,
  imageContentTypeAllowlist,
  isAllowedImageContentType,
  isImageResourceId
} from "./imageResourceStore.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "whetstone-images-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const pngId = createHash("sha256").update(png).digest("hex");

describe("isAllowedImageContentType", () => {
  it("accepts the raster image allowlist and rejects SVG and anything else", () => {
    for (const contentType of imageContentTypeAllowlist) {
      expect(isAllowedImageContentType(contentType)).toBe(true);
    }

    expect(isAllowedImageContentType("image/svg+xml")).toBe(false);
    expect(isAllowedImageContentType("text/html")).toBe(false);
  });
});

describe("isImageResourceId", () => {
  it("accepts a 64-char lowercase hex digest and rejects anything else", () => {
    expect(isImageResourceId("a".repeat(64))).toBe(true);
    expect(isImageResourceId("A".repeat(64))).toBe(false);
    expect(isImageResourceId("abc")).toBe(false);
    expect(isImageResourceId("../evil")).toBe(false);
  });
});

describe("createImageResourceStore", () => {
  it("stores image bytes once, content-addressed, and reads them back with the content type", async () => {
    const store = createImageResourceStore(directory);

    const first = await store.store({ bytes: png, contentType: "image/png" });
    const second = await store.store({ bytes: new Uint8Array(png), contentType: "image/png" });

    // Identical bytes share one id and one resource on disk (the bytes file + its type sidecar).
    expect(first.id).toBe(pngId);
    expect(second.id).toBe(pngId);
    expect((await readdir(directory)).sort()).toEqual([pngId, `${pngId}.type`]);

    const resource = await store.read(first.id);
    expect(resource?.contentType).toBe("image/png");
    expect(resource?.bytes).toEqual(png);
  });

  it("rejects a disallowed content type (including SVG) at write time", async () => {
    const store = createImageResourceStore(directory);

    await expect(store.store({ bytes: png, contentType: "image/svg+xml" })).rejects.toThrow(
      /Unsupported image content type/
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it("returns undefined for an id that is not a content hash", async () => {
    const store = createImageResourceStore(directory);

    expect(await store.read("../evil")).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    const store = createImageResourceStore(directory);

    expect(await store.read("0".repeat(64))).toBeUndefined();
  });

  it("returns undefined when the content-type sidecar is missing", async () => {
    const store = createImageResourceStore(directory);
    const { id } = await store.store({ bytes: png, contentType: "image/png" });
    await rm(join(directory, `${id}.type`));

    expect(await store.read(id)).toBeUndefined();
  });

  it("propagates a non-ENOENT read error (e.g. the bytes path is a directory)", async () => {
    const store = createImageResourceStore(directory);
    await mkdir(join(directory, pngId));

    await expect(store.read(pngId)).rejects.toThrow();
  });

  it("preserves the recorded content type verbatim on read", async () => {
    const store = createImageResourceStore(directory);
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38]);

    const { id } = await store.store({ bytes: gif, contentType: "image/gif" });
    // Verify reads tolerate a foreign sidecar value (the serving boundary re-checks the allowlist).
    await writeFile(join(directory, `${id}.type`), "image/webp");

    expect((await store.read(id))?.contentType).toBe("image/webp");
  });
});
