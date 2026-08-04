import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The standing guard for #850: `pnpm typecheck` must SEE every TypeScript file a package owns --
// production, test, and test helper alike. The blindness this replaces was invisible: each package
// tsconfig carried `"exclude": ["dist", "src/**/*.test.ts"]`, so 228 test files (318 type errors)
// never reached tsc while the gate reported success. A config edit alone can be silently reverted,
// so this test recomputes the truth from the compiler itself: it expands the root solution and every
// project it references exactly as `tsc -b` does, and fails naming any owned file left unchecked.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const rootConfigPath = resolve(repoRoot, "tsconfig.json");

// Package source roots: the same `<app|package>/src` shape the coverage gate measures. A file added
// anywhere below one of these is owned product or test source and must be type-checked.
const packageRoots = ["src/apps", "src/packages"];
const sourceExtensions = [".ts", ".tsx"];
const ignoredDirectories = new Set(["dist", "node_modules"]);

// Windows reports the drive letter inconsistently between the compiler and node:fs, and tsc
// normalizes to forward slashes; compare on one canonical form.
function canonical(filePath) {
  const normalized = resolve(filePath).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function listSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        found.push(...(await listSourceFiles(entryPath)));
      }
      continue;
    }
    if (sourceExtensions.some((extension) => entry.name.endsWith(extension))) {
      found.push(entryPath);
    }
  }
  return found;
}

// Every file the packages own: `<app|package>/src/**/*.{ts,tsx}`, minus build output.
async function ownedSourceFiles() {
  const owned = [];
  for (const packagesDir of packageRoots) {
    const absolutePackagesDir = resolve(repoRoot, packagesDir);
    for (const entry of await readdir(absolutePackagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const sourceDir = join(absolutePackagesDir, entry.name, "src");
      const contents = await readdir(sourceDir).catch(() => null);
      if (contents === null) {
        continue;
      }
      owned.push(...(await listSourceFiles(sourceDir)));
    }
  }
  return owned;
}

// Expand a solution the way `tsc -b` does: parse the config, then follow every project reference.
function checkedFilesOf(configPath, seen = new Set()) {
  const key = canonical(configPath);
  if (seen.has(key)) {
    return [];
  }
  seen.add(key);
  const host = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    }
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, host);
  if (parsed === undefined) {
    throw new Error(`could not parse ${configPath}`);
  }
  const files = [...parsed.fileNames];
  for (const reference of parsed.projectReferences ?? []) {
    // A reference may name a directory (implying its tsconfig.json) or a config file directly.
    files.push(...checkedFilesOf(ts.resolveProjectReferencePath(reference), seen));
  }
  return files;
}

describe("pnpm typecheck scope (#850)", () => {
  it("type-checks every file the packages own, tests included", async () => {
    const checked = new Set(checkedFilesOf(rootConfigPath).map(canonical));
    const owned = await ownedSourceFiles();
    expect(owned.length).toBeGreaterThan(0);

    const unchecked = owned
      .filter((file) => !checked.has(canonical(file)))
      .map((file) => file.slice(repoRoot.length).replaceAll("\\", "/"))
      .sort();

    expect(unchecked).toEqual([]);
  });

  it("sees test files, not only production files", () => {
    // Guards the guard: if the expansion ever stopped reporting tests, the assertion above would
    // pass vacuously for exactly the files #850 was about.
    const checked = checkedFilesOf(rootConfigPath).map(canonical);
    expect(checked.filter((file) => /\.test\.tsx?$/.test(file)).length).toBeGreaterThan(200);
  });

  it("keeps the root solution as the entry point `pnpm typecheck` builds", async () => {
    // The scope proven above is the root solution's. If the script stopped building it, the proof
    // would no longer describe the command reviewers and CI actually run.
    const packageJson = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
    expect(packageJson.scripts.typecheck).toMatch(/^tsc -b(?: |$)/);
  });
});
