import { describe, expect, it } from "vitest";

import type { WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

function work(authorId: string, authorName: string, entryId: string): WorkListItemDto {
  return {
    author: { id: toAuthorId(authorId), name: authorName },
    work: {
      authorId: toAuthorId(authorId),
      entryId: toEntryId(entryId),
      language: "en",
      title: entryId,
      workType: "book"
    }
  };
}

import { groupWorksByAuthor } from "./groupWorksByAuthor.js";

describe("groupWorksByAuthor", () => {
  it("groups works under their author preserving first-seen and within-author order", () => {
    const groups = groupWorksByAuthor([
      work("a1", "Orwell", "w1"),
      work("a2", "Dickens", "w2"),
      work("a1", "Orwell", "w3")
    ]);

    expect(groups.map((group) => group.author.name)).toEqual(["Orwell", "Dickens"]);
    expect(groups[0]?.works.map((item) => item.work.entryId)).toEqual(["w1", "w3"]);
    expect(groups[1]?.works).toHaveLength(1);
  });

  it("returns an empty list for no works", () => {
    expect(groupWorksByAuthor([])).toEqual([]);
  });
});
