import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSafeSourceId,
  createSourceFileStore,
  hashBytes,
  hashMarkdown,
  resolveWithinDirectory
} from "./sourceFileStore.js";

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "whetstone-sources-"));
});

afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

describe("hashMarkdown", () => {
  it("computes a stable sha256 hex digest", () => {
    const digest = hashMarkdown("# Title");

    expect(digest).toBe(createHash("sha256").update("# Title", "utf8").digest("hex"));
    expect(digest).toBe(hashMarkdown("# Title"));
  });
});

describe("hashBytes", () => {
  it("computes a stable sha256 hex digest over raw bytes", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);

    expect(hashBytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(hashBytes(bytes)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4])));
  });
});

describe("assertSafeSourceId", () => {
  it("accepts ids of letters, digits, hyphen, and underscore", () => {
    expect(() => assertSafeSourceId("a1B-2_3")).not.toThrow();
  });

  it("rejects ids with separators or traversal", () => {
    expect(() => assertSafeSourceId("a/b")).toThrow();
    expect(() => assertSafeSourceId("../evil")).toThrow();
  });
});

describe("resolveWithinDirectory", () => {
  it("resolves paths inside the base directory", () => {
    expect(resolveWithinDirectory(directory, "abc.md")).toBe(resolve(directory, "abc.md"));
  });

  it("rejects paths that escape the base directory", () => {
    expect(() => resolveWithinDirectory(directory, "../escape.md")).toThrow();
  });
});

describe("createSourceFileStore", () => {
  it("writes markdown to a server-generated path and reports its sha256", async () => {
    const store = createSourceFileStore(directory);

    const written = await store.writeMarkdownSource({ id: "source-1", markdown: "Body text." });

    expect(written.path).toBe("source-1.md");
    expect(written.sha256).toBe(hashMarkdown("Body text."));
    expect(await readFile(join(directory, "source-1.md"), "utf8")).toBe("Body text.");
  });

  it("rejects an unsafe source id before writing", async () => {
    const store = createSourceFileStore(directory);

    await expect(store.writeMarkdownSource({ id: "../evil", markdown: "x" })).rejects.toThrow();
  });

  it("writes EPUB bytes to a server-generated path and reports its sha256", async () => {
    const store = createSourceFileStore(directory);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);

    const written = await store.writeEpubSource({ bytes, id: "source-2" });

    expect(written.path).toBe("source-2.epub");
    expect(written.sha256).toBe(hashBytes(bytes));
    expect(new Uint8Array(await readFile(join(directory, "source-2.epub")))).toEqual(bytes);
  });

  it("rejects an unsafe source id before writing an EPUB", async () => {
    const store = createSourceFileStore(directory);

    await expect(
      store.writeEpubSource({ bytes: new Uint8Array([1]), id: "../evil" })
    ).rejects.toThrow();
  });

  it("writes PDF bytes to a .pdf path and reports the PDF byte sha256", async () => {
    const store = createSourceFileStore(directory);
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9, 8, 7]);

    const written = await store.writePdfSource({ bytes, id: "source-3" });

    expect(written.path).toBe("source-3.pdf");
    expect(written.sha256).toBe(hashBytes(bytes));
    expect(new Uint8Array(await readFile(join(directory, "source-3.pdf")))).toEqual(bytes);
  });
});
