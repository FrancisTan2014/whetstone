// Deterministic in-page test probes (issue #314). The tester's Playwright driver runs each probe
// via `page.evaluate(probe, selector)`, so a visual `[Bug]` is filed on a *computed value or rect* —
// not eyeballed pixels. Every probe is self-contained: all helpers are nested in its body and it
// touches only DOM/`window`/`document` globals, so it serializes for `page.evaluate`. Do NOT
// reference module-scope imports from inside a probe body.
//
// Usage (in the tester driver):
//   const { minRatio, failures } = await page.evaluate(contrast, ".reader p");
//   const { issues } = await page.evaluate(geometry, "button, a");
//   const surface = await page.evaluate(contentPresent, "main");
//   const collide = await page.evaluate(overlaps, [".popover", ".reader-text"]);
//
// File the bug on the number/rect, e.g.:
//   - contrast:  "text ratio 2.8 < 4.5 at .reader p ('low-contrast caption')"
//   - geometry:  "button 32×32 < 44 at header .menu-toggle"  /  "off-screen rect at .popover"
//   - content:   "surface blank: 0 text, 0 height at main"

export interface ContrastFailure {
  background: string;
  color: string;
  ratio: number;
  text: string;
}

export interface ContrastResult {
  failures: ContrastFailure[];
  minRatio: number;
}

// For every element under `selector` that has its own (direct) non-whitespace text, compute the WCAG
// contrast ratio of its text color against its effective background (the first non-transparent
// `background-color` walking up its ancestors; white if none), and collect those below 4.5:1.
export function contrast(selector: string): ContrastResult {
  const parseColor = (value: string): [number, number, number, number] | null => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (match === null) {
      return null;
    }
    const parts = match[1].split(",").map((part) => Number.parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
      return null;
    }
    return [parts[0], parts[1], parts[2], parts.length >= 4 ? parts[3] : 1];
  };

  const effectiveBackground = (element: Element): [number, number, number] => {
    let node: Element | null = element;
    while (node !== null) {
      const parsed = parseColor(getComputedStyle(node).backgroundColor);
      if (parsed !== null && parsed[3] !== 0) {
        return [parsed[0], parsed[1], parsed[2]];
      }
      node = node.parentElement;
    }
    return [255, 255, 255];
  };

  const channel = (value: number): number => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
  };

  const luminance = (rgb: [number, number, number]): number =>
    0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);

  const ratioOf = (
    foreground: [number, number, number],
    background: [number, number, number]
  ): number => {
    const lighter = Math.max(luminance(foreground), luminance(background));
    const darker = Math.min(luminance(foreground), luminance(background));
    return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
  };

  const ownText = (element: Element): string => {
    let text = "";
    element.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent ?? "";
      }
    });
    return text.trim();
  };

  const failures: ContrastFailure[] = [];
  let minRatio = 21;

  document.querySelectorAll(selector).forEach((element) => {
    const text = ownText(element);
    if (text.length === 0) {
      return;
    }
    const color = parseColor(getComputedStyle(element).color);
    if (color === null) {
      return;
    }
    const background = effectiveBackground(element);
    const ratio = ratioOf([color[0], color[1], color[2]], background);
    minRatio = Math.min(minRatio, ratio);
    if (ratio < 4.5) {
      failures.push({
        background: `rgb(${background[0]}, ${background[1]}, ${background[2]})`,
        color: getComputedStyle(element).color,
        ratio,
        text
      });
    }
  });

  return { failures, minRatio };
}

export interface GeometryRect {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface GeometryIssue {
  flags: string[];
  index: number;
  rect: GeometryRect;
}

export interface GeometryResult {
  issues: GeometryIssue[];
}

// Flag layout defects from `getBoundingClientRect`: `offScreen` (rect entirely outside the viewport),
// `clipped` (rect spills past the nearest `overflow:hidden|auto` ancestor's client rect, or past the
// viewport), and `tooSmall` (an interactive target rendered under 44px in either dimension).
export function geometry(selector: string): GeometryResult {
  const interactive = "button,a,[role=button],input,select,textarea,[tabindex]";

  const clippingAncestor = (element: Element): Element | null => {
    let node = element.parentElement;
    while (node !== null) {
      const style = getComputedStyle(node);
      const clips = (value: string): boolean => value === "hidden" || value === "auto";
      if (clips(style.overflow) || clips(style.overflowX) || clips(style.overflowY)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  };

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const issues: GeometryIssue[] = [];

  document.querySelectorAll(selector).forEach((element, index) => {
    const rect = element.getBoundingClientRect();
    const flags: string[] = [];

    const offScreen =
      rect.right <= 0 ||
      rect.bottom <= 0 ||
      rect.left >= viewportWidth ||
      rect.top >= viewportHeight;
    if (offScreen) {
      flags.push("offScreen");
    }

    const ancestor = clippingAncestor(element);
    const bound = ancestor === null ? null : ancestor.getBoundingClientRect();
    const clippedByAncestor =
      bound !== null &&
      (rect.left < bound.left ||
        rect.top < bound.top ||
        rect.right > bound.right ||
        rect.bottom > bound.bottom);
    const clippedByViewport =
      rect.left < 0 || rect.top < 0 || rect.right > viewportWidth || rect.bottom > viewportHeight;
    if (!offScreen && (clippedByAncestor || clippedByViewport)) {
      flags.push("clipped");
    }

    if (element.matches(interactive) && (rect.width < 44 || rect.height < 44)) {
      flags.push("tooSmall");
    }

    if (flags.length > 0) {
      issues.push({
        flags,
        index,
        rect: { height: rect.height, width: rect.width, x: rect.x, y: rect.y }
      });
    }
  });

  return { issues };
}

// Whether any rendered rect of `selectorA` intersects any rendered rect of `selectorB`. Takes the two
// selectors as a tuple so it is callable directly as `page.evaluate(overlaps, [a, b])`.
export function overlaps([selectorA, selectorB]: [string, string]): boolean {
  const rectsOf = (selector: string): DOMRect[] =>
    Array.from(document.querySelectorAll(selector)).map((element) =>
      element.getBoundingClientRect()
    );

  const intersects = (a: DOMRect, b: DOMRect): boolean =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

  const rectsA = rectsOf(selectorA);
  const rectsB = rectsOf(selectorB);
  return rectsA.some((a) => rectsB.some((b) => intersects(a, b)));
}

export interface ContentPresence {
  height: number;
  present: boolean;
  text: string;
}

// Catch blank surfaces: `text` is the trimmed `textContent`, `height` the rendered height; `present`
// is true when there is non-empty text OR a non-zero rendered height (so a zero-height element that
// still carries text counts as present — text wins).
export function contentPresent(selector: string): ContentPresence {
  const element = document.querySelector(selector);
  if (element === null) {
    return { height: 0, present: false, text: "" };
  }
  const text = (element.textContent ?? "").trim();
  const height = element.getBoundingClientRect().height;
  return { height, present: text.length > 0 || height > 0, text };
}
