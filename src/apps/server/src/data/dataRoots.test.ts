import { describe, expect, it } from "vitest";

import { readServerConfig } from "../config/serverConfig.js";
import {
  IMAGE_RESOURCES_ROOT,
  RESTORE_DATABASE_SUBDIR,
  SOURCE_FILES_ROOT,
  resolveDataRoots
} from "./dataRoots.js";

describe("resolveDataRoots", () => {
  it("maps the source and image config paths to named roots", () => {
    expect(
      resolveDataRoots({ sourceFilesDir: "/a/sources", imageResourcesDir: "/a/images" })
    ).toEqual([
      { name: SOURCE_FILES_ROOT, configuredPath: "/a/sources" },
      { name: IMAGE_RESOURCES_ROOT, configuredPath: "/a/images" }
    ]);
  });

  it("names the roots and database subdirectory stably", () => {
    expect([SOURCE_FILES_ROOT, IMAGE_RESOURCES_ROOT, RESTORE_DATABASE_SUBDIR]).toEqual([
      "sources",
      "images",
      "database"
    ]);
  });

  it("never captures the creation-review stage directory (#725 backup exclusion)", () => {
    // The stage holds transient upload bytes for an in-flight attempt; it must never enter a backup, so
    // it is deliberately not among the resolved data roots.
    const config = readServerConfig({});
    const roots = resolveDataRoots(config);
    expect(roots.map((root) => root.configuredPath)).not.toContain(config.workCreationStageDir);
  });
});
