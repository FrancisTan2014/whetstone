// The rules for putting the learner back where they left the Diary timeline (#648, #918). Pure — no DOM,
// no React — because the decisions that matter are invisible in jsdom: a browser **clamps** `scrollTop`
// into the container's current scrollable range, both when the page assigns it and, silently, when the
// content shrinks underneath it. Whether the offset actually landed, and whether a `scroll` reading is a
// place the learner chose or one the browser forced, are decided here; `useDiaryScrollRestore` performs
// the reads and writes.

export type DiaryScrollRestore = Readonly<{
  // The container offset the page has already accounted for: the value it last wrote itself, or the
  // last position it recorded. A scroll event reporting exactly this moved nobody.
  accountedTop: number;
  // Whether the remembered offset still has to be re-applied as late content grows the container.
  restoring: boolean;
}>;

// Fold the container's `scrollTop`, read back immediately after the page assigned `target` to it. The
// browser clamps that assignment, so a container that has not finished growing reports a smaller offset
// with no error: the place is restored only when the read-back reached the target, and anything short of
// it — including an offset the container can *almost* hold — leaves the restore open for the next growth.
export function afterDiaryScrollApplied(target: number, scrollTop: number): DiaryScrollRestore {
  return { accountedTop: scrollTop, restoring: scrollTop < target };
}

// Fold a scroll event on the container. `remember` is the offset to record for the session, or null when
// the reading is not a place the learner chose. Two readings are not:
//
//   - the echo of the page's own write, which fires `scroll` like any other move; and
//   - a position the container can no longer hold. When content shrinks — the async capture editor
//     (#678) replacing a placeholder, the timeline re-laying out, or Diary being taken apart on the way
//     out — the browser drags `scrollTop` down to the new maximum and fires `scroll` for a move nobody
//     made. Recording that would replace the remembered offset with wherever the collapse happened to
//     land, losing the learner's place for this return *and* every later one.
//
// Being pinned at the maximum while that maximum sits below the accounted position is what identifies a
// forced reading: the learner cannot choose a position the container is currently too short to express.
// Note what this deliberately does *not* do: it never concludes "the learner took over" from a change in
// `scrollTop`, because a clamp and a gesture are indistinguishable as deltas. That signal comes from real
// input events instead, which a relayout cannot forge.
export function afterDiaryScrolled(
  restore: DiaryScrollRestore,
  scrollTop: number,
  maxScrollTop: number
): Readonly<{ remember: number | null; restore: DiaryScrollRestore }> {
  if (scrollTop === restore.accountedTop) {
    return { remember: null, restore };
  }

  if (scrollTop === maxScrollTop && maxScrollTop < restore.accountedTop) {
    return { remember: null, restore };
  }

  return { remember: scrollTop, restore: { ...restore, accountedTop: scrollTop } };
}
