import { describe, expect, it } from "vitest";

import {
  clampOffset,
  clampScale,
  FIT_SCALE,
  initialZoomState,
  MAX_SCALE,
  panExtent,
  pinchDistance,
  readSize,
  transformOf,
  withPan,
  withScale
} from "./figureZoom";

const size = { height: 600, width: 800 } as const;

describe("figureZoom.clampScale", () => {
  it("clamps below fit up to the fit floor", () => {
    expect(clampScale(0.2)).toBe(FIT_SCALE);
  });

  it("clamps above the ceiling down to MAX_SCALE", () => {
    expect(clampScale(999)).toBe(MAX_SCALE);
  });

  it("passes an in-range scale through unchanged", () => {
    expect(clampScale(2.5)).toBe(2.5);
  });
});

describe("figureZoom.panExtent", () => {
  it("is zero at fit (no pan when not zoomed)", () => {
    expect(panExtent(800, FIT_SCALE)).toBe(0);
  });

  it("is half the overflow beyond the fit box when zoomed", () => {
    expect(panExtent(800, 2)).toBe(400);
  });

  it("never goes negative for a scale below fit", () => {
    expect(panExtent(800, 0.5)).toBe(0);
  });
});

describe("figureZoom.clampOffset", () => {
  it("keeps an offset within the per-axis extent", () => {
    expect(clampOffset({ x: 50, y: -30 }, 2, size)).toEqual({ x: 50, y: -30 });
  });

  it("clamps an over-far positive offset to the extent", () => {
    expect(clampOffset({ x: 9999, y: 9999 }, 2, size)).toEqual({ x: 400, y: 300 });
  });

  it("clamps an over-far negative offset to the negative extent", () => {
    expect(clampOffset({ x: -9999, y: -9999 }, 2, size)).toEqual({ x: -400, y: -300 });
  });
});

describe("figureZoom.withScale", () => {
  it("snaps back to fit (centered, un-panned) when scaling to the floor", () => {
    const panned = { offset: { x: 100, y: 100 }, scale: 3 };
    expect(withScale(panned, FIT_SCALE, size)).toEqual(initialZoomState);
  });

  it("re-clamps an existing pan to the new (smaller) bounds when zooming out", () => {
    const panned = { offset: { x: 400, y: 300 }, scale: 3 };
    // At 1.5x the extent is 800*0.5/2 = 200 (x) and 600*0.5/2 = 150 (y).
    expect(withScale(panned, 1.5, size)).toEqual({ offset: { x: 200, y: 150 }, scale: 1.5 });
  });

  it("bounds the scale at MAX_SCALE when zooming past the ceiling", () => {
    expect(withScale(initialZoomState, 99, size).scale).toBe(MAX_SCALE);
  });
});

describe("figureZoom.withPan", () => {
  it("applies a clamped pan at the current scale", () => {
    const state = { offset: { x: 0, y: 0 }, scale: 2 };
    expect(withPan(state, { x: 9999, y: -10 }, size)).toEqual({
      offset: { x: 400, y: -10 },
      scale: 2
    });
  });
});

describe("figureZoom.transformOf", () => {
  it("renders translate (px) then scale", () => {
    expect(transformOf({ offset: { x: 12, y: -8 }, scale: 2.5 })).toBe(
      "translate(12px, -8px) scale(2.5)"
    );
  });
});

describe("figureZoom.pinchDistance", () => {
  it("is zero with fewer than two pointers", () => {
    expect(pinchDistance([{ x: 1, y: 1 }])).toBe(0);
  });

  it("is the euclidean distance between the first two pointers", () => {
    expect(
      pinchDistance([
        { x: 0, y: 0 },
        { x: 3, y: 4 }
      ])
    ).toBe(5);
  });
});

describe("figureZoom.readSize", () => {
  it("is the zero size for a missing element", () => {
    expect(readSize(null)).toEqual({ height: 0, width: 0 });
  });

  it("reads the element's transform-independent layout size", () => {
    const element = { offsetHeight: 600, offsetWidth: 800 } as unknown as HTMLElement;
    expect(readSize(element)).toEqual({ height: 600, width: 800 });
  });
});
