import { describe, expect, it } from "vitest";

import { highlightBirthMotion } from "./highlightBirth.js";

describe("highlightBirthMotion", () => {
  it("flushes the wash in from a distinct dimmed start to a fully-shown end with a spring", () => {
    const birth = highlightBirthMotion(false);

    // Behavior: distinct start/end — the wash starts dimmer and slightly smaller, then settles
    // fully shown — and animates with a spring. The exact spring magnitudes and start values are
    // tokens (see motion.tokens.ts / highlightBirth), not asserted here.
    expect(birth.initial).not.toEqual(birth.animate);
    expect(birth.animate).toEqual({ opacity: 1, scale: 1 });
    expect((birth.initial as { opacity: number }).opacity).toBeLessThan(1);
    expect((birth.initial as { scale: number }).scale).toBeLessThan(1);
    expect((birth.transition as { type?: string }).type).toBe("spring");
  });

  it("shows the highlight instantly under reduced motion", () => {
    const birth = highlightBirthMotion(true);

    expect(birth.initial).toEqual(birth.animate);
    expect(birth.transition).toEqual({ duration: 0 });
  });
});
