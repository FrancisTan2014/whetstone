import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createVoiceCaptureAudioStore,
  parseAudioRange,
  type VoiceCaptureAudioStore
} from "./voiceCaptureAudioStore.js";

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("parseAudioRange", () => {
  const size = 10;

  it("serves the whole file when no Range header is present", () => {
    expect(parseAudioRange(undefined, size)).toEqual({ kind: "full" });
  });

  it("serves the whole file for a malformed / multi-range header", () => {
    expect(parseAudioRange("bytes=0-1,4-5", size)).toEqual({ kind: "full" });
    expect(parseAudioRange("chunks=0-1", size)).toEqual({ kind: "full" });
  });

  it("serves the whole file for an empty `bytes=-` header", () => {
    expect(parseAudioRange("bytes=-", size)).toEqual({ kind: "full" });
  });

  it("resolves an open-ended range to the last byte", () => {
    expect(parseAudioRange("bytes=3-", size)).toEqual({
      kind: "range",
      range: { end: 9, start: 3 }
    });
  });

  it("resolves a bounded range and clamps the end to the last byte", () => {
    expect(parseAudioRange("bytes=2-5", size)).toEqual({
      kind: "range",
      range: { end: 5, start: 2 }
    });
    expect(parseAudioRange("bytes=2-100", size)).toEqual({
      kind: "range",
      range: { end: 9, start: 2 }
    });
  });

  it("resolves a suffix range to the final N bytes and clamps to the start", () => {
    expect(parseAudioRange("bytes=-4", size)).toEqual({
      kind: "range",
      range: { end: 9, start: 6 }
    });
    expect(parseAudioRange("bytes=-100", size)).toEqual({
      kind: "range",
      range: { end: 9, start: 0 }
    });
  });

  it("rejects a start past the last byte as unsatisfiable", () => {
    expect(parseAudioRange("bytes=10-12", size)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects an inverted range as unsatisfiable", () => {
    expect(parseAudioRange("bytes=5-2", size)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects a zero-length suffix as unsatisfiable", () => {
    expect(parseAudioRange("bytes=-0", size)).toEqual({ kind: "unsatisfiable" });
  });

  it("rejects any range against an empty file as unsatisfiable", () => {
    expect(parseAudioRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseAudioRange("bytes=-4", 0)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("createVoiceCaptureAudioStore.open", () => {
  let rootDir: string;
  let store: VoiceCaptureAudioStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "whetstone-audio-"));
    store = createVoiceCaptureAudioStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("opens a stored recording and streams the whole file", async () => {
    const path = join(rootDir, "clip.audio");
    await writeFile(path, Buffer.from("0123456789"));

    const opened = await store.open(path);
    expect(opened).not.toBeNull();
    expect(opened?.size).toBe(10);
    const bytes = await collect((opened as NonNullable<typeof opened>).read(null));
    expect(bytes.toString()).toBe("0123456789");
  });

  it("streams only the requested inclusive byte range", async () => {
    const path = join(rootDir, "clip.audio");
    await writeFile(path, Buffer.from("0123456789"));

    const opened = await store.open(path);
    const bytes = await collect((opened as NonNullable<typeof opened>).read({ end: 5, start: 2 }));
    expect(bytes.toString()).toBe("2345");
  });

  it("returns null for a path that escapes the voice-capture root", async () => {
    expect(await store.open(join(rootDir, "..", "outside.audio"))).toBeNull();
  });

  it("returns null when the recording is missing", async () => {
    expect(await store.open(join(rootDir, "gone.audio"))).toBeNull();
  });

  it("returns null when the stored path is a directory, not a file", async () => {
    const subDir = join(rootDir, "nested");
    await mkdir(subDir);
    expect(await store.open(subDir)).toBeNull();
  });
});
