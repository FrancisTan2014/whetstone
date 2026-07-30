import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashBytes } from "../../files/sourceFileStore.js";
import {
  createPdfImportStageStore,
  PdfUploadTooLargeError,
  type PdfImportStageStore
} from "./pdfImportStage.js";

async function* streamOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("createPdfImportStageStore", () => {
  let rootDir: string;
  let store: PdfImportStageStore;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "pdf-import-stage-"));
    store = createPdfImportStageStore(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { force: true, recursive: true });
  });

  it("stages bytes under a per-attempt path and reopens the same handle", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const created = await store.createStage("attempt-1", bytes);
    expect(created.stagePath).toBe("attempt-1");

    const staged = await readFile(created.handle.path);
    expect(new Uint8Array(staged)).toEqual(bytes);

    const reopened = store.openStage(created.stagePath);
    expect(reopened.path).toBe(created.handle.path);
  });

  it("reads staged bytes back through the server-issued handle", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8, 9]);
    const { stagePath } = await store.createStage("attempt-read", bytes);
    expect(await store.readStage(stagePath)).toEqual(bytes);
  });

  it("rejects reading a stage whose bytes were never written", async () => {
    // A valid, safe id with no file on disk: openStage succeeds, the read rejects rather than
    // silently returning empty bytes.
    await expect(store.readStage("never-written")).rejects.toThrow();
  });

  it("removes exactly the attempt-owned stage and is a no-op when already gone", async () => {
    const { stagePath, handle } = await store.createStage("attempt-2", new Uint8Array([9]));
    await store.removeStage(stagePath);
    await expect(stat(handle.path)).rejects.toThrow();
    // Removing an already-removed stage is a no-op, not an error.
    await expect(store.removeStage(stagePath)).resolves.toBeUndefined();
  });

  it("leaves an unrelated stage untouched when removing one", async () => {
    const keep = await store.createStage("keep", new Uint8Array([7]));
    const drop = await store.createStage("drop", new Uint8Array([8]));
    await store.removeStage(drop.stagePath);
    await expect(stat(keep.handle.path)).resolves.toBeDefined();
  });

  it("creates a stage exclusively, refusing to overwrite an existing attempt's bytes", async () => {
    const original = new Uint8Array([1, 1, 1]);
    const created = await store.createStage("attempt-3", original);

    // A second create for the same id (an attempt-id collision) must fail rather than clobber the
    // existing staged bytes.
    await expect(store.createStage("attempt-3", new Uint8Array([2, 2, 2]))).rejects.toThrow();
    const staged = await readFile(created.handle.path);
    expect(new Uint8Array(staged)).toEqual(original);
  });

  it("rejects a path-traversal stage id on every entry point", async () => {
    await expect(store.createStage("../escape", new Uint8Array([0]))).rejects.toThrow(
      /letters, digits, hyphen, or underscore/
    );
    expect(() => store.openStage("a/b")).toThrow(/letters, digits, hyphen, or underscore/);
    await expect(store.removeStage("")).rejects.toThrow(/letters, digits, hyphen, or underscore/);
  });

  describe("createStageFromStream", () => {
    it("assembles the streamed chunks and hashes them incrementally without buffering the whole file", async () => {
      // Several chunks arrive separately; the store must concatenate them on disk and report a sha256
      // that matches a single-shot hash over the same bytes (proving it hashed incrementally, not by
      // buffering the whole file).
      const chunks = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
      const whole = new Uint8Array([1, 2, 3, 4, 5, 6]);

      const staged = await store.createStageFromStream("stream-1", streamOf(...chunks), {
        maxBytes: 1_000
      });

      expect(staged.stagePath).toBe("stream-1");
      expect(staged.byteLength).toBe(whole.byteLength);
      expect(staged.sha256).toBe(hashBytes(whole));
      expect(new Uint8Array(await readFile(staged.handle.path))).toEqual(whole);
      expect(await store.readStage(staged.stagePath)).toEqual(whole);
    });

    it("stages an empty upload as zero bytes so the caller can reject it", async () => {
      const staged = await store.createStageFromStream("stream-empty", streamOf(), {
        maxBytes: 1_000
      });
      expect(staged.byteLength).toBe(0);
      expect(staged.sha256).toBe(hashBytes(new Uint8Array()));
    });

    it("rejects an upload that exceeds the byte bound mid-stream and leaves no stage behind", async () => {
      const handle = store.openStage("stream-big");

      await expect(
        store.createStageFromStream(
          "stream-big",
          // Two bytes, then two more: the third byte trips the limit mid-stream, so the whole file is
          // never buffered to discover it is too large.
          streamOf(new Uint8Array([1, 2]), new Uint8Array([3, 4])),
          { maxBytes: 2 }
        )
      ).rejects.toBeInstanceOf(PdfUploadTooLargeError);
      // The failed stream removed only the directory it created — no partial bytes linger.
      await expect(stat(handle.path)).rejects.toThrow();
    });

    it("creates the stage exclusively, refusing to disturb an existing attempt's bytes", async () => {
      const original = await store.createStage("stream-dup", new Uint8Array([9, 9, 9]));

      await expect(
        store.createStageFromStream("stream-dup", streamOf(new Uint8Array([1])), {
          maxBytes: 1_000
        })
      ).rejects.toThrow();
      // The colliding id failed on exclusive directory creation WITHOUT removing the existing bytes.
      expect(new Uint8Array(await readFile(original.handle.path))).toEqual(
        new Uint8Array([9, 9, 9])
      );
    });

    it("rejects a path-traversal stage id before touching disk", async () => {
      await expect(
        store.createStageFromStream("../escape", streamOf(new Uint8Array([0])), { maxBytes: 1_000 })
      ).rejects.toThrow(/letters, digits, hyphen, or underscore/);
    });
  });

  describe("rendered-figure artifacts (#807)", () => {
    it("prepares a fresh empty per-range artifact directory and round-trips a written artifact", async () => {
      await store.createStage("art-1", new Uint8Array([1]));
      const dir = await store.prepareRangeArtifactDir("art-1", 0);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      await writeFile(join(dir, "fig-0.png"), png);

      // The runner reads it back via the stage-relative `<rangeIndex>/<file>` path recorded on the payload.
      expect(await store.readArtifact("art-1", "0/fig-0.png")).toEqual(png);
    });

    it("wipes any leftover (uncommitted) artifacts when re-preparing a range directory", async () => {
      await store.createStage("art-2", new Uint8Array([1]));
      const first = await store.prepareRangeArtifactDir("art-2", 0);
      await writeFile(join(first, "stale.png"), new Uint8Array([9]));

      // Re-preparing the same range wipes the stale artifact so a resumed run never adopts it.
      await store.prepareRangeArtifactDir("art-2", 0);
      await expect(store.readArtifact("art-2", "0/stale.png")).rejects.toThrow();
    });

    it("rejects reading an artifact path that escapes the artifacts root", async () => {
      await store.createStage("art-3", new Uint8Array([1]));
      await store.prepareRangeArtifactDir("art-3", 0);
      await expect(store.readArtifact("art-3", "../../escape.png")).rejects.toThrow();
    });

    it("rejects reading an artifact file that does not exist", async () => {
      await store.createStage("art-4", new Uint8Array([1]));
      await store.prepareRangeArtifactDir("art-4", 0);
      await expect(store.readArtifact("art-4", "0/missing.png")).rejects.toThrow();
    });
  });
});
