import { vi } from "vitest";

// jsdom does not implement matchMedia, which several components read (theme, responsive
// Sheet, reduced-motion). Provide a quiet default (no match) for every jsdom test;
// tests that need a specific result override `window.matchMedia` themselves.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: query,
      onchange: null,
      removeEventListener: vi.fn()
    }),
    writable: true
  });
}

// jsdom does not implement ResizeObserver, which Radix's popper (the lookup popover's
// anchored positioning) constructs on mount. Provide an inert stub so popover-based
// components render in jsdom; positioning math is not exercised in unit tests.
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    public disconnect(): void {}
    public observe(): void {}
    public unobserve(): void {}
  }

  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
