// The rules for putting the learner back where they left the Diary timeline (#648, #918). Pure — no DOM,
// no React — because the decision that matters is invisible in jsdom: a browser **clamps** a `scrollTop`
// assignment into the container's current scrollable range, so restoring 320 into a container that is
// still one viewport tall silently stores 0. Whether the offset actually landed, whether a scroll event
// is the learner moving or the echo of the page's own write, and whether the remembered offset may be
// overwritten are decided here; `useDiaryScrollRestore` performs the reads and writes.

export type DiaryScrollRestore = Readonly<{
  // The container offset the page has already accounted for: the value it last wrote itself, or the
  // learner's last recorded position. A scroll event reporting exactly this moved nobody.
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
// the event carries no movement by the learner — a programmatic assignment fires `scroll` too, and
// recording that clamped intermediate would replace the remembered offset with the very position the
// restore is trying to leave, losing the learner's place for every later return as well. A move the
// learner did make ends the restore: they win over any further reapply and are never yanked back.
export function afterDiaryScrolled(
  restore: DiaryScrollRestore,
  scrollTop: number
): Readonly<{ remember: number | null; restore: DiaryScrollRestore }> {
  if (scrollTop === restore.accountedTop) {
    return { remember: null, restore };
  }

  return { remember: scrollTop, restore: { accountedTop: scrollTop, restoring: false } };
}
