import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { isZipArchive } from "./zipArchive.js";

function validZip(): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "hello.txt": strToU8("hello world")
  });
}

describe("isZipArchive", () => {
  it("accepts a structurally complete ZIP archive", () => {
    expect(isZipArchive(validZip())).toBe(true);
  });

  it("rejects an empty ZIP archive that has no leading local file header", () => {
    // An empty archive is just an EOCD record (it begins with `PK\x05\x06`), so it is not the
    // local-file-header start of a real EPUB; the EPUB library rejects it cleanly anyway.
    expect(isZipArchive(zipSync({}))).toBe(false);
  });

  it("rejects bytes that do not begin with a ZIP signature", () => {
    // A PNG header is a common non-EPUB upload; it must not reach the EPUB library.
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
    ]);

    expect(isZipArchive(png)).toBe(false);
  });

  it("rejects bytes too short to hold an end-of-central-directory record", () => {
    expect(isZipArchive(Uint8Array.from([0x50, 0x4b, 0x03, 0x04]))).toBe(false);
  });

  it("rejects a ZIP that starts validly but has no end-of-central-directory record", () => {
    const zip = validZip();
    // Drop the trailing end-of-central-directory record (22 bytes, no archive comment) so the
    // archive is truncated/corrupt despite its valid leading local-file-header signature.
    const truncated = zip.slice(0, zip.length - 22);

    expect(matchesLocalHeader(truncated)).toBe(true);
    expect(isZipArchive(truncated)).toBe(false);
  });
});

function matchesLocalHeader(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
