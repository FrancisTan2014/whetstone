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

  it("resolves a `.`/`./` same-document ref to the base file, not its directory (#550)", () => {
    // A ref that names no file of its own but points at the current document collapses to the base
    // file's directory under naive joining (`OEBPS`); it must resolve to the base FILE so a same-file
    // cross-reference keys to its own `(source_file, anchor)` and is not dead-but-clickable.
    expect(resolveRelativeHref("OEBPS/ch01.html", ".")).toBe("OEBPS/ch01.html");
    expect(resolveRelativeHref("OEBPS/ch01.html", "./")).toBe("OEBPS/ch01.html");
    expect(resolveRelativeHref("OEBPS/ch01.html", "./#sec")).toBe("OEBPS/ch01.html");
    expect(resolveRelativeHref("text/ch01.xhtml", "./#fn3")).toBe("text/ch01.xhtml");
  });

  it("resolves a manifest-root directory ref to the base file, not the directory (#550)", () => {
    // @lingo-reader can rewrite a same-document reference to the manifest-root directory
    // (`epub:OEBPS` -> `/OEBPS`), which resolves to the base's ancestor directory `OEBPS`; it must
    // resolve to the base file instead so the reference matches the index key.
    expect(resolveRelativeHref("OEBPS/ch01.html", "/OEBPS")).toBe("OEBPS/ch01.html");
    expect(resolveRelativeHref("OEBPS/ch01.html", "/OEBPS/")).toBe("OEBPS/ch01.html");
  });

  it("still resolves a real cross-file `epub:`-stripped ref to that file, not the base (#543)", () => {
    // The #550 same-document guard must not swallow a genuine sibling/cross-file reference: a
    // root-absolute ref that names a real file resolves to that file.
    expect(resolveRelativeHref("OEBPS/ch09.html", "/OEBPS/ch10.html")).toBe("OEBPS/ch10.html");
    expect(resolveRelativeHref("OEBPS/ch01.html", "notes.xhtml")).toBe("OEBPS/notes.xhtml");
  });

  it("returns the (null) base for a null base and null ref", () => {
    expect(resolveRelativeHref(null, null)).toBeNull();
  });
});
