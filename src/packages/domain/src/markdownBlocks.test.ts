import { describe, expect, it } from "vitest";

import { decomposeMarkdown } from "./markdownBlocks.js";

describe("decomposeMarkdown", () => {
  it("maps a heading-free document to a single untitled reading unit", () => {
    const units = decomposeMarkdown("First paragraph.\n\nSecond paragraph.");

    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBeUndefined();
    expect(units[0]?.blocks.map((block) => block.blockType)).toEqual(["paragraph", "paragraph"]);
    expect(units[0]?.blocks.map((block) => block.plaintext)).toEqual([
      "First paragraph.",
      "Second paragraph."
    ]);
  });

  it("decomposes every supported block type in document order", () => {
    const markdown = [
      "# Title",
      "",
      "A paragraph.",
      "",
      "- one",
      "- two",
      "",
      "> a quote",
      "",
      "```",
      "code line",
      "```"
    ].join("\n");

    const units = decomposeMarkdown(markdown);

    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBe("Title");
    expect(units[0]?.blocks.map((block) => block.blockType)).toEqual([
      "heading",
      "paragraph",
      "list",
      "blockquote",
      "code"
    ]);
    expect(units[0]?.blocks.map((block) => block.plaintext)).toEqual([
      "Title",
      "A paragraph.",
      "onetwo",
      "a quote",
      "code line"
    ]);
  });

  it("starts a new reading unit at each heading and keeps leading content", () => {
    const markdown = [
      "Intro paragraph.",
      "",
      "# Chapter One",
      "",
      "Body one.",
      "",
      "## Chapter Two",
      "",
      "Body two."
    ].join("\n");

    const units = decomposeMarkdown(markdown);

    expect(units.map((unit) => unit.title)).toEqual([undefined, "Chapter One", "Chapter Two"]);
    expect(units.map((unit) => unit.blocks.map((block) => block.blockType))).toEqual([
      ["paragraph"],
      ["heading", "paragraph"],
      ["heading", "paragraph"]
    ]);
    expect(units[0]?.blocks[0]?.plaintext).toBe("Intro paragraph.");
  });

  it("treats a heading with no text as an untitled section", () => {
    const units = decomposeMarkdown("#\n\nBody.");

    expect(units).toHaveLength(1);
    expect(units[0]?.title).toBeUndefined();
    expect(units[0]?.blocks.map((block) => block.blockType)).toEqual(["heading", "paragraph"]);
  });

  it("skips unsupported nodes between supported blocks", () => {
    const units = decomposeMarkdown("Para one.\n\n---\n\nPara two.");

    expect(units).toHaveLength(1);
    expect(units[0]?.blocks.map((block) => block.plaintext)).toEqual(["Para one.", "Para two."]);
  });

  it("returns no reading units for content without supported blocks", () => {
    expect(decomposeMarkdown("---")).toEqual([]);
  });

  it("carries the mdast node and freezes its output", () => {
    const units = decomposeMarkdown("# Title\n\nBody.");

    expect(units[0]?.blocks[0]?.mdast.type).toBe("heading");
    expect(units[0]?.blocks[1]?.mdast.type).toBe("paragraph");
    expect(Object.isFrozen(units[0])).toBe(true);
    expect(Object.isFrozen(units[0]?.blocks)).toBe(true);
    expect(Object.isFrozen(units[0]?.blocks[0])).toBe(true);
  });
});
