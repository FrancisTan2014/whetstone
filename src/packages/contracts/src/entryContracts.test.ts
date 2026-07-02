import { describe, expect, it } from "vitest";

import {
  parseEntryDto,
  parseEntryIdDto,
  parseEntryLinkDto,
  parseEntryTypeDto,
  parseLinkTypeDto,
  parseNoteAnchorDto,
  parseWorkLanguageDto,
  parseWorkTypeDto
} from "./entryContracts.js";

const validLinkDto = {
  fromEntryId: "work-1",
  toEntryId: "reading-unit-1",
  type: "contains"
} as const;

const validAnchorDto = {
  blockEntryId: "block-1",
  contextSnapshot: "The quick brown fox jumps over the lazy dog.",
  endOffset: 19,
  selectedTextSnapshot: "brown fox",
  startOffset: 10
} as const;

describe("entry contract schemas", () => {
  it("parses external DTO shapes into immutable domain-aligned values", () => {
    const link = parseEntryLinkDto(validLinkDto);
    const anchor = parseNoteAnchorDto(validAnchorDto);
    const entry = parseEntryDto({
      id: "work-1",
      links: [validLinkDto],
      type: "work"
    });

    expect(parseEntryIdDto("entry-1")).toBe("entry-1");
    expect(parseEntryTypeDto("reading_unit")).toBe("reading_unit");
    expect(parseEntryTypeDto("toc_entry")).toBe("toc_entry");
    expect(parseLinkTypeDto("related_to")).toBe("related_to");
    expect(parseWorkTypeDto("essay")).toBe("essay");
    expect(parseWorkLanguageDto("zh-TW")).toBe("zh-TW");
    expect(link).toEqual(validLinkDto);
    expect(anchor).toEqual({ ...validAnchorDto, endBlockEntryId: validAnchorDto.blockEntryId });
    expect(entry).toEqual({ id: "work-1", links: [validLinkDto], type: "work" });
    expect(Object.isFrozen(link)).toBe(true);
    expect(Object.isFrozen(anchor)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.links)).toBe(true);
  });

  it("rejects invalid vocabulary values", () => {
    expect(() => parseEntryTypeDto("template")).toThrow();
    expect(() => parseLinkTypeDto("invalid")).toThrow();
    expect(() => parseWorkTypeDto("video")).toThrow();
    expect(() => parseWorkLanguageDto("zh")).toThrow();
    expect(() => parseEntryLinkDto({ ...validLinkDto, type: "invalid" })).toThrow();
  });

  it("rejects malformed external entry shapes", () => {
    expect(() => parseEntryIdDto(" ")).toThrow();
    expect(() =>
      parseEntryDto({ id: "work-1", links: [], type: "work", unexpected: true })
    ).toThrow();
  });

  it("parses a whole-block anchor without an offset range", () => {
    const anchor = parseNoteAnchorDto({
      blockEntryId: "block-1",
      contextSnapshot: "brown fox",
      selectedTextSnapshot: "brown fox"
    });

    expect(anchor).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: "brown fox",
      endBlockEntryId: "block-1",
      selectedTextSnapshot: "brown fox"
    });
  });

  it("parses a cross-block span anchor, defaulting nothing and keeping both offsets (#257)", () => {
    const anchor = parseNoteAnchorDto({
      blockEntryId: "block-1",
      contextSnapshot: "the start block text",
      endBlockEntryId: "block-3",
      endOffset: 4,
      selectedTextSnapshot: "spanned across blocks",
      startOffset: 12
    });

    expect(anchor).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: "the start block text",
      endBlockEntryId: "block-3",
      endOffset: 4,
      selectedTextSnapshot: "spanned across blocks",
      startOffset: 12
    });
  });

  it("rejects a cross-block span that omits an offset (#257)", () => {
    expect(() =>
      parseNoteAnchorDto({
        blockEntryId: "block-1",
        contextSnapshot: "ctx",
        endBlockEntryId: "block-3",
        selectedTextSnapshot: "x"
      })
    ).toThrow();
  });

  it("rejects invalid note anchors at the boundary", () => {
    expect(() => parseNoteAnchorDto({ ...validAnchorDto, startOffset: 10.5 })).toThrow();
    expect(() => parseNoteAnchorDto({ ...validAnchorDto, endOffset: 10 })).toThrow();
    expect(() => parseNoteAnchorDto({ ...validAnchorDto, endOffset: undefined })).toThrow();
    expect(() => parseNoteAnchorDto({ ...validAnchorDto, selectedTextSnapshot: " " })).toThrow();
    expect(() => parseNoteAnchorDto({ ...validAnchorDto, contextSnapshot: " " })).toThrow();
    expect(() =>
      parseNoteAnchorDto({ ...validAnchorDto, contextSnapshot: "No matching text here." })
    ).toThrow();
  });
});
