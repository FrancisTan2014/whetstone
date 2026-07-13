import { describe, expect, it } from "vitest";

import {
  assertContainedRelativePath,
  assertSafeRestoreLayout,
  assertSafeRootName
} from "./restoreSafety.js";

describe("assertSafeRootName", () => {
  it("accepts the known archive root names", () => {
    expect(() => assertSafeRootName("sources")).not.toThrow();
    expect(() => assertSafeRootName("images")).not.toThrow();
  });

  it.each(["database", "..", "../escape", "evil", "", "SOURCES"])(
    "rejects the unexpected root name %j",
    (name) => {
      expect(() => assertSafeRootName(name)).toThrow(/unexpected data root/);
    }
  );
});

describe("assertContainedRelativePath", () => {
  it.each(["a.txt", "sub/dir/b.png", "a/b/c/d.bin", "with space.txt", "unicode-名字.txt"])(
    "accepts the contained path %j",
    (relativePath) => {
      expect(() => assertContainedRelativePath("sources", relativePath)).not.toThrow();
    }
  );

  it("rejects an empty path", () => {
    expect(() => assertContainedRelativePath("sources", "")).toThrow(/is empty/);
  });

  it("rejects a null byte", () => {
    expect(() => assertContainedRelativePath("sources", "a\u0000.txt")).toThrow(/null byte/);
  });

  it.each(["..\\etc", "sub\\..\\..\\x", "a\\b"])(
    "rejects the backslash path %j",
    (relativePath) => {
      expect(() => assertContainedRelativePath("sources", relativePath)).toThrow(
        /backslash separator/
      );
    }
  );

  it.each(["C:\\Windows\\system32", "c:relative", "D:/data/x"])(
    "rejects the drive-rooted path %j",
    (relativePath) => {
      expect(() => assertContainedRelativePath("sources", relativePath)).toThrow(
        /drive-rooted Windows path/
      );
    }
  );

  it.each(["/etc/passwd", "/", "//server/share"])(
    "rejects the absolute path %j",
    (relativePath) => {
      expect(() => assertContainedRelativePath("sources", relativePath)).toThrow(
        /escapes its data root/
      );
    }
  );

  it.each(["../secret", "../../etc/passwd", "a/../../b", "sub/../../outside"])(
    "rejects the traversing path %j",
    (relativePath) => {
      expect(() => assertContainedRelativePath("sources", relativePath)).toThrow(
        /escapes its data root/
      );
    }
  );

  it("allows an in-root traversal that stays contained", () => {
    // a/../b normalizes to b, still inside the root.
    expect(() => assertContainedRelativePath("sources", "a/../b.txt")).not.toThrow();
  });
});

describe("assertSafeRestoreLayout", () => {
  it("accepts a manifest whose roots and files are all contained", () => {
    expect(() =>
      assertSafeRestoreLayout({
        roots: [
          {
            name: "sources",
            configuredPath: "/d/sources",
            present: true,
            fileCount: 1,
            totalBytes: 1,
            files: [{ path: "files/sources/a.txt", bytes: 1, sha256: "x", relativePath: "a.txt" }]
          }
        ]
      })
    ).not.toThrow();
  });

  it("rejects a manifest declaring an unexpected root name", () => {
    expect(() =>
      assertSafeRestoreLayout({
        roots: [
          {
            name: "..",
            configuredPath: "/d/x",
            present: true,
            fileCount: 0,
            totalBytes: 0,
            files: []
          }
        ]
      })
    ).toThrow(/unexpected data root/);
  });

  it("rejects a manifest with a traversing file path", () => {
    expect(() =>
      assertSafeRestoreLayout({
        roots: [
          {
            name: "images",
            configuredPath: "/d/images",
            present: true,
            fileCount: 1,
            totalBytes: 1,
            files: [
              {
                path: "files/images/evil",
                bytes: 1,
                sha256: "x",
                relativePath: "../../evil.png"
              }
            ]
          }
        ]
      })
    ).toThrow(/escapes its data root/);
  });
});
