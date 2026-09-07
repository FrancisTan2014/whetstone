// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearDiarySession, diaryScrollTop, rememberDiaryScrollTop } from "./diarySessionStore.js";
import { useDiaryScrollRestore } from "./useDiaryScrollRestore.js";

// A stand-in scroll container and the Diary content inside it. jsdom lays nothing out, so the geometry
// is defined explicitly the way `useReaderScroll.test.tsx` does — including the one browser behaviour
// this hook exists for: `scrollTop` is **clamped** into the container's current scrollable range, so a
// container that has not grown yet silently stores a smaller offset than the one assigned (#918).
type Scroller = Readonly<{
  container: HTMLElement;
  content: HTMLElement;
  grow: (scrollHeight: number) => void;
  shrinkTo: (scrollHeight: number) => void;
}>;

function makeScroller(clientHeight: number): Scroller {
  const container = document.createElement("main");
  const content = document.createElement("div");
  let scrollHeight = clientHeight;
  let scrollTop = 0;

  Object.defineProperty(container, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(container, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
    }
  });

  container.append(content);
  document.body.append(container);

  return {
    container,
    content,
    grow: (height: number) => {
      scrollHeight = height;
    },
    // Content getting *shorter* is not the mirror image of growth: the browser clamps the current
    // position down to the new maximum on its own and fires `scroll` for a move the learner never
    // made. That is the reading this hook must never mistake for a gesture (#918).
    shrinkTo: (height: number) => {
      scrollHeight = height;
      const max = Math.max(0, scrollHeight - clientHeight);
      if (scrollTop > max) {
        scrollTop = max;
        act(() => {
          container.dispatchEvent(new Event("scroll"));
        });
      }
    }
  };
}

// jsdom has no ResizeObserver (the shared setup installs an inert stub), so drive content growth
// explicitly. A disconnected observer stays silent, so a leaked observer cannot fake a pass.
type LiveResize = { connected: boolean; notify: () => void };

let resizes: LiveResize[];

class StubResizeObserver {
  private readonly live: LiveResize;

  constructor(callback: ResizeObserverCallback) {
    this.live = {
      connected: false,
      notify: () => {
        if (this.live.connected) {
          callback([], this as unknown as ResizeObserver);
        }
      }
    };
    resizes.push(this.live);
  }

  observe(): void {
    this.live.connected = true;
  }
  disconnect(): void {
    this.live.connected = false;
  }
  unobserve(): void {
    this.live.connected = false;
  }
}

function notifyResizes(): void {
  act(() => {
    for (const resize of resizes) {
      resize.notify();
    }
  });
}

function watching(): number {
  return resizes.filter((resize) => resize.connected).length;
}

function scrollTo(scroller: Scroller, scrollTop: number): void {
  scroller.container.scrollTop = scrollTop;
  act(() => {
    scroller.container.dispatchEvent(new Event("scroll"));
  });
}

function mount(
  scroller: Scroller,
  active = true
): ReturnType<typeof renderHook<void, { active: boolean }>> {
  const ref = { current: scroller.content as HTMLElement | null };
  return renderHook(({ active: on }: { active: boolean }) => useDiaryScrollRestore(ref, on), {
    initialProps: { active }
  });
}

beforeEach(() => {
  resizes = [];
  clearDiarySession();
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useDiaryScrollRestore (#648, #918)", () => {
  it("restores the remembered offset once the timeline grows tall enough to hold it", () => {
    rememberDiaryScrollTop(320);
    // The capture editor mounts asynchronously (#678), so the content is still one viewport tall.
    const scroller = makeScroller(400);

    const view = mount(scroller);
    expect(scroller.container.scrollTop).toBe(0); // the browser clamped 320 away
    expect(watching()).toBe(1);

    scroller.grow(2400);
    notifyResizes();

    expect(scroller.container.scrollTop).toBe(320);
    // Landing ends the restore: nothing is left observing or waiting to fire.
    expect(watching()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
  });

  it("keeps re-applying across several growth steps until the offset finally fits", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);

    const view = mount(scroller);

    scroller.grow(600); // still short: the best it can do is 200
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(200);
    expect(watching()).toBe(1);

    scroller.grow(900);
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(320);
    expect(watching()).toBe(0);

    view.unmount();
  });

  it("does not let a clamped reading replace the remembered offset", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);

    const view = mount(scroller);
    // A browser fires `scroll` for the page's own assignment too; recording that clamped 0 would lose
    // the learner's place for this return *and* every later one.
    act(() => {
      scroller.container.dispatchEvent(new Event("scroll"));
    });

    expect(diaryScrollTop()).toBe(320);

    scroller.grow(2400);
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(320);

    view.unmount();
  });

  it("survives the timeline shrinking mid-restore instead of reading the clamp as a gesture", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);

    const view = mount(scroller);
    scroller.grow(600); // still short: the restore gets as far as 200
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(200);

    // The timeline does not grow monotonically: the async capture editor (#678) swaps a placeholder
    // for a shorter real editor, so the content briefly gets *smaller*. The browser clamps the
    // position that was just restored and fires `scroll` for a move nobody made.
    scroller.shrinkTo(400);
    expect(scroller.container.scrollTop).toBe(0);

    // That clamp was never the learner, so the restore is still live when the timeline finally
    // reaches its full height — and the remembered offset survived to be restored to.
    scroller.grow(2400);
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(320);
    expect(diaryScrollTop()).toBe(320);

    view.unmount();
  });

  it("keeps the remembered offset when leaving Diary collapses the timeline under it", () => {
    rememberDiaryScrollTop(0);
    const scroller = makeScroller(400);
    scroller.grow(2400);

    const view = mount(scroller);
    scrollTo(scroller, 320); // the learner reads down the timeline and stops here
    expect(diaryScrollTop()).toBe(320);

    // Navigating away empties the timeline *before* React runs the effect cleanup, so the container
    // collapses while the listener is still attached: the browser clamps 320 to 0 and fires `scroll`.
    // This is the page being taken apart, not the learner going back to the top — recording it would
    // destroy the place they left for this return and every later one.
    scroller.shrinkTo(400);

    expect(diaryScrollTop()).toBe(320);

    view.unmount();
  });

  it("gives way the moment the learner takes over, and records where they went", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);

    const view = mount(scroller);
    scroller.grow(1200);

    // A wheel tick is the learner arriving. A relayout cannot forge one, which is why the hand-off is
    // keyed off it rather than off `scrollTop` moving.
    act(() => {
      scroller.container.dispatchEvent(new Event("wheel"));
    });
    expect(watching()).toBe(0);

    scrollTo(scroller, 90);
    expect(diaryScrollTop()).toBe(90);

    // Later growth must not yank the learner back to where they no longer are.
    scroller.grow(2400);
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(90);

    view.unmount();
  });

  it.each(["touchstart", "pointerdown", "keydown"])(
    "hands the container over to the learner on %s",
    (intent) => {
      rememberDiaryScrollTop(320);
      const scroller = makeScroller(400);

      const view = mount(scroller);
      expect(watching()).toBe(1);

      act(() => {
        scroller.container.dispatchEvent(new Event(intent));
      });
      expect(watching()).toBe(0);

      // The timeline reaching full height after they have acted must not move them.
      scroller.grow(2400);
      notifyResizes();
      expect(scroller.container.scrollTop).toBe(0);

      view.unmount();
    }
  );

  it("settles at the furthest valid position when the timeline never grows that far", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);
    scroller.grow(500); // the timeline is genuinely shorter than last visit: 100 is as far as it goes

    const view = mount(scroller);
    expect(scroller.container.scrollTop).toBe(100);

    // Nothing loops and nothing is waiting on a clock: the restore simply rests here, ready if the
    // timeline grows, and is released when Diary goes.
    expect(vi.getTimerCount()).toBe(0);
    expect(scroller.container.scrollTop).toBe(100);
    // The remembered place is left intact, so a later, fuller timeline still restores it.
    expect(diaryScrollTop()).toBe(320);

    view.unmount();
    expect(watching()).toBe(0);
  });

  it("restores in one step without watching for growth when the timeline is already tall", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);
    scroller.grow(2400);

    const view = mount(scroller);

    expect(scroller.container.scrollTop).toBe(320);
    expect(resizes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    view.unmount();
  });

  it("returns a fresh visit to the top of the shared scroll container", () => {
    const scroller = makeScroller(400);
    scroller.grow(2400);
    scroller.container.scrollTop = 700; // left over from the surface the learner came from

    const view = mount(scroller);

    expect(scroller.container.scrollTop).toBe(0);
    expect(resizes).toHaveLength(0);

    view.unmount();
  });

  it("owns scroll anchoring only while Diary is mounted, and stops recording after it leaves", () => {
    rememberDiaryScrollTop(0);
    const scroller = makeScroller(400);
    scroller.grow(2400);
    scroller.container.style.overflowAnchor = "auto";

    const view = mount(scroller);
    // Late growth above the restored position must not be turned into a scroll shift (#678).
    expect(scroller.container.style.overflowAnchor).toBe("none");

    scrollTo(scroller, 240);
    expect(diaryScrollTop()).toBe(240);

    view.unmount();
    expect(scroller.container.style.overflowAnchor).toBe("auto");

    // The passive listener is gone: another surface scrolling the shared container cannot rewrite the
    // Diary's remembered place.
    scrollTo(scroller, 1500);
    expect(diaryScrollTop()).toBe(240);
  });

  it("leaves nothing behind when Diary unmounts before the restore lands", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);

    const view = mount(scroller);
    expect(watching()).toBe(1);

    view.unmount();

    expect(watching()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    // The scroll container is shared with every other surface: growth there after Diary has gone must
    // not drag it to a place only Diary remembers.
    scroller.grow(2400);
    notifyResizes();
    expect(scroller.container.scrollTop).toBe(0);
  });

  it("touches nothing until the timeline is ready", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);
    scroller.grow(2400);

    const view = mount(scroller, false);

    expect(scroller.container.scrollTop).toBe(0);
    expect(scroller.container.style.overflowAnchor).toBe("");

    // Once the timeline is ready the restore runs.
    view.rerender({ active: true });
    expect(scroller.container.scrollTop).toBe(320);

    view.unmount();
  });

  it("does nothing when the Diary content has not mounted", () => {
    rememberDiaryScrollTop(320);
    const scroller = makeScroller(400);
    scroller.grow(2400);
    const ref = { current: null as HTMLElement | null };

    const view = renderHook(() => useDiaryScrollRestore(ref, true));

    expect(scroller.container.scrollTop).toBe(0);
    expect(resizes).toHaveLength(0);

    view.unmount();
  });

  it("does nothing when the content is not inside a scroll container", () => {
    rememberDiaryScrollTop(320);
    const detached = document.createElement("div");
    document.body.append(detached);
    const ref = { current: detached as HTMLElement | null };

    const view = renderHook(() => useDiaryScrollRestore(ref, true));

    expect(resizes).toHaveLength(0);
    expect(detached.closest("main")).toBeNull();

    view.unmount();
  });
});
