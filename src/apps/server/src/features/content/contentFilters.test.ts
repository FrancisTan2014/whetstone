import { describe, expect, it } from "vitest";

import type { PersistableBlock, PersistableReadingUnit } from "./blockWriter.js";
import {
  applyContentFilters,
  defaultContentFilters,
  dropPublisherBoilerplateFilter,
  type ContentFilter
} from "./contentFilters.js";

function block(plaintext: string): PersistableBlock {
  return {
    alt: null,
    anchorId: null,
    backlinkAnchorId: null,
    blockType: "paragraph",
    imageResourceId: null,
    mdast: {},
    plaintext
  };
}

function unit(title: string | undefined, ...texts: string[]): PersistableReadingUnit {
  return { blocks: texts.map(block), docBlocks: [], evidence: [], sourceFile: null, title };
}

const dropAll: ContentFilter = { apply: () => [], enabled: true, id: "drop-all" };
const tagFirst: ContentFilter = {
  apply: (units) => units.slice(0, 1),
  enabled: true,
  id: "keep-first"
};

describe("applyContentFilters", () => {
  it("is the identity when no filters are registered", () => {
    const units = [unit("Chapter One", "Body.")];
    expect(applyContentFilters(units, [])).toBe(units);
  });

  it("threads each enabled filter's output into the next, in order", () => {
    const units = [unit("A", "a"), unit("B", "b"), unit("C", "c")];
    // keep-first then a no-op identity filter: only the first unit survives, proving order matters.
    const identity: ContentFilter = { apply: (current) => current, enabled: true, id: "identity" };

    const result = applyContentFilters(units, [tagFirst, identity]);

    expect(result.map((value) => value.title)).toEqual(["A"]);
  });

  it("skips a disabled filter", () => {
    const units = [unit("A", "a"), unit("B", "b")];
    const disabledDropAll: ContentFilter = { ...dropAll, enabled: false };

    expect(applyContentFilters(units, [disabledDropAll])).toBe(units);
  });
});

describe("dropPublisherBoilerplateFilter", () => {
  it("drops units whose title is publisher boilerplate, keeping real chapters", () => {
    const units = [
      unit("关于我们", "本书由某出版社制作。"),
      unit("世说新语·德行", "陈仲举言为士则。"),
      unit("制作说明", "排版与校对说明。")
    ];

    const result = dropPublisherBoilerplateFilter.apply(units);

    expect(result.map((value) => value.title)).toEqual(["世说新语·德行"]);
  });

  it("drops a unit whose body text carries a marker even when the title looks innocuous", () => {
    const units = [
      unit("版权", "本电子书为公版书，仅供学习。", "更多请访问 www.7sbook.com"),
      unit("本纪", "黄帝者，少典之子。")
    ];

    const result = dropPublisherBoilerplateFilter.apply(units);

    expect(result.map((value) => value.title)).toEqual(["本纪"]);
  });

  it("matches the publisher domain case-insensitively", () => {
    const units = [unit("About", "Made by 7SBOOK team."), unit("Chapter", "Real content.")];

    expect(dropPublisherBoilerplateFilter.apply(units).map((value) => value.title)).toEqual([
      "Chapter"
    ]);
  });

  it("keeps a unit with no title and no boilerplate marker", () => {
    const units = [unit(undefined, "纯正文，没有任何样板。")];
    expect(dropPublisherBoilerplateFilter.apply(units)).toEqual(units);
  });

  it("is registered as the first default filter and enabled", () => {
    expect(defaultContentFilters[0]).toBe(dropPublisherBoilerplateFilter);
    expect(dropPublisherBoilerplateFilter.enabled).toBe(true);
  });
});
