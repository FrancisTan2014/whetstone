import { useEffect, type RefObject } from "react";

import {
  afterDiaryScrollApplied,
  afterDiaryScrolled,
  type DiaryScrollRestore
} from "./diaryScrollRestore.js";
import { diaryScrollTop, rememberDiaryScrollTop } from "./diarySessionStore.js";

// The input a learner uses to take the scroll container over. These are *intent*, not consequence: a
// relayout can move `scrollTop`, but it cannot produce a wheel tick, a finger, or a key press. Keying
// the hand-off off intent is what makes "never yank the learner back" hold without also mistaking the
// browser's own clamping for a gesture (#918).
const TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

// Preserve the learner's scroll position across leaving and returning to Diary in the same app session
// (#648). `contentRef` is the Diary content root; the scroll container is its nearest ancestor `<main>`
// (the AppShell scroller — Diary itself does not scroll). While `active`, the hook restores the
// remembered offset and keeps it current from the learner's own scrolling.
//
// Restoring is not a single assignment (#918): the content root is still growing when this first runs,
// and until it is tall enough the browser clamps the assignment down — permanently, if nothing re-applies
// it. So the offset is re-applied on every content-size change until it lands. Nothing here races a
// clock: the restore ends on an observable event — the offset landing, the learner taking over, or Diary
// unmounting — so a slow, loaded machine simply arrives later, never wrong.
export function useDiaryScrollRestore(
  contentRef: RefObject<HTMLElement | null>,
  active: boolean
): void {
  useEffect(() => {
    if (!active) {
      return;
    }
    const content = contentRef.current;
    if (content === null) {
      return;
    }
    const container = content.closest("main");
    if (container === null) {
      return;
    }

    // The capture editor grows from a short placeholder to its full height just above the restored
    // position. The browser's scroll anchoring would convert that growth-above into a scroll shift,
    // landing the learner on different entries than they left (the remembered offset would read too
    // large). Opt this container out of anchoring while Diary owns it; the prior value is restored on
    // unmount. Anchoring keeps an *established* position steady; it cannot recover a clamped one, which
    // is what the reapply below is for.
    const previousOverflowAnchor = container.style.overflowAnchor;
    container.style.overflowAnchor = "none";

    const target = diaryScrollTop();
    let growth: ResizeObserver | null = null;

    // Ends the restore. Also the learner's take-over handler: once they act, nothing re-applies, so they
    // are never dragged back to a place they have just left.
    const stopReapplying = (): void => {
      growth?.disconnect();
      growth = null;
    };

    // Assigning `scrollTop` is the whole restore; the read-back right after is what says whether the
    // browser kept it or clamped it into a container that has not grown yet.
    const apply = (): DiaryScrollRestore => {
      container.scrollTop = target;
      return afterDiaryScrollApplied(target, container.scrollTop);
    };

    let restore = apply();

    const reapply = (): void => {
      restore = apply();
      if (!restore.restoring) {
        stopReapplying();
      }
    };

    // Recording, unlike stopping, still keys off `scroll` — a position is only knowable from where the
    // container actually is. What it must never do is record a reading the browser forced, so the
    // container's current maximum goes in with it.
    const handleScroll = (): void => {
      const scrolled = afterDiaryScrolled(
        restore,
        container.scrollTop,
        container.scrollHeight - container.clientHeight
      );
      restore = scrolled.restore;
      if (scrolled.remember !== null) {
        rememberDiaryScrollTop(scrolled.remember);
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    for (const intent of TAKEOVER_EVENTS) {
      container.addEventListener(intent, stopReapplying, { passive: true });
    }

    if (restore.restoring) {
      growth = new ResizeObserver(reapply);
      growth.observe(content);
    }

    return () => {
      stopReapplying();
      container.style.overflowAnchor = previousOverflowAnchor;
      container.removeEventListener("scroll", handleScroll);
      for (const intent of TAKEOVER_EVENTS) {
        container.removeEventListener(intent, stopReapplying);
      }
    };
  }, [active, contentRef]);
}
