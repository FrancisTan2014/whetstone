import { describe, expect, it } from "vitest";

import { readingEntranceMotion } from "./readingEntrance.js";

describe("readingEntranceMotion", () => {
  it("keeps the reading content fully opaque so text is legible on arrival, settling vertically", () => {
    const entrance = readingEntranceMotion(false);

    // Behavior that fixes #182: the reading text must never fade in from a low opacity, because
    // dark Day text seen through a partly-transparent layer over the cream paper reads as washed
    // out. So opacity stays 1 at both ends; only a vertical offset settles to 0 with a spring.
    expect((entrance.initial as { opacity: number }).opacity).toBe(1);
    expect((entrance.animate as { opacity: number }).opacity).toBe(1);
    expect((entrance.initial as { y: number }).y).not.toBe(0);
    expect(entrance.animate).toEqual({ opacity: 1, y: 0 });
    expect((entrance.transition as { type?: string }).type).toBe("spring");
  });

  it("settles instantly with no movement under reduced motion", () => {
    const entrance = readingEntranceMotion(true);

    expect((entrance.initial as { opacity: number }).opacity).toBe(1);
    expect(entrance.initial).toEqual(entrance.animate);
    expect(entrance.transition).toEqual({ duration: 0 });
  });
});
