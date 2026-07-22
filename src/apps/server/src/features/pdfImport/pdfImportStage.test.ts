import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPdfImportStageStore, type PdfImportStageStore } from "./pdfImportStage.js";

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

  it("rejects a path-traversal stage id on every entry point", async () => {
    await expect(store.createStage("../escape", new Uint8Array([0]))).rejects.toThrow(
      /letters, digits, hyphen, or underscore/
    );
    expect(() => store.openStage("a/b")).toThrow(/letters, digits, hyphen, or underscore/);
    await expect(store.removeStage("")).rejects.toThrow(/letters, digits, hyphen, or underscore/);
  });
});
