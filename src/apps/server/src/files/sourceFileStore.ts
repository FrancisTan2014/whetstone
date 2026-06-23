import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export type WriteMarkdownSourceInput = Readonly<{
  id: string;
  markdown: string;
}>;

export type WrittenMarkdownSource = Readonly<{
  path: string;
  sha256: string;
}>;

export type SourceFileStore = Readonly<{
  hashMarkdown: (markdown: string) => string;
  writeMarkdownSource: (input: WriteMarkdownSourceInput) => Promise<WrittenMarkdownSource>;
}>;

// Server-generated ids only; user input is never used as a path segment.
const safeSourceIdPattern = /^[A-Za-z0-9_-]+$/;

export function hashMarkdown(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
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
  async function writeMarkdownSource(
    input: WriteMarkdownSourceInput
  ): Promise<WrittenMarkdownSource> {
    assertSafeSourceId(input.id);
    const relativePath = `${input.id}.md`;
    const target = resolveWithinDirectory(sourceFilesDir, relativePath);
    await mkdir(dirname(target), { recursive: true });
    const tempPath = `${target}.tmp`;
    await writeFile(tempPath, input.markdown, "utf8");
    await rename(tempPath, target);

    return Object.freeze({ path: relativePath, sha256: hashMarkdown(input.markdown) });
  }

  return Object.freeze({ hashMarkdown, writeMarkdownSource });
}
