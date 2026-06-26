import { describe, expect, it } from "vitest";

import { blockTypes } from "./block.js";

describe("blockTypes", () => {
  it("lists the supported v0 block types", () => {
    expect(blockTypes).toEqual(["paragraph", "heading", "list", "blockquote", "code", "figure"]);
  });
});
