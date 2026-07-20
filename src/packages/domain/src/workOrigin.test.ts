import { describe, expect, it } from "vitest";

import {
  isLibraryCreateOrigin,
  isWorkOrigin,
  libraryCreateOrigins,
  workOrigins
} from "./workOrigin.js";

describe("workOrigin", () => {
  it("names exactly the three content-authority origins", () => {
    expect([...workOrigins]).toStrictEqual(["imported", "manual", "authored"]);
  });

  it("recognizes each valid origin and rejects anything else", () => {
    for (const origin of workOrigins) {
      expect(isWorkOrigin(origin)).toBe(true);
    }
    expect(isWorkOrigin("owned")).toBe(false);
    expect(isWorkOrigin("")).toBe(false);
    expect(isWorkOrigin(undefined)).toBe(false);
  });

  // The security invariant: the Library create surface can offer only manual and imported, never
  // `authored`, so a client can't forge an owned Work through the generic works endpoint.
  it("restricts library-creatable origins to manual and imported, excluding authored", () => {
    expect([...libraryCreateOrigins]).toStrictEqual(["imported", "manual"]);
    expect(libraryCreateOrigins).not.toContain("authored");
    for (const origin of libraryCreateOrigins) {
      expect(workOrigins).toContain(origin);
    }
  });

  it("recognizes library-creatable origins and rejects authored or unknown values", () => {
    expect(isLibraryCreateOrigin("manual")).toBe(true);
    expect(isLibraryCreateOrigin("imported")).toBe(true);
    expect(isLibraryCreateOrigin("authored")).toBe(false);
    expect(isLibraryCreateOrigin("nonsense")).toBe(false);
  });
});
