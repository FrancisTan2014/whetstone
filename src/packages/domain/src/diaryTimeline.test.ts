import { describe, expect, it } from "vitest";

import { isDayKey } from "./diaryTimeline.js";

describe("isDayKey", () => {
  it("accepts a well-formed day key and rejects malformed ones", () => {
    expect(isDayKey("2026-06-30")).toBe(true);
    expect(isDayKey("2026-6-30")).toBe(false);
    expect(isDayKey("2026-06-30T00:00")).toBe(false);
    expect(isDayKey("not-a-date")).toBe(false);
  });
});
