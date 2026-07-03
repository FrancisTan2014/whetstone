import { describe, expect, it } from "vitest";

import { isEpubFile, isMarkdownFile, isPdfFile, stripFileExtension } from "./fileType";

function fileNamed(name: string, type = ""): File {
  return new File([new Uint8Array([1])], name, { type });
}

describe("isEpubFile", () => {
  it("matches on the EPUB MIME type regardless of extension", () => {
    expect(isEpubFile(fileNamed("book", "application/epub+zip"))).toBe(true);
  });

  it("matches on a .epub extension when the browser omits the type", () => {
    expect(isEpubFile(fileNamed("BOOK.EPUB"))).toBe(true);
  });

  it("rejects a non-EPUB file", () => {
    expect(isEpubFile(fileNamed("notes.md", "text/markdown"))).toBe(false);
  });
});

describe("isPdfFile", () => {
  it("matches on the PDF MIME type regardless of extension", () => {
    expect(isPdfFile(fileNamed("scan", "application/pdf"))).toBe(true);
  });

  it("matches on a .pdf extension when the browser omits the type", () => {
    expect(isPdfFile(fileNamed("Report.PDF"))).toBe(true);
  });

  it("rejects a non-PDF file", () => {
    expect(isPdfFile(fileNamed("book.epub", "application/epub+zip"))).toBe(false);
  });
});

describe("isMarkdownFile", () => {
  it("matches on the Markdown MIME type regardless of extension", () => {
    expect(isMarkdownFile(fileNamed("notes", "text/markdown"))).toBe(true);
  });

  it("matches on a .md extension when the browser omits the type", () => {
    expect(isMarkdownFile(fileNamed("README.MD"))).toBe(true);
  });

  it("rejects a non-Markdown file", () => {
    expect(isMarkdownFile(fileNamed("scan.pdf", "application/pdf"))).toBe(false);
  });
});

describe("stripFileExtension", () => {
  it("removes the final extension", () => {
    expect(stripFileExtension("Politics and the English Language.pdf")).toBe(
      "Politics and the English Language"
    );
  });

  it("removes only the last extension", () => {
    expect(stripFileExtension("archive.tar.gz")).toBe("archive.tar");
  });

  it("leaves a name with no extension unchanged", () => {
    expect(stripFileExtension("README")).toBe("README");
  });

  it("does not treat a leading-dot dotfile as an extension", () => {
    expect(stripFileExtension(".gitignore")).toBe(".gitignore");
  });
});
