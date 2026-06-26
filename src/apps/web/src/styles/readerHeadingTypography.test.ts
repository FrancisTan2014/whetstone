import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The reader's heading hierarchy lives in theme.css (the artifact the reader actually renders), so
// this asserts the real rules rather than a restated constant: each level's size token, weight, and
// sans family, plus the monochrome, multi-cue invariants from #127 (non-increasing size, no two
// adjacent levels identical, every heading larger-or-heavier than the serif body, tonal-only color).
const css = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u").exec(css);

  if (match === null) {
    throw new Error(`CSS rule not found: ${selector}`);
  }

  return match[1] as string;
}

function declaration(body: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|;|\\{)\\s*${property}\\s*:\\s*([^;]+)`, "u").exec(body);

  return match === null ? undefined : (match[1] as string).trim();
}

function tokenRem(token: string): number {
  const match = new RegExp(`--${token}\\s*:\\s*([\\d.]+)rem;`, "u").exec(css);

  if (match === null) {
    throw new Error(`token not found: --${token}`);
  }

  return Number(match[1]);
}

function sizeTokenOf(tag: string): string {
  const value = declaration(ruleBody(`.reader ${tag}`), "font-size") ?? "";
  const match = /var\(--(text-scale-[\w-]+)\)/u.exec(value);

  if (match === null) {
    throw new Error(`${tag} font-size is not a text-scale token: ${value}`);
  }

  return match[1] as string;
}

function weightOf(tag: string): number {
  return Number(declaration(ruleBody(`.reader ${tag}`), "font-weight"));
}

type LevelSpec = Readonly<{
  marginTop: string;
  tag: string;
  token: string;
  uppercase: boolean;
  weight: number;
}>;

const levels: ReadonlyArray<LevelSpec> = [
  { marginTop: "2.5rem", tag: "h1", token: "text-scale-3xl", uppercase: false, weight: 700 },
  { marginTop: "2rem", tag: "h2", token: "text-scale-2xl", uppercase: false, weight: 700 },
  { marginTop: "1.5rem", tag: "h3", token: "text-scale-xl", uppercase: false, weight: 600 },
  { marginTop: "1.25rem", tag: "h4", token: "text-scale-lg", uppercase: false, weight: 700 },
  { marginTop: "1.25rem", tag: "h5", token: "text-scale-base", uppercase: true, weight: 700 },
  { marginTop: "1.25rem", tag: "h6", token: "text-scale-sm", uppercase: true, weight: 700 }
];

const bodySize = tokenRem("reading-size");
const bodyWeight = 400;

describe("reader heading typography", () => {
  it("sets every level's size token, weight, and space-above per the scale", () => {
    for (const level of levels) {
      const body = ruleBody(`.reader ${level.tag}`);
      expect(sizeTokenOf(level.tag)).toBe(level.token);
      expect(weightOf(level.tag)).toBe(level.weight);
      expect(declaration(body, "margin-block-start")).toBe(level.marginTop);
    }
  });

  it("sets all headings in the sans family (vs the serif reading body)", () => {
    const shared = ruleBody(".reader :where(h1, h2, h3, h4, h5, h6)");
    expect(declaration(shared, "font-family")).toBe("var(--font-sans)");
  });

  it("keeps heading color tonal only — text or muted, never a hue", () => {
    expect(declaration(ruleBody(".reader :where(h1, h2, h3, h4, h5, h6)"), "color")).toBe(
      "var(--color-text)"
    );
    // h5/h6 are muted (they fall below body size) but still tonal — no accent/hue token.
    const mutedRule = ruleBody(".reader :where(h5, h6)");
    expect(declaration(mutedRule, "color")).toBe("var(--color-text-muted)");
    expect(declaration(mutedRule, "text-transform")).toBe("uppercase");
  });

  it("has non-increasing sizes with no two adjacent levels identical", () => {
    const sizes = levels.map((level) => tokenRem(level.token));

    for (let index = 0; index + 1 < sizes.length; index += 1) {
      const current = sizes[index] as number;
      const next = sizes[index + 1] as number;
      expect(current).toBeGreaterThanOrEqual(next);

      const sameSize = current === next;
      const sameWeight = levels[index]?.weight === levels[index + 1]?.weight;
      expect(sameSize && sameWeight).toBe(false);
    }
  });

  it("makes every heading larger or heavier than the serif body, and caps the largest at 3xl", () => {
    for (const level of levels) {
      const size = tokenRem(level.token);
      const larger = size > bodySize;
      const heavier = level.weight > bodyWeight;
      expect(larger || heavier).toBe(true);
    }

    const largest = Math.max(...levels.map((level) => tokenRem(level.token)));
    expect(largest).toBe(tokenRem("text-scale-3xl"));
  });
});
