import { useEffect, useState } from "react";

import { loadPersistedTimeZone, resolveBrowserTimeZone } from "./preferencesApi";

// The learner's calendar-day zone for review-time labels (#676), resolved the same way the Diary timeline
// resolves its grouping zone (#606): start from the browser so the first render is sensible, then adopt the
// server-owned preference once it loads. Every review surface (Notes Review, note Review summaries and
// settings, Recite, Recitation Review, Today's completion copy) reads its next-review instant through this
// one zone, so a same-day short-term interval renders as the learner's local time rather than the runner's.
// A failed resolve keeps the browser-zone fallback rather than blocking — the label is presentational, not
// a gate. The cleanup flag drops a late resolve after unmount so React never warns about a set on an
// unmounted component.
export function useLearnerTimeZone(): string {
  const [timeZone, setTimeZone] = useState(() => resolveBrowserTimeZone());

  useEffect(() => {
    let active = true;
    loadPersistedTimeZone().then(
      (zone) => {
        if (active) {
          setTimeZone(zone);
        }
      },
      () => {
        // Keep the browser-zone fallback already in state; the label must still render.
      }
    );
    return () => {
      active = false;
    };
  }, []);

  return timeZone;
}
