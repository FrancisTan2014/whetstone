// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LookupPanel, type LookupState, type LookupTab } from "./LookupPanel";

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
  entry: {
    etymology: "From Old English settan.",
    headword: "set",
    partsOfSpeech: [
      {
        partOfSpeech: "verb",
        senses: [
          {
            definition: "to put in place",
            examples: ["set it down"],
            synonyms: ["place", "position"]
          }
        ]
      },
      { senses: [{ definition: "a group of things", examples: [], synonyms: [] }] }
    ],
    pronunciations: [{ ipa: "/sɛt/" }],
    sources: ["From WordNet.", "From Wiktionary."]
  },
  status: "loaded"
};

function renderPanel(
  state: LookupState,
  options: { anchorRect?: DOMRect; matchers: Record<string, boolean>; onOpenChange?: () => void }
): RenderResult {
  mockMatchMedia(options.matchers);
  const tabs: LookupTab[] = [{ id: "wordnet", label: "WordNet", state }];
  return render(
    <LookupPanel
      anchorRect={options.anchorRect}
      onOpenChange={options.onOpenChange ?? (() => undefined)}
      open={true}
      tabs={tabs}
      term="set"
    />
  );
}

function renderTabs(
  tabs: ReadonlyArray<LookupTab>,
  matchers: Record<string, boolean> = desktop
): RenderResult {
  mockMatchMedia(matchers);
  return render(<LookupPanel onOpenChange={() => undefined} open={true} tabs={tabs} term="set" />);
}

afterEach(() => {
  cleanup();
});

describe("LookupPanel content", () => {
  it("renders the headword, pronunciation, senses, synonyms, etymology, and sources when loaded", () => {
    renderPanel(loadedEntry, { matchers: desktop });

    expect(screen.getByText("set")).toBeDefined();
    expect(screen.getByText("/sɛt/")).toBeDefined();
    expect(screen.getByText("verb")).toBeDefined();
    expect(screen.getByText("to put in place")).toBeDefined();
    expect(screen.getByText("“set it down”")).toBeDefined();
    const synonyms = screen.getByRole("list", { name: "Synonyms" });
    expect(within(synonyms).getByText("place")).toBeDefined();
    expect(within(synonyms).getByText("position")).toBeDefined();
    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.getByText(/From Old English settan\./)).toBeDefined();
    expect(screen.getByText("From WordNet. · From Wiktionary.")).toBeDefined();
  });

  it("color-codes each part-of-speech section with a tokenized hue class", () => {
    renderPanel(loadedEntry, { matchers: desktop });
    const groups = document.querySelectorAll(".lookupGroup");

    // The verb group carries the verb hue; the part-of-speech-less group falls back to "other".
    expect(groups[0]?.className).toContain("lookupPos--verb");
    expect(groups[1]?.className).toContain("lookupPos--other");
  });

  it("renders an audio control only for a pronunciation that has audio", () => {
    renderPanel(
      {
        entry: {
          headword: "set",
          partsOfSpeech: [{ senses: [{ definition: "d", examples: [], synonyms: [] }] }],
          pronunciations: [
            { audio: "https://audio.example/set.mp3", ipa: "/sɛt/" },
            { ipa: "/sɛt2/" }
          ],
          sources: []
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    expect(document.querySelectorAll("audio.lookupAudio")).toHaveLength(1);
    expect(screen.getByLabelText("Pronunciation audio for set")).toBeDefined();
  });

  it("omits pronunciation, part of speech, synonyms, etymology, and sources when absent", () => {
    renderPanel(
      {
        entry: {
          headword: "set",
          partsOfSpeech: [
            { senses: [{ definition: "a group of things", examples: [], synonyms: [] }] }
          ],
          pronunciations: [],
          sources: []
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    expect(screen.getByText("a group of things")).toBeDefined();
    expect(screen.queryByRole("list", { name: "Synonyms" })).toBeNull();
    expect(screen.queryByText(/Origin/)).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
  });

  it("renders parts of speech once, with examples and synonyms as separated blocks", () => {
    renderPanel(
      {
        entry: {
          headword: "set",
          partsOfSpeech: [
            {
              partOfSpeech: "verb",
              senses: [
                { definition: "to put in place", examples: ["set it down"], synonyms: ["place"] },
                { definition: "to fix firmly", examples: [], synonyms: [] }
              ]
            },
            {
              partOfSpeech: "noun",
              senses: [{ definition: "a group of things", examples: ["a chess set"], synonyms: [] }]
            }
          ],
          pronunciations: [],
          sources: []
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    expect(screen.getAllByText("verb")).toHaveLength(1);
    expect(screen.getAllByText("noun")).toHaveLength(1);
    expect(screen.getByText("verb").textContent).toBe("verb");
    expect(screen.getByText("to put in place").textContent).toBe("to put in place");
    expect(screen.getByText("“set it down”").textContent).toBe("“set it down”");
    expect(screen.getByText("place").textContent).toBe("place");
  });

  it("renders synonyms once per part of speech, deduplicated across its senses", () => {
    renderPanel(
      {
        entry: {
          headword: "set",
          partsOfSpeech: [
            {
              partOfSpeech: "verb",
              senses: [
                { definition: "to put in place", examples: [], synonyms: ["place", "position"] },
                { definition: "to fix firmly", examples: [], synonyms: ["Place", "fix"] }
              ]
            }
          ],
          pronunciations: [],
          sources: []
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    // A single "Synonyms" row for the whole part of speech, not one under each sense.
    const lists = screen.getAllByRole("list", { name: "Synonyms" });
    expect(lists).toHaveLength(1);

    // Deduplicated case-insensitively ("Place" drops to the first-seen "place"), order preserved.
    const chips = within(lists[0] as HTMLElement).getAllByRole("listitem");
    expect(chips.map((chip) => chip.textContent)).toEqual(["place", "position", "fix"]);
    expect(screen.getByText("Synonyms").textContent).toBe("Synonyms");
  });

  it("numbers each sense with a quiet ordinal before its gloss, examples nested under it", () => {
    renderPanel(
      {
        entry: {
          headword: "set",
          partsOfSpeech: [
            {
              partOfSpeech: "verb",
              senses: [
                { definition: "to put in place", examples: ["set it down"], synonyms: [] },
                { definition: "to fix firmly", examples: [], synonyms: [] }
              ]
            },
            {
              partOfSpeech: "noun",
              senses: [{ definition: "a group of things", examples: [], synonyms: [] }]
            }
          ],
          pronunciations: [],
          sources: []
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    const lists = document.querySelectorAll("ol.lookupSenses");
    const verbList = lists[0] as HTMLElement;
    const items = within(verbList).getAllByRole("listitem");

    // Ordinals count up within the part of speech.
    expect(items.map((item) => item.querySelector(".lookupSenseOrdinal")?.textContent)).toEqual([
      "1.",
      "2."
    ]);

    // The ordinal precedes the gloss, and the example stays nested inside the same sense.
    const first = items[0] as HTMLElement;
    expect(first.textContent?.indexOf("1.")).toBeLessThan(
      first.textContent?.indexOf("to put in place") ?? -1
    );
    expect(within(first).getByText("“set it down”")).toBeDefined();

    // A single-sense part of speech still numbers from 1.
    const nounList = lists[1] as HTMLElement;
    expect(within(nounList).getByText("1.")).toBeDefined();
  });

  it("collapses and expands a part-of-speech group, toggling aria-expanded", async () => {
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: desktop });

    const toggle = screen.getByRole("button", { name: "verb" });
    // Groups default to expanded: the verb group's senses are visible.
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("to put in place")).toBeDefined();

    // Collapse: the verb senses hide; the other group is unaffected.
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("to put in place")).toBeNull();
    expect(screen.getByText("a group of things")).toBeDefined();

    // Expand again: the senses come back.
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("to put in place")).toBeDefined();
  });

  it("shows a loading state while fetching", () => {
    renderPanel({ status: "loading" }, { matchers: desktop });

    expect(screen.getByRole("status").textContent).toContain("Looking up");
  });

  it("shows an error state when the lookup fails", () => {
    renderPanel({ status: "error" }, { matchers: desktop });

    expect(screen.getByRole("alert").textContent).toContain("unavailable");
  });

  it("shows an empty state when no definition is found", () => {
    renderPanel({ status: "empty" }, { matchers: desktop });

    expect(screen.getByText("No definition found.")).toBeDefined();
  });

  it("offers a tab per source and auto-selects the first with content", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: loadedEntry },
      { id: "wiktionary", label: "Wiktionary", state: { status: "loading" } }
    ]);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["WordNet", "Wiktionary"]);
    // WordNet loaded -> shown by default; the still-loading Wiktionary doesn't trap the panel.
    expect(screen.getByText("to put in place")).toBeDefined();
  });

  it("lets the reader switch to the other tab, each fetched independently", async () => {
    const user = userEvent.setup();
    renderTabs([
      { id: "wordnet", label: "WordNet", state: loadedEntry },
      { id: "wiktionary", label: "Wiktionary", state: { status: "error" } }
    ]);

    await user.click(screen.getByRole("tab", { name: "Wiktionary" }));
    expect(screen.getByRole("alert").textContent).toContain("unavailable");
  });

  it("shows one explicit error when every source fails or is empty", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: { status: "empty" } },
      { id: "wiktionary", label: "Wiktionary", state: { status: "error" } }
    ]);

    expect(screen.getByRole("alert").textContent).toContain("Could not look up");
  });

  it("shows the combined error when there are no sources for the language", () => {
    renderTabs([]);
    expect(screen.getByRole("alert").textContent).toContain("Could not look up");
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

  it("bounds the popover height to the available viewport space so it never clips off-screen", () => {
    renderPanel(loadedEntry, {
      anchorRect: { bottom: 60, height: 20, left: 120, top: 40, width: 80 } as DOMRect,
      matchers: desktop
    });

    // Height is capped by Radix's collision-aware available height (whichever side it flips to),
    // not a fixed box — so a card flipped above a low selection shrinks to the room on screen and
    // scrolls internally rather than extending past the top and clipping the headword.
    const dialog = screen.getByRole("dialog", { name: "Look up: set" });
    expect(dialog.style.maxHeight).toContain("var(--radix-popover-content-available-height");
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

  it("renders the collapsible part-of-speech toggle in the sheet too", async () => {
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: mobile });

    const toggle = screen.getByRole("button", { name: "verb" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("to put in place")).toBeNull();
  });

  it("dismisses the sheet via its close control", async () => {
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    renderPanel(loadedEntry, { matchers: mobile, onOpenChange });

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
