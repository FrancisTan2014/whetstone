import { describe, expect, it } from "vitest";

import { afterDiaryScrollApplied, afterDiaryScrolled } from "./diaryScrollRestore.js";

// A tall container, so a reading is only "forced" when the content has actually shrunk under it.
const ROOMY = 2000;

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
    expect(afterDiaryScrolled(clamped, 0, ROOMY)).toEqual({ remember: null, restore: clamped });
  });

  it("ignores a position the container has become too short to hold", () => {
    const restored = afterDiaryScrollApplied(320, 320);

    // The content shrank under the learner — the async editor swapping in, or Diary being taken apart
    // on the way out — so the browser dragged the position down to the new maximum and fired `scroll`
    // for it. Nobody moved, and the remembered offset must outlive the collapse.
    expect(afterDiaryScrolled(restored, 0, 0)).toEqual({ remember: null, restore: restored });
    expect(afterDiaryScrolled(restored, 120, 120)).toEqual({ remember: null, restore: restored });
  });

  it("still records the learner reaching the bottom of a container that did not shrink", () => {
    // Also pinned at the maximum, but the maximum is *beyond* the accounted position, so this is the
    // learner scrolling down rather than the content collapsing underneath them.
    expect(afterDiaryScrolled(afterDiaryScrollApplied(320, 320), 900, 900)).toEqual({
      remember: 900,
      restore: { accountedTop: 900, restoring: false }
    });
  });

  it("records where the learner scrolled without calling the restore off", () => {
    // A moved `scrollTop` is not evidence of intent — a clamp moves it too — so the restore is left
    // running here. Only real input (handled by the hook) hands the container over.
    expect(afterDiaryScrolled(afterDiaryScrollApplied(320, 0), 90, ROOMY)).toEqual({
      remember: 90,
      restore: { accountedTop: 90, restoring: true }
    });
  });

  it("keeps recording the learner's scrolling once the restore is over", () => {
    expect(afterDiaryScrolled(afterDiaryScrollApplied(320, 320), 480, ROOMY)).toEqual({
      remember: 480,
      restore: { accountedTop: 480, restoring: false }
    });
  });
});
