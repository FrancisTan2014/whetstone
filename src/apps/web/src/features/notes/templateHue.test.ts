import { describe, expect, it } from "vitest";

import { templateSwatchClass } from "./templateHue.js";

describe("templateSwatchClass", () => {
  it("maps each note template to its hue-swatch class", () => {
    expect(templateSwatchClass("vocabulary")).toBe("templateHue--vocab");
    expect(templateSwatchClass("expression")).toBe("templateHue--expr");
    expect(templateSwatchClass("thought")).toBe("templateHue--thought");
  });

  it("falls back to the vocabulary hue for an unknown template", () => {
    expect(templateSwatchClass("mystery")).toBe("templateHue--vocab");
  });
});
