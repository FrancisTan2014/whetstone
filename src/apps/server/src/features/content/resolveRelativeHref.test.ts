import { describe, expect, it } from "vitest";

import { resolveRelativeHref } from "./resolveRelativeHref.js";

describe("resolveRelativeHref", () => {
  it("returns the base file for a null refFile (a same-file reference)", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", null)).toBe("text/ch01.xhtml");
  });

  it("returns the base file when the ref has only a fragment/query (empty path)", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", "#fn3")).toBe("text/ch01.xhtml");
    expect(resolveRelativeHref("text/ch01.xhtml", "?q=1")).toBe("text/ch01.xhtml");
  });

  it("resolves a sibling file against the base file's directory", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", "notes.xhtml")).toBe("text/notes.xhtml");
  });

  it("resolves a `./` current-directory segment", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", "./notes.xhtml")).toBe("text/notes.xhtml");
  });

  it("resolves `../` parent-directory segments", () => {
    expect(resolveRelativeHref("text/sub/ch01.xhtml", "../notes.xhtml")).toBe("text/notes.xhtml");
    expect(resolveRelativeHref("text/ch01.xhtml", "../notes.xhtml")).toBe("notes.xhtml");
  });

  it("strips a trailing query and fragment from the ref path", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", "../notes.xhtml#fn12")).toBe("notes.xhtml");
    expect(resolveRelativeHref("text/ch01.xhtml", "notes.xhtml?v=2#fn1")).toBe("text/notes.xhtml");
  });

  it("resolves an absolute ref from the root, ignoring the base directory", () => {
    expect(resolveRelativeHref("text/ch01.xhtml", "/shared/notes.xhtml")).toBe(
      "shared/notes.xhtml"
    );
  });

  it("resolves a relative ref against a null base as if from the root", () => {
    expect(resolveRelativeHref(null, "notes.xhtml")).toBe("notes.xhtml");
  });

  it("returns the (null) base for a null base and null ref", () => {
    expect(resolveRelativeHref(null, null)).toBeNull();
  });
});
