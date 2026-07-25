import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  parseRelatedMaterialRelationsRequest,
  parseRelatedMaterialRelationsResponse,
  parseRelatedMaterialSensesRequest,
  parseRelatedMaterialSensesResponse
} from "./relatedMaterialContracts.js";

const answerDoc = createTextDocument("bear");

const sense = {
  offset: "02131653",
  partOfSpeech: "verb" as const,
  definition: "give birth",
  examples: ["she bore twins"],
  lemmas: ["bear"]
};

const note = { noteId: "note-1", word: "born", context: "she was born in May" };

describe("relatedMaterial senses contracts", () => {
  it("parses a valid senses request and rejects extra keys or a bad document", () => {
    expect(parseRelatedMaterialSensesRequest({ answerDoc }).answerDoc).toEqual(answerDoc);
    expect(() => parseRelatedMaterialSensesRequest({ answerDoc, extra: 1 })).toThrow();
    expect(() => parseRelatedMaterialSensesRequest({ answerDoc: { type: "nope" } })).toThrow();
  });

  it("parses every senses outcome and echoes the found senses", () => {
    const found = parseRelatedMaterialSensesResponse({
      status: "found",
      surface: "bear",
      senses: [sense]
    });
    expect(found).toEqual({ status: "found", surface: "bear", senses: [sense] });
    expect(parseRelatedMaterialSensesResponse({ status: "not_found" }).status).toBe("not_found");
    expect(parseRelatedMaterialSensesResponse({ status: "unsupported" }).status).toBe("unsupported");
    expect(parseRelatedMaterialSensesResponse({ status: "unavailable" }).status).toBe("unavailable");
  });

  it("rejects an unknown senses status or a malformed sense", () => {
    expect(() => parseRelatedMaterialSensesResponse({ status: "maybe" })).toThrow();
    expect(() =>
      parseRelatedMaterialSensesResponse({
        status: "found",
        surface: "bear",
        senses: [{ ...sense, partOfSpeech: "pronoun" }]
      })
    ).toThrow();
  });
});

describe("relatedMaterial relations contracts", () => {
  it("parses a valid relations request and rejects a missing sense", () => {
    const request = parseRelatedMaterialRelationsRequest({
      answerDoc,
      sense: { offset: sense.offset, partOfSpeech: sense.partOfSpeech }
    });
    expect(request.sense.offset).toBe(sense.offset);
    expect(() => parseRelatedMaterialRelationsRequest({ answerDoc })).toThrow();
  });

  it("parses a found relations response with typed groups and notes", () => {
    const found = parseRelatedMaterialRelationsResponse({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [{ relation: "inflection", direction: "lateral", notes: [note] }]
    });
    expect(found).toEqual({
      status: "found",
      surface: "bear",
      selectedLemma: "bear",
      partOfSpeech: "verb",
      groups: [{ relation: "inflection", direction: "lateral", notes: [note] }]
    });
    expect(parseRelatedMaterialRelationsResponse({ status: "not_found" }).status).toBe("not_found");
    expect(parseRelatedMaterialRelationsResponse({ status: "unsupported" }).status).toBe(
      "unsupported"
    );
    expect(parseRelatedMaterialRelationsResponse({ status: "unavailable" }).status).toBe(
      "unavailable"
    );
  });

  it("rejects an unknown relation type, direction, or a note with extra keys", () => {
    expect(() =>
      parseRelatedMaterialRelationsResponse({
        status: "found",
        surface: "bear",
        selectedLemma: "bear",
        partOfSpeech: "verb",
        groups: [{ relation: "rhyme", direction: "lateral", notes: [note] }]
      })
    ).toThrow();
    expect(() =>
      parseRelatedMaterialRelationsResponse({
        status: "found",
        surface: "bear",
        selectedLemma: "bear",
        partOfSpeech: "verb",
        groups: [{ relation: "synonym", direction: "sideways", notes: [note] }]
      })
    ).toThrow();
    expect(() =>
      parseRelatedMaterialRelationsResponse({
        status: "found",
        surface: "bear",
        selectedLemma: "bear",
        partOfSpeech: "verb",
        groups: [
          { relation: "synonym", direction: "lateral", notes: [{ ...note, extra: true }] }
        ]
      })
    ).toThrow();
  });
});
