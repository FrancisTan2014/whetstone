import { useEffect, type RefObject } from "react";

import {
  afterDiaryScrollApplied,
  afterDiaryScrolled,
  type DiaryScrollRestore
} from "./diaryScrollRestore.js";
import { diaryScrollTop, rememberDiaryScrollTop } from "./diarySessionStore.js";

// How long the restore keeps re-applying the remembered offset while the timeline is still growing.
// The Diary's content arrives late by design — the capture editor mounts asynchronously
// (`RichContentEditor` uses `immediatelyRender: false`, #678) and the restored timeline lays out after
// it — and on a slow phone that settling is comfortably inside a few seconds. The window only bounds
// *giving up*: success ends it immediately, so this is never a delay the learner waits through.
const RESTORE_WINDOW_MS = 3000;

// Preserve the learner's scroll position across leaving and returning to Diary in the same app session
// (#648). `contentRef` is the Diary content root; the scroll container is its nearest ancestor `<main>`
// (the AppShell scroller — Diary itself does not scroll). While `active`, the hook restores the
// remembered offset and keeps it current from the learner's own scrolling.
//
// Restoring is not a single assignment (#918): the content root grows after this runs, and until it is
// tall enough the browser clamps the assignment down — permanently, if nothing re-applies it. So the
// offset is re-applied on every content-size change until it lands, the learner scrolls, or the window
// closes; every observer, timer, and listener is torn down at the first of those.
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
    let restoreWindow: ReturnType<typeof setTimeout> | null = null;

    const stopReapplying = (): void => {
      growth?.disconnect();
      growth = null;
      if (restoreWindow !== null) {
        clearTimeout(restoreWindow);
        restoreWindow = null;
      }
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

    const handleScroll = (): void => {
      const scrolled = afterDiaryScrolled(restore, container.scrollTop);
      restore = scrolled.restore;
      if (!restore.restoring) {
        stopReapplying();
      }
      if (scrolled.remember !== null) {
        rememberDiaryScrollTop(scrolled.remember);
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });

    if (restore.restoring) {
      growth = new ResizeObserver(reapply);
      growth.observe(content);
      restoreWindow = setTimeout(stopReapplying, RESTORE_WINDOW_MS);
    }

    return () => {
      stopReapplying();
      container.style.overflowAnchor = previousOverflowAnchor;
      container.removeEventListener("scroll", handleScroll);
    };
  }, [active, contentRef]);
}
