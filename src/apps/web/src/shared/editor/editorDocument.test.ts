import {
  DocumentValidationError,
  type DocumentNodeJSON,
  isValidDocument
} from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  createEmptyDocument,
  editorDocumentsEqual,
  editorDocumentsEqualIgnoringIds,
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

  it("treats id and key-order differences as equal while detecting real content and mark changes", () => {
    // The server reassembles a stored document as { content, type } with attrs { anchorId, id };
    // the editor serializes as { type, content } and stamps a real id. Same content, so equal ignoring
    // ids/order — but strictly unequal.
    const serverStyle = {
      content: [{ attrs: { anchorId: null, id: null }, type: "paragraph" }],
      type: "doc"
    } as DocumentNodeJSON;
    const editorStyle: DocumentNodeJSON = {
      content: [{ attrs: { anchorId: null, id: "blk-gen" }, type: "paragraph" }],
      type: "doc"
    };
    expect(editorDocumentsEqualIgnoringIds(serverStyle, editorStyle)).toBe(true);
    expect(editorDocumentsEqual(serverStyle, editorStyle)).toBe(false);

    // Adding text is a genuine content change even when ids/order are ignored.
    const withText: DocumentNodeJSON = {
      content: [
        {
          attrs: { anchorId: null, id: null },
          content: [{ text: "Hi", type: "text" }],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    expect(editorDocumentsEqualIgnoringIds(serverStyle, withText)).toBe(false);

    // Marks canonicalize by type + attrs regardless of id/key order (a bold mark carries no attrs, a
    // link mark does), so the same formatting compares equal…
    const bold: DocumentNodeJSON = {
      content: [
        {
          attrs: { anchorId: null, id: "a" },
          content: [
            {
              marks: [{ type: "bold" }, { attrs: { href: "https://example.com" }, type: "link" }],
              text: "Hi",
              type: "text"
            }
          ],
          type: "paragraph"
        }
      ],
      type: "doc"
    };
    const boldReordered = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { id: "b", anchorId: null },
          content: [
            {
              type: "text",
              text: "Hi",
              marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }]
            }
          ]
        }
      ]
    } as DocumentNodeJSON;
    expect(editorDocumentsEqualIgnoringIds(bold, boldReordered)).toBe(true);

    // …while a changed mark attribute is a real change.
    const boldOtherHref = structuredClone(bold);
    (boldOtherHref.content![0]!.content![0]!.marks![1]!.attrs as Record<string, unknown>)["href"] =
      "https://other.example.com";
    expect(editorDocumentsEqualIgnoringIds(bold, boldOtherHref)).toBe(false);
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
