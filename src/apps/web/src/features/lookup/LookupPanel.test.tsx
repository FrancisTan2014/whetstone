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

// A found entry that carries no part-of-speech groups: the response contract permits found:true with
// an empty partsOfSpeech array, so the panel must treat it as "no content" (#306).
const emptyButLoaded: LookupState = {
  entry: { headword: "versus", partsOfSpeech: [], pronunciations: [], sources: ["From WordNet."] },
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
  matchers: Record<string, boolean> = desktop,
  term = "set"
): RenderResult {
  mockMatchMedia(matchers);
  return render(<LookupPanel onOpenChange={() => undefined} open={true} tabs={tabs} term={term} />);
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

  it("renders external dictionary deep-links under the headword with safe new-tab attributes (#254)", () => {
    renderPanel(loadedEntry, { matchers: desktop });

    const links = within(
      screen.getByRole("navigation", { name: "Open in external dictionary" })
    ).getAllByRole("link");

    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Longman", "https://www.ldoceonline.com/dictionary/set"],
      ["Merriam-Webster", "https://www.merriam-webster.com/dictionary/set"],
      [
        "Oxford Learner's",
        "https://www.oxfordlearnersdictionaries.com/search/english/direct/?q=set"
      ]
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }

    // The row lives inside the header (under the headword/IPA), not in the groups body.
    const header = screen.getByText("set").closest("header");
    expect(
      header?.contains(screen.getByRole("navigation", { name: "Open in external dictionary" }))
    ).toBe(true);
  });

  it("shows Chinese external dictionary links for a Chinese (CJK) headword (#296)", () => {
    renderPanel(
      {
        entry: {
          headword: "曰",
          partsOfSpeech: [{ senses: [{ definition: "to say", examples: [], synonyms: [] }] }],
          pronunciations: [],
          sources: ["From 萌典."]
        },
        status: "loaded"
      },
      { matchers: desktop }
    );

    expect(screen.getByText("曰")).toBeDefined();
    const links = within(
      screen.getByRole("navigation", { name: "Open in external dictionary" })
    ).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual(["汉典", "萌典", "ctext", "国学大师"]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
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

  it("shows the no-definition launchpad naming the term with external links when empty (#339)", () => {
    renderPanel({ status: "empty" }, { matchers: desktop });

    expect(screen.getByText("No definition found for “set”.")).toBeDefined();
    // The same language-aware links as a resolved entry — a launchpad, not a dead-end.
    const links = within(
      screen.getByRole("navigation", { name: "Open in external dictionary" })
    ).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Longman",
      "Merriam-Webster",
      "Oxford Learner's"
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
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

  it("auto-selects Wiktionary when WordNet has no entry for a function word (#306)", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: { status: "empty" } },
      { id: "wiktionary", label: "Wiktionary", state: loadedEntry }
    ]);

    // 'versus'/'against' have no WordNet entry; the panel opens on the populated Wiktionary tab
    // instead of stranding the reader on WordNet's "No definition found".
    expect(screen.getByText("to put in place")).toBeDefined();
    expect(screen.queryByText("No definition found.")).toBeNull();
  });

  it("treats an empty-but-loaded default as no content and falls through (#306)", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: emptyButLoaded },
      { id: "wiktionary", label: "Wiktionary", state: loadedEntry }
    ]);

    // A found-but-content-less entry (no part-of-speech groups) carries nothing to read, so the
    // default skips it and lands on the populated Wiktionary tab.
    expect(screen.getByText("to put in place")).toBeDefined();
    expect(screen.queryByText("No definition found.")).toBeNull();
  });

  it("shows the no-match state when the reader opens an empty-but-loaded tab (#306)", async () => {
    const user = userEvent.setup();
    renderTabs([
      { id: "wordnet", label: "WordNet", state: emptyButLoaded },
      { id: "wiktionary", label: "Wiktionary", state: loadedEntry }
    ]);

    await user.click(screen.getByRole("tab", { name: "WordNet" }));
    expect(screen.getByText("No definition found for “set”.")).toBeDefined();
  });

  it("shows the no-definition launchpad when every source is empty, errored, or empty-but-loaded (#306/#339)", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: emptyButLoaded },
      { id: "wiktionary", label: "Wiktionary", state: { status: "empty" } }
    ]);

    // No dead-end alert; the term is named and the external links are offered instead.
    expect(screen.getByText("No definition found for “set”.")).toBeDefined();
    expect(screen.queryByText(/Could not look up/)).toBeNull();
    const links = within(
      screen.getByRole("navigation", { name: "Open in external dictionary" })
    ).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Longman",
      "Merriam-Webster",
      "Oxford Learner's"
    ]);
  });

  it("keeps the Chinese 萌典 tab as the default while it loads, even when CC-CEDICT resolves first (#272)", () => {
    const cedictEnglish: LookupState = {
      entry: {
        headword: "卿",
        partsOfSpeech: [
          { senses: [{ definition: "high ranking official", examples: [], synonyms: [] }] }
        ],
        pronunciations: [{ ipa: "qīng" }],
        sources: ["From CC-CEDICT."]
      },
      status: "loaded"
    };
    renderTabs([
      { id: "moedict", label: "萌典", state: { status: "loading" } },
      { id: "cedict", label: "CC-CEDICT", state: cedictEnglish }
    ]);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["萌典", "CC-CEDICT"]);
    // 萌典 leads and is still loading, so its loading state shows — the English gloss never becomes
    // the default even though CC-CEDICT (offline) loaded first.
    expect(screen.getByRole("status").textContent).toContain("Looking up");
    expect(screen.queryByText("high ranking official")).toBeNull();
  });

  it("falls through to CC-CEDICT when the Chinese 萌典 source resolves empty (#272)", () => {
    const cedictEnglish: LookupState = {
      entry: {
        headword: "卿",
        partsOfSpeech: [
          { senses: [{ definition: "high ranking official", examples: [], synonyms: [] }] }
        ],
        pronunciations: [{ ipa: "qīng" }],
        sources: ["From CC-CEDICT."]
      },
      status: "loaded"
    };
    renderTabs([
      { id: "moedict", label: "萌典", state: { status: "empty" } },
      { id: "cedict", label: "CC-CEDICT", state: cedictEnglish }
    ]);

    // 萌典 has no entry, so the default falls through to the CC-CEDICT fallback rather than trapping.
    expect(screen.getByText("high ranking official")).toBeDefined();
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

  it("shows the launchpad with Chinese external links when a CJK term has no definition (#339)", () => {
    renderTabs(
      [
        { id: "moedict", label: "萌典", state: { status: "empty" } },
        { id: "cedict", label: "CC-CEDICT", state: { status: "error" } }
      ],
      desktop,
      "六爻"
    );

    expect(screen.getByText("No definition found for “六爻”.")).toBeDefined();
    const links = within(
      screen.getByRole("navigation", { name: "Open in external dictionary" })
    ).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["汉典", "萌典", "ctext", "国学大师"]);
    // The links point at the selected term and open safely in a new tab.
    expect(links[0]?.getAttribute("href")).toContain(encodeURIComponent("六爻"));
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
  });

  it("adds no panel-level fallback links when a source has readable content (#339)", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: loadedEntry },
      { id: "wiktionary", label: "Wiktionary", state: { status: "empty" } }
    ]);

    // The loaded entry renders unchanged: no not-found launchpad, and exactly one external-links row
    // (the entry header's) — never a duplicated panel-level fallback.
    expect(screen.queryByText(/No definition found for/)).toBeNull();
    expect(screen.getAllByRole("navigation", { name: "Open in external dictionary" })).toHaveLength(
      1
    );
  });

  it("shows the launchpad when every source fails or is empty", () => {
    renderTabs([
      { id: "wordnet", label: "WordNet", state: { status: "empty" } },
      { id: "wiktionary", label: "Wiktionary", state: { status: "error" } }
    ]);

    expect(screen.getByText("No definition found for “set”.")).toBeDefined();
    expect(screen.queryByText(/Could not look up/)).toBeNull();
  });

  it("shows the launchpad when there are no sources for the language", () => {
    renderTabs([]);
    expect(screen.getByText("No definition found for “set”.")).toBeDefined();
  });

  it("badges the local-LLM 'AI 解释' gloss as AI-generated, with the model attribution (#341)", () => {
    const aiEntry: LookupState = {
      entry: {
        headword: "六艺",
        partsOfSpeech: [
          { senses: [{ definition: "在此句中指六种技艺。", examples: [], synonyms: [] }] }
        ],
        pronunciations: [],
        sources: ["AI 解释 · qwen2.5 (local)"]
      },
      status: "loaded"
    };
    renderTabs([{ id: "llm", label: "AI 解释", state: aiEntry }], desktop, "六艺");

    expect(screen.getByText("在此句中指六种技艺。")).toBeDefined();
    const badge = screen.getByRole("note", { name: "AI-generated explanation, may be imperfect" });
    expect(badge.textContent).toContain("AI-generated");
    expect(screen.getByText("AI 解释 · qwen2.5 (local)")).toBeDefined();
  });

  it("does not default to the AI 解释 tab when a dictionary has content, and badges it only when opened (#341)", async () => {
    const user = userEvent.setup();
    const dictEntry: LookupState = {
      entry: {
        headword: "六艺",
        partsOfSpeech: [
          { senses: [{ definition: "六种技艺的辞书义。", examples: [], synonyms: [] }] }
        ],
        pronunciations: [],
        sources: ["From 萌典."]
      },
      status: "loaded"
    };
    const aiEntry: LookupState = {
      entry: {
        headword: "六艺",
        partsOfSpeech: [
          { senses: [{ definition: "在此句中的解释。", examples: [], synonyms: [] }] }
        ],
        pronunciations: [],
        sources: ["AI 解释 · qwen2.5 (local)"]
      },
      status: "loaded"
    };
    renderTabs(
      [
        { id: "moedict", label: "萌典", state: dictEntry },
        { id: "llm", label: "AI 解释", state: aiEntry }
      ],
      desktop,
      "六艺"
    );

    // The dictionary leads (preferredTab unchanged); the AI badge is absent until the reader opens it.
    expect(screen.getByText("六种技艺的辞书义。")).toBeDefined();
    expect(
      screen.queryByRole("note", { name: "AI-generated explanation, may be imperfect" })
    ).toBeNull();

    await user.click(screen.getByRole("tab", { name: "AI 解释" }));
    expect(
      screen.getByRole("note", { name: "AI-generated explanation, may be imperfect" })
    ).toBeDefined();
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
