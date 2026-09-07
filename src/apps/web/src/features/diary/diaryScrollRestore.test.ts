import { describe, expect, it } from "vitest";

import { afterDiaryScrollApplied, afterDiaryScrolled } from "./diaryScrollRestore.js";

describe("diaryScrollRestore (#918)", () => {
  it("keeps restoring while the container clamps the assignment short of the offset", () => {
    // The container is still one viewport tall, so the browser stored 0 instead of the 320 assigned.
    expect(afterDiaryScrollApplied(320, 0)).toEqual({ accountedTop: 0, restoring: true });

    // Growth that is still one pixel short keeps the restore open rather than settling for "close".
    expect(afterDiaryScrollApplied(320, 319)).toEqual({ accountedTop: 319, restoring: true });
  });

  it("finishes as soon as the read-back actually reaches the offset", () => {
    expect(afterDiaryScrollApplied(320, 320)).toEqual({ accountedTop: 320, restoring: false });
  });

  it("finishes a remembered top, which every container can hold", () => {
    expect(afterDiaryScrollApplied(0, 0)).toEqual({ accountedTop: 0, restoring: false });
  });

  it("ignores a scroll event that reports the offset the page itself just wrote", () => {
    const clamped = afterDiaryScrollApplied(320, 0);

    // Assigning `scrollTop` fires a scroll event too. Remembering that clamped 0 would overwrite the
    // learner's real place with the position the restore is trying to leave.
    expect(afterDiaryScrolled(clamped, 0)).toEqual({ remember: null, restore: clamped });
  });

  it("hands the restore to the learner as soon as they scroll somewhere else", () => {
    expect(afterDiaryScrolled(afterDiaryScrollApplied(320, 0), 90)).toEqual({
      remember: 90,
      restore: { accountedTop: 90, restoring: false }
    });
  });

  it("keeps recording the learner's scrolling once the restore is over", () => {
    expect(afterDiaryScrolled(afterDiaryScrollApplied(320, 320), 480)).toEqual({
      remember: 480,
      restore: { accountedTop: 480, restoring: false }
    });
  });
});
