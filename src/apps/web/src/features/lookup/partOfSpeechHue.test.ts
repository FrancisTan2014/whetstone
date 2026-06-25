import { describe, expect, it } from "vitest";

import { partOfSpeechHueClass } from "./partOfSpeechHue";

describe("partOfSpeechHueClass", () => {
  it("maps each known part of speech to its hue class", () => {
    expect(partOfSpeechHueClass("noun")).toBe("lookupPos--noun");
    expect(partOfSpeechHueClass("verb")).toBe("lookupPos--verb");
    expect(partOfSpeechHueClass("adjective")).toBe("lookupPos--adjective");
    expect(partOfSpeechHueClass("adverb")).toBe("lookupPos--adverb");
  });

  it("falls back to the neutral hue for an unknown part of speech", () => {
    expect(partOfSpeechHueClass("interjection")).toBe("lookupPos--other");
  });

  it("falls back to the neutral hue when there is no part of speech", () => {
    expect(partOfSpeechHueClass(undefined)).toBe("lookupPos--other");
  });
});
