import { describe, expect, it } from "vitest";

import { detectUploadKind, stripFileExtension } from "./fileType";

function fileNamed(name: string, type = ""): File {
  return new File([new Uint8Array([1])], name, { type });
}

describe("detectUploadKind", () => {
  it("classifies each recognized MIME type regardless of extension", () => {
    expect(detectUploadKind(fileNamed("book", "application/epub+zip"))).toBe("epub");
    expect(detectUploadKind(fileNamed("scan", "application/pdf"))).toBe("pdf");
    expect(detectUploadKind(fileNamed("notes", "text/markdown"))).toBe("markdown");
  });

  it("falls back to the extension when the browser omits the type", () => {
    expect(detectUploadKind(fileNamed("BOOK.EPUB"))).toBe("epub");
    expect(detectUploadKind(fileNamed("Report.PDF"))).toBe("pdf");
    expect(detectUploadKind(fileNamed("README.MD"))).toBe("markdown");
  });

  it("prefers the MIME type over a conflicting extension", () => {
    // A real PDF mislabelled with a .epub name must route by its content type, not the extension.
    expect(detectUploadKind(fileNamed("book.epub", "application/pdf"))).toBe("pdf");
    // ...and an actual EPUB named .pdf routes as EPUB.
    expect(detectUploadKind(fileNamed("report.pdf", "application/epub+zip"))).toBe("epub");
  });

  it("falls back to the extension when the reported MIME type is unrecognized", () => {
    expect(detectUploadKind(fileNamed("Report.pdf", "application/octet-stream"))).toBe("pdf");
  });

  it("returns undefined for an unsupported file", () => {
    expect(detectUploadKind(fileNamed("photo.png", "image/png"))).toBeUndefined();
    expect(detectUploadKind(fileNamed("notes.txt"))).toBeUndefined();
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
