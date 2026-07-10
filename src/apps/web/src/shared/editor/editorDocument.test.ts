import { DocumentValidationError, isValidDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  createEmptyDocument,
  editorDocumentsEqual,
  normalizeEditorLinkHref,
  validateEditorDocument
} from "./editorDocument";

describe("editor document boundary", () => {
  it("creates a fresh valid empty document with an addressable paragraph", () => {
    const first = createEmptyDocument();
    const second = createEmptyDocument();

    expect(isValidDocument(first)).toBe(true);
    expect(first.content).toHaveLength(1);
    expect(first.content?.[0]?.type).toBe("paragraph");
    expect(first.content?.[0]?.attrs?.["id"]).toEqual(expect.any(String));
    expect(second).not.toBe(first);
    expect(second.content?.[0]?.attrs?.["id"]).not.toBe(first.content?.[0]?.attrs?.["id"]);
  });

  it("validates, clones, and fills missing stable ids without mutating the caller", () => {
    const input = {
      content: [{ content: [{ text: "Draft", type: "text" }], type: "paragraph" }],
      type: "doc"
    };
    const validated = validateEditorDocument(input);

    expect(validated).not.toBe(input);
    expect(validated.content?.[0]).not.toBe(input.content[0]);
    expect(validated.content?.[0]?.attrs?.["id"]).toEqual(expect.any(String));
    expect(input.content[0]).not.toHaveProperty("attrs");
  });

  it("rejects invalid external JSON instead of replacing it", () => {
    expect(() => validateEditorDocument({ content: [], type: "doc" })).toThrow(
      DocumentValidationError
    );
    expect(() => validateEditorDocument({ type: "not-a-node" })).toThrow(DocumentValidationError);
  });

  it("compares canonical editor documents by value", () => {
    const document = createEmptyDocument();
    const clone = structuredClone(document);
    const changed = structuredClone(document);
    changed.content?.push({ type: "paragraph" });

    expect(editorDocumentsEqual(document, clone)).toBe(true);
    expect(editorDocumentsEqual(document, changed)).toBe(false);
  });
});

describe("editor link input", () => {
  it("normalizes bare hosts and trims already-safe links", () => {
    expect(normalizeEditorLinkHref(" example.com/path ")).toBe("https://example.com/path");
    expect(normalizeEditorLinkHref(" https://example.com ")).toBe("https://example.com");
    expect(normalizeEditorLinkHref("mailto:reader@example.com")).toBe("mailto:reader@example.com");
    expect(normalizeEditorLinkHref("#section")).toBe("#section");
    expect(normalizeEditorLinkHref("/library/work")).toBe("/library/work");
  });

  it("rejects empty, protocol-relative, and unsafe scheme input", () => {
    expect(normalizeEditorLinkHref("   ")).toBeUndefined();
    expect(normalizeEditorLinkHref("//example.com")).toBeUndefined();
    expect(normalizeEditorLinkHref("javascript:alert(1)")).toBeUndefined();
  });
});
