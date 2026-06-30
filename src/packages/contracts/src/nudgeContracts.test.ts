import { describe, expect, it } from "vitest";

import {
  nudgeDtoSchema,
  parseNudgeDto,
  parseNudgeResponse,
  type NudgeDto
} from "./nudgeContracts.js";

const base: NudgeDto = {
  blockEntryId: "blk-1",
  caseId: "harvest-note-1",
  chunkId: "harvest-chunk-note-1",
  text: "thrive under pressure",
  workTitle: "On Grit"
};

describe("nudgeDtoSchema", () => {
  it("accepts a full nudge with a source block", () => {
    expect(parseNudgeDto(base)).toEqual(base);
  });

  it("accepts a nudge without a source block (optional)", () => {
    const { blockEntryId: _omitted, ...withoutBlock } = base;
    expect(parseNudgeDto(withoutBlock)).toEqual(withoutBlock);
  });

  it("rejects a blank block entry id", () => {
    expect(() => parseNudgeDto({ ...base, blockEntryId: "  " })).toThrow();
  });

  it("rejects unknown keys", () => {
    expect(nudgeDtoSchema.safeParse({ ...base, extra: true }).success).toBe(false);
  });
});

describe("parseNudgeResponse", () => {
  it("accepts a proposed nudge", () => {
    expect(parseNudgeResponse({ nudge: base })).toEqual({ nudge: base });
  });

  it("accepts an explicit null (nothing to surface)", () => {
    expect(parseNudgeResponse({ nudge: null })).toEqual({ nudge: null });
  });

  it("rejects a missing nudge field", () => {
    expect(() => parseNudgeResponse({})).toThrow();
  });
});
