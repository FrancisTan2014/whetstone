import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createTextDocument,
  BlankNoteMaterialError,
  projectNoteMaterial
} from "@whetstone/document";
import { DocumentValidationError, type DocumentNodeJSON } from "@whetstone/document";

import { fingerprintFromProjection, fingerprintNoteMaterial } from "./noteMaterialFingerprint.js";

// #711: the server-side SHA-256 over the document package's canonical projection. The projection itself
// is proven in the document package; here we prove the fingerprint is exactly sha256(projection) in hex,
// deterministic, composes the projection (so identical material collides and distinct material does not),
// and propagates the projection's fail-loud errors before any hash is derived.

const doc = (content: DocumentNodeJSON[]): DocumentNodeJSON => ({ content, type: "doc" });
const paragraph = (text: string): DocumentNodeJSON => ({
  content: [{ text, type: "text" }],
  type: "paragraph"
});

describe("fingerprintFromProjection", () => {
  it("is the lowercase-hex SHA-256 of the input string", () => {
    const projection = "some-canonical-projection";
    const expected = createHash("sha256").update(projection, "utf8").digest("hex");
    expect(fingerprintFromProjection(projection)).toBe(expected);
    expect(fingerprintFromProjection(projection)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("is deterministic and distinguishes different inputs", () => {
    expect(fingerprintFromProjection("a")).toBe(fingerprintFromProjection("a"));
    expect(fingerprintFromProjection("a")).not.toBe(fingerprintFromProjection("b"));
  });
});

describe("fingerprintNoteMaterial", () => {
  it("hashes exactly the note's canonical projection", () => {
    const body = createTextDocument("Deterministic material");
    expect(fingerprintNoteMaterial(body)).toBe(
      fingerprintFromProjection(projectNoteMaterial(body))
    );
  });

  it("collides for semantically identical bodies and differs for distinct ones", () => {
    // Adjacent equal-mark runs and a bold-only difference project identically, so they fingerprint alike.
    const plain = doc([paragraph("hello world")]);
    const split: DocumentNodeJSON = doc([
      {
        content: [
          { text: "hello ", type: "text" },
          { text: "world", type: "text" }
        ],
        type: "paragraph"
      }
    ]);
    const bolded: DocumentNodeJSON = doc([
      {
        content: [
          { marks: [{ type: "bold" }], text: "hello ", type: "text" },
          { text: "world", type: "text" }
        ],
        type: "paragraph"
      }
    ]);
    expect(fingerprintNoteMaterial(plain)).toBe(fingerprintNoteMaterial(split));
    expect(fingerprintNoteMaterial(plain)).toBe(fingerprintNoteMaterial(bolded));
    expect(fingerprintNoteMaterial(plain)).not.toBe(
      fingerprintNoteMaterial(doc([paragraph("hello  World")]))
    );
  });

  it("throws the projection's blank error before hashing an empty body", () => {
    expect(() => fingerprintNoteMaterial(doc([{ type: "paragraph" }]))).toThrow(
      BlankNoteMaterialError
    );
  });

  it("throws a validation error for an invalid document or unsafe link before hashing", () => {
    expect(() => fingerprintNoteMaterial({ content: [{ type: "bogus" }], type: "doc" })).toThrow(
      DocumentValidationError
    );
    const unsafe = doc([
      {
        content: [
          {
            marks: [{ attrs: { href: "javascript:alert(1)" }, type: "link" }],
            text: "x",
            type: "text"
          }
        ],
        type: "paragraph"
      }
    ]);
    expect(() => fingerprintNoteMaterial(unsafe)).toThrow(DocumentValidationError);
  });
});
