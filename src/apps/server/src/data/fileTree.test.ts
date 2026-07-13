import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectRoot, writeRoot } from "./fileTree.js";

const scratchDirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "whetstone-tree-"));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop() as string, { recursive: true, force: true });
  }
});

describe("collectRoot", () => {
  it("reports a missing root as present:false with no files", () => {
    expect(collectRoot(join(scratch(), "does-not-exist"))).toEqual({ present: false, files: [] });
  });

  it("walks a nested tree and returns files sorted by posix relative path", () => {
    const root = scratch();
    mkdirSync(join(root, "nested"), { recursive: true });
    writeFileSync(join(root, "b.txt"), "bee");
    writeFileSync(join(root, "a.txt"), "ay");
    writeFileSync(join(root, "nested", "c.txt"), "see");

    const result = collectRoot(root);
    expect(result.present).toBe(true);
    expect(result.files.map((file) => file.relativePath)).toEqual([
      "a.txt",
      "b.txt",
      "nested/c.txt"
    ]);
    expect(Buffer.from(result.files[0]!.bytes).toString()).toBe("ay");
    expect(Buffer.from(result.files[2]!.bytes).toString()).toBe("see");
  });

  it("fails loudly when the configured root is a file, not a directory", () => {
    const root = scratch();
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "x");
    expect(() => collectRoot(filePath)).toThrow(/is not a directory/);
  });

  it("fails loudly when the configured root cannot be stat-ed", () => {
    expect(() => collectRoot(`${scratch()}\u0000bad`)).toThrow(
      /Could not read the configured data root/
    );
  });
});

describe("writeRoot", () => {
  it("writes files into nested subdirectories under the target", () => {
    const target = join(scratch(), "out");
    writeRoot(target, [
      { relativePath: "a.txt", bytes: new Uint8Array([104, 105]) },
      { relativePath: "nested/c.txt", bytes: new Uint8Array([1, 2, 3]) }
    ]);
    expect(readFileSync(join(target, "a.txt")).toString()).toBe("hi");
    expect([...readFileSync(join(target, "nested", "c.txt"))]).toEqual([1, 2, 3]);
  });
});
