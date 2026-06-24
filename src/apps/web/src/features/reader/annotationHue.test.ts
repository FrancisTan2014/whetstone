import { describe, expect, it } from "vitest";

import { annotationHueClass } from "./annotationHue.js";

describe("annotationHueClass", () => {
  it("maps each note template to its annotation hue", () => {
    expect(annotationHueClass("vocabulary")).toBe("readerBlock--vocab");
    expect(annotationHueClass("expression")).toBe("readerBlock--expr");
    expect(annotationHueClass("thought")).toBe("readerBlock--thought");
  });

  it("falls back to the vocabulary hue for an unknown template", () => {
    expect(annotationHueClass("mystery")).toBe("readerBlock--vocab");
  });
});
