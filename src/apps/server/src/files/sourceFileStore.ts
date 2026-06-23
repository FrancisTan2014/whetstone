import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export type WriteMarkdownSourceInput = Readonly<{
  id: string;
  markdown: string;
}>;

export type WriteEpubSourceInput = Readonly<{
  bytes: Uint8Array;
  id: string;
}>;

export type WrittenMarkdownSource = Readonly<{
  path: string;
  sha256: string;
}>;

export type WrittenEpubSource = WrittenMarkdownSource;

export type SourceFileStore = Readonly<{
  hashBytes: (bytes: Uint8Array) => string;
  hashMarkdown: (markdown: string) => string;
  writeEpubSource: (input: WriteEpubSourceInput) => Promise<WrittenEpubSource>;
  writeMarkdownSource: (input: WriteMarkdownSourceInput) => Promise<WrittenMarkdownSource>;
}>;

// Server-generated ids only; user input is never used as a path segment.
const safeSourceIdPattern = /^[A-Za-z0-9_-]+$/;

export function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSafeSourceId(id: string): void {
  if (!safeSourceIdPattern.test(id)) {
    throw new Error("Source id must contain only letters, digits, hyphen, or underscore.");
  }
}

export function resolveWithinDirectory(baseDir: string, relativePath: string): string {
  const base = resolve(baseDir);
  const target = resolve(base, relativePath);

  if (!target.startsWith(base + sep)) {
    throw new Error("Resolved source path escapes the source files directory.");
  }

  return target;
}

export function createSourceFileStore(sourceFilesDir: string): SourceFileStore {
  async function writeSourceFile(
    id: string,
    extension: string,
    data: Uint8Array | string
  ): Promise<string> {
    assertSafeSourceId(id);
    const relativePath = `${id}.${extension}`;
    const target = resolveWithinDirectory(sourceFilesDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    const tempPath = `${target}.tmp`;
    await writeFile(tempPath, data);
    await rename(tempPath, target);

    return relativePath;
  }

  async function writeMarkdownSource(
    input: WriteMarkdownSourceInput
  ): Promise<WrittenMarkdownSource> {
    const path = await writeSourceFile(input.id, "md", input.markdown);

    return Object.freeze({ path, sha256: hashMarkdown(input.markdown) });
  }

  async function writeEpubSource(input: WriteEpubSourceInput): Promise<WrittenEpubSource> {
    const path = await writeSourceFile(input.id, "epub", input.bytes);

    return Object.freeze({ path, sha256: hashBytes(input.bytes) });
  }

  return Object.freeze({ hashBytes, hashMarkdown, writeEpubSource, writeMarkdownSource });
}
