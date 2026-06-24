import { describe, expect, it } from "vitest";

import { highlightBirthMotion } from "./highlightBirth.js";

describe("highlightBirthMotion", () => {
  it("flushes the wash in with a soft spring when motion is allowed", () => {
    const birth = highlightBirthMotion(false);

    expect(birth.initial).toEqual({ opacity: 0.35, scale: 0.985 });
    expect(birth.animate).toEqual({ opacity: 1, scale: 1 });
    expect(birth.transition).toEqual({ type: "spring", stiffness: 170, damping: 26 });
  });

  it("shows the highlight instantly under reduced motion", () => {
    const birth = highlightBirthMotion(true);

    expect(birth.initial).toEqual(birth.animate);
    expect(birth.transition).toEqual({ duration: 0 });
  });
});
