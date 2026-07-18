import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The standalone Memory/Recall client experience is retired (#662): its feature directory, pages, and
// nav entry are gone, folded into Notes + the Notes-owned Review session. These structural guards lock
// the retirement in place so a later change cannot silently reintroduce a Memory page, a Memory nav tab,
// a `/recall` push redirect that loops history, or a browser that still calls the deleted server surface.

function abs(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(abs(relative), "utf8");
}

// Strip line and block comments so a structural scan asserts on real code, not on prose that documents
// the retirement (e.g. a nav comment noting Notes occupies the former Memory position).
function code(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/[^\n]*/gu, "");
}

// Every source file (code only, comments stripped) under the web app's src tree.
function webSourceFiles(): readonly string[] {
  const root = abs("../");
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = `${dir}/${name}`;
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/u.test(name)) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

describe("standalone Memory client retirement (#662)", () => {
  it("deletes the Memory feature directory and its pages", () => {
    expect(existsSync(abs("../features/memory"))).toBe(false);
    for (const file of webSourceFiles()) {
      const name = file.slice(file.lastIndexOf("/") + 1);
      expect(name).not.toBe("MemoryPage.tsx");
      expect(name).not.toBe("RecallPage.tsx");
    }
  });

  it("offers exactly the five retained primary destinations, none of them Memory or Recall", () => {
    const navigation = code("./navigation.ts");
    // #638 recomposed the primary nav to five learner modes; Search moved out to a shell utility. The
    // enduring #662 guarantee is only that the retired Memory/Recall never return as primary destinations.
    for (const label of ['"Today"', '"Library"', '"Recite"', '"Notes"', '"Diary"']) {
      expect(navigation).toContain(label);
    }
    expect(navigation).not.toContain('"Memory"');
    expect(navigation).not.toContain('"Recall"');
  });

  it("redirects the legacy /memory and /recall hashes with history-replace, never a push loop", () => {
    const routes = code("./AppRoutes.tsx");
    // Both compat redirects MUST use `<Navigate replace>` so back/forward never loops through the retired
    // hashes — a push redirect would trap the learner bouncing between /memory and /notes.
    expect(routes).toMatch(/<Navigate\s+replace\s+to="\/notes"\s*\/>[\s\S]*?path="memory"/u);
    expect(routes).toMatch(
      /<Navigate\s+replace\s+to="\/notes\/review"\s*\/>[\s\S]*?path="recall"/u
    );
    // The retired pages are never mounted.
    expect(routes).not.toContain("MemoryPage");
    expect(routes).not.toContain("RecallPage");
  });

  it("makes no browser call to the deleted Memory/Recall server surface", () => {
    for (const file of webSourceFiles()) {
      if (file.endsWith("memoryRetirement.test.ts")) {
        continue;
      }
      const body = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/[^\n]*/gu, "");
      expect(body).not.toContain("/api/memory");
      expect(body).not.toContain("/api/recall");
      expect(body).not.toContain("/memory/notes");
    }
  });
});
