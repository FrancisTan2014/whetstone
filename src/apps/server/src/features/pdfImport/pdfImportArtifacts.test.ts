import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  type PdfImageArtifactRef,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";

import {
  MAX_ARTIFACT_BYTES,
  MAX_ATTEMPT_ARTIFACT_BYTES,
  adoptRangeArtifacts,
  collectAdoptedArtifacts,
  readPngDimensions,
  sumAdoptedArtifactBytes,
  type ArtifactReader
} from "./pdfImportArtifacts.js";

const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// A structurally valid PNG: 8-byte signature + a well-formed IHDR chunk `readPngDimensions` parses,
// plus a short tail so byte lengths are distinguishable. Tests build the manifest ref from these bytes.
function pngBytes(width: number, height: number, tail: number): Uint8Array {
  const bytes = new Uint8Array(24 + tail);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  for (let index = 0; index < tail; index += 1) {
    bytes[24 + index] = (index * 7 + 3) & 0xff;
  }
  return bytes;
}

function refFor(
  path: string,
  bytes: Uint8Array,
  width: number,
  height: number
): PdfImageArtifactRef {
  return {
    path,
    contentType: "image/png",
    sha256: sha256Hex(bytes),
    byteLength: bytes.byteLength,
    width,
    height
  };
}

function item(partial: Partial<StructuredDocItem> & { label: string }): StructuredDocItem {
  return {
    boundingBox: { bottom: 10, left: 0, right: 10, top: 0 },
    charSpan: [0, 0],
    children: [],
    confidence: 0.9,
    label: partial.label,
    pageNumber: 1,
    text: "",
    ...partial
  };
}

function payload(body: readonly StructuredDocItem[]): RangeConversion {
  return {
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION,
    doclingSchema,
    pages: [{ pageNumber: 1, hasNativeText: true }],
    body: body as StructuredDocItem[],
    furniture: []
  };
}

function readerFrom(files: Readonly<Record<string, Uint8Array>>): ArtifactReader {
  return async (fileName) => {
    const bytes = files[fileName];
    if (bytes === undefined) {
      throw new Error(`ENOENT: ${fileName}`);
    }
    return bytes;
  };
}

describe("readPngDimensions", () => {
  it("reads width and height from a valid PNG IHDR", () => {
    expect(readPngDimensions(pngBytes(320, 200, 4))).toEqual({ width: 320, height: 200 });
  });

  it("returns null for bytes shorter than an IHDR header", () => {
    expect(readPngDimensions(new Uint8Array(10))).toBeNull();
  });

  it("returns null when the PNG signature does not match", () => {
    const bytes = pngBytes(10, 10, 4);
    bytes[0] = 0x00;
    expect(readPngDimensions(bytes)).toBeNull();
  });

  it("returns null when the first chunk is not IHDR", () => {
    const bytes = pngBytes(10, 10, 4);
    bytes[12] = 0x49;
    bytes[13] = 0x44; // corrupt "IHDR" -> "IDAT"-ish
    expect(readPngDimensions(bytes)).toBeNull();
  });
});

describe("adoptRangeArtifacts", () => {
  it("is a no-op that adopts nothing when the range has no pictures", async () => {
    const input = payload([item({ label: "text", text: "prose" })]);
    const result = await adoptRangeArtifacts({
      payload: input,
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({})
    });
    expect(result).toEqual({ status: "ok", payload: input, adoptedBytes: 0 });
  });

  it("adopts a valid picture and rewrites its path to the stage-relative form", async () => {
    const png = pngBytes(320, 200, 8);
    const ref = refFor("fig-0.png", png, 320, 200);
    const input = payload([
      item({ label: "text", text: "before" }),
      item({ label: "picture", imageArtifact: ref })
    ]);
    const result = await adoptRangeArtifacts({
      payload: input,
      rangeIndex: 3,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.adoptedBytes).toBe(png.byteLength);
    const picture = result.payload.body[1]!;
    expect(picture.imageArtifact?.path).toBe("3/fig-0.png");
    expect(picture.imageArtifact?.sha256).toBe(ref.sha256);
  });

  it("adopts a picture nested inside another item's children", async () => {
    const png = pngBytes(64, 48, 4);
    const ref = refFor("fig-0.png", png, 64, 48);
    const input = payload([
      item({ label: "group", children: [item({ label: "picture", imageArtifact: ref })] })
    ]);
    const result = await adoptRangeArtifacts({
      payload: input,
      rangeIndex: 1,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.payload.body[0]!.children[0]!.imageArtifact?.path).toBe("1/fig-0.png");
  });

  it("is fatal (and stringifies a non-Error cause) when the reader rejects with a non-Error", async () => {
    const png = pngBytes(10, 10, 4);
    const ref = refFor("fig-0.png", png, 10, 10);
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: async () => {
        throw "disk offline";
      }
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("disk offline");
  });

  it("is fatal when an artifact file cannot be read", async () => {
    const png = pngBytes(10, 10, 4);
    const ref = refFor("missing.png", png, 10, 10);
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({})
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("could not be read");
  });

  it("is fatal when the byte length disagrees with the manifest", async () => {
    const png = pngBytes(10, 10, 8);
    const ref = { ...refFor("fig-0.png", png, 10, 10), byteLength: png.byteLength + 1 };
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("manifest claims");
  });

  it("is fatal when the sha256 digest disagrees with the manifest", async () => {
    const png = pngBytes(10, 10, 8);
    const ref = { ...refFor("fig-0.png", png, 10, 10), sha256: "a".repeat(64) };
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("sha256");
  });

  it("is fatal when the bytes are not a readable PNG", async () => {
    const notPng = new Uint8Array(40).fill(0x20);
    const ref = refFor("fig-0.png", notPng, 10, 10);
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": notPng })
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("not a readable PNG");
  });

  it("is fatal when the manifest dimensions disagree with the PNG IHDR", async () => {
    const png = pngBytes(320, 200, 8);
    const ref = { ...refFor("fig-0.png", png, 320, 200), width: 100 };
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("fatal");
    if (result.status !== "fatal") return;
    expect(result.detail).toContain("manifest claims");
  });

  it("strips (falls back to a placeholder) a picture larger than the per-artifact bound", async () => {
    // A real over-bound artifact: bytes just over the 16 MiB per-picture limit, so both the manifest
    // length and the file agree and adoption strips it rather than adopting.
    const big = pngBytes(10, 10, MAX_ARTIFACT_BYTES);
    const bigRef = refFor("fig-0.png", big, 10, 10);
    expect(bigRef.byteLength).toBeGreaterThan(MAX_ARTIFACT_BYTES);
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: bigRef })]),
      rangeIndex: 0,
      adoptedBytesSoFar: 0,
      readArtifact: readerFrom({ "fig-0.png": big })
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.adoptedBytes).toBe(0);
    expect(result.payload.body[0]!.imageArtifact).toBeUndefined();
  });

  it("strips a picture that would push the attempt's adopted total over the budget", async () => {
    const png = pngBytes(64, 48, 8);
    const ref = refFor("fig-0.png", png, 64, 48);
    const result = await adoptRangeArtifacts({
      payload: payload([item({ label: "picture", imageArtifact: ref })]),
      rangeIndex: 0,
      // Already at the attempt budget: any further adoption is over-bound.
      adoptedBytesSoFar: MAX_ATTEMPT_ARTIFACT_BYTES,
      readArtifact: readerFrom({ "fig-0.png": png })
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.adoptedBytes).toBe(0);
    expect(result.payload.body[0]!.imageArtifact).toBeUndefined();
  });
});

describe("sumAdoptedArtifactBytes", () => {
  it("sums adopted artifact byte lengths across ranges and nested items", () => {
    const a = refFor("0/fig-0.png", pngBytes(10, 10, 8), 10, 10);
    const b = refFor("1/fig-0.png", pngBytes(20, 20, 16), 20, 20);
    const ranges = [
      payload([item({ label: "picture", imageArtifact: a })]),
      payload([item({ label: "group", children: [item({ label: "picture", imageArtifact: b })] })])
    ];
    expect(sumAdoptedArtifactBytes(ranges)).toBe(a.byteLength + b.byteLength);
  });
});

describe("collectAdoptedArtifacts", () => {
  it("collects every adopted artifact in document order including nested items", () => {
    const a = refFor("0/fig-0.png", pngBytes(10, 10, 8), 10, 10);
    const b = refFor("0/fig-1.png", pngBytes(20, 20, 16), 20, 20);
    const document = {
      body: [
        item({ label: "picture", imageArtifact: a }),
        item({ label: "text", text: "no artifact" }),
        item({ label: "group", children: [item({ label: "picture", imageArtifact: b })] })
      ]
    };
    expect(collectAdoptedArtifacts(document)).toEqual([
      { path: a.path, sha256: a.sha256, byteLength: a.byteLength },
      { path: b.path, sha256: b.sha256, byteLength: b.byteLength }
    ]);
  });
});
