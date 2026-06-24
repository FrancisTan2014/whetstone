// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LookupPanel, type LookupState } from "./LookupPanel";

function mockMatchMedia(matchers: Record<string, boolean>): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    matches: matchers[query] ?? false,
    media: query,
    removeEventListener: vi.fn()
  })) as unknown as typeof window.matchMedia;
}

const desktop = { "(min-width: 768px)": true };
const mobile = { "(min-width: 768px)": false };

const loadedEntry: LookupState = {
  attribution: "From a source.",
  entry: {
    headword: "set",
    pronunciation: "/sɛt/",
    senses: [
      { example: "set it down", gloss: "to put in place", partOfSpeech: "verb" },
      { gloss: "a group of things" }
    ]
  },
  status: "loaded"
};

function renderPanel(
  state: LookupState,
  options: { anchorRect?: DOMRect; matchers: Record<string, boolean>; onOpenChange?: () => void }
): void {
  mockMatchMedia(options.matchers);
  render(
    <LookupPanel
      anchorRect={options.anchorRect}
      onOpenChange={options.onOpenChange ?? (() => undefined)}
      open={true}
      state={state}
      term="set"
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("LookupPanel content", () => {
  it("renders the headword, pronunciation, senses, and attribution when loaded", () => {
    renderPanel(loadedEntry, { matchers: desktop });

    expect(screen.getByText("set")).toBeDefined();
    expect(screen.getByText("/sɛt/")).toBeDefined();
    expect(screen.getByText("verb")).toBeDefined();
    expect(screen.getByText("to put in place")).toBeDefined();
    expect(screen.getByText("“set it down”")).toBeDefined();
    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.getByText("From a source.")).toBeDefined();
  });

  it("omits pronunciation, part of speech, example, and attribution when absent", () => {
    renderPanel(
      { entry: { headword: "set", senses: [{ gloss: "a group of things" }] }, status: "loaded" },
      { matchers: desktop }
    );

    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.queryByText("From a source.")).toBeNull();
  });

  it("shows a loading state while fetching", () => {
    renderPanel({ status: "loading" }, { matchers: desktop });

    expect(screen.getByRole("status").textContent).toContain("Looking up");
  });

  it("shows an error state when the lookup fails", () => {
    renderPanel({ status: "error" }, { matchers: desktop });

    expect(screen.getByRole("alert").textContent).toContain("Could not look up");
  });

  it("shows an empty state when no definition is found", () => {
    renderPanel({ status: "empty" }, { matchers: desktop });

    expect(screen.getByText("No definition found.")).toBeDefined();
  });
});

describe("LookupPanel desktop popover", () => {
  it("renders a labelled dialog anchored near the selection rect", () => {
    renderPanel(loadedEntry, {
      anchorRect: { bottom: 60, height: 20, left: 120, top: 40, width: 80 } as DOMRect,
      matchers: desktop
    });

    const dialog = screen.getByRole("dialog", { name: "Look up: set" });
    expect(dialog.className).toContain("lookupPopover");
  });

  it("still anchors and renders when the selection rect is unavailable", () => {
    renderPanel(loadedEntry, { matchers: desktop });

    expect(screen.getByRole("dialog", { name: "Look up: set" })).toBeDefined();
    expect(screen.getByText("a group of things")).toBeDefined();
  });

  it("dismisses via the explicit close control", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: desktop, onOpenChange });

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses via the Escape key", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: desktop, onOpenChange });

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("dismisses via an outside click", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: desktop, onOpenChange });

    await user.click(document.body);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("LookupPanel mobile sheet", () => {
  it("renders a content-height bottom sheet titled with the term", () => {
    renderPanel(loadedEntry, { matchers: mobile });

    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("data-side")).toBe("bottom");
    expect(screen.getByText("Look up: set")).toBeDefined();
  });

  it("dismisses the sheet via its close control", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: mobile, onOpenChange });

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
