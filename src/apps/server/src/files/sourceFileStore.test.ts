import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  assertSafeSourceId,
  createSourceFileStore,
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
});
