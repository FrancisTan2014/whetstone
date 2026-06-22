import { describe, expect, it } from "vitest";

import { formatProductHeading, productIdentity } from "./productIdentity.js";

describe("productIdentity", () => {
  it("exposes the minimal foundation product identity", () => {
    expect(productIdentity).toEqual({ focus: "foundation", name: "whetstone" });
    expect(formatProductHeading(productIdentity)).toBe("whetstone foundation");
  });
});
