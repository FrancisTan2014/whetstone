// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../recall/recallApi", () => ({ fetchDueRecall: vi.fn() }));
vi.mock("./todayApi", () => ({ fetchLatestReadingPosition: vi.fn() }));
vi.mock("../nudge/nudgeApi", () => ({ dismissNudge: vi.fn(), fetchNudge: vi.fn() }));
vi.mock("../library/libraryApi", () => ({ fetchWorks: vi.fn() }));
vi.mock("../diary/diaryApi", () => ({
  submitDiaryCapture: vi.fn()
}));
vi.mock("../capture/voiceCaptureApi", () => ({
  submitVoiceCapture: vi.fn(),
  fetchActiveVoiceCaptures: vi.fn(() => Promise.resolve([])),
  fetchVoiceCaptureStatus: vi.fn(),
  retryVoiceCapture: vi.fn()
}));

import type {
  AuthorDto,
  LatestReadingPositionDto,
  NudgeDto,
  RecallItemDto,
  WorkDto,
  WorkListDto
} from "@whetstone/contracts";

import { fetchWorks } from "../library/libraryApi";
import { dismissNudge, fetchNudge } from "../nudge/nudgeApi";
import { fetchDueRecall } from "../recall/recallApi";
import { fetchLatestReadingPosition } from "./todayApi";
import { TodayPage } from "./TodayPage";

const mockedRecall = vi.mocked(fetchDueRecall);
const mockedReading = vi.mocked(fetchLatestReadingPosition);
const mockedNudge = vi.mocked(fetchNudge);
const mockedDismiss = vi.mocked(dismissNudge);
const mockedWorks = vi.mocked(fetchWorks);

const emptyWorks: WorkListDto = { works: [] };

function makeWorkList(count: number): WorkListDto {
  const works = Array.from({ length: count }, (_, index) => ({
    author: { id: `author-${index}` as AuthorDto["id"], name: "Aesop" },
    work: {
      authorId: `author-${index}` as WorkDto["authorId"],
      entryId: `work-${index}` as WorkDto["entryId"],
      language: "en" as WorkDto["language"],
      title: "Fables",
      workType: "book" as WorkDto["workType"]
    }
  }));

  return { works };
}

function makeItem(overrides: Partial<RecallItemDto> = {}): RecallItemDto {
  return {
    chunkId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "r1",
    kind: "word",
    provenanceEntryId: null,
    review: {
      dueAt: "2026-01-01T00:00:00.000Z",
      easeFactor: 2.5,
      intervalDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      repetitions: 0
    },
    text: "spill the beans",
    cue: null,
    useContext: null,
    category: null,
    tags: null,
    sourceProposalCandidateId: null,
    ...overrides
  };
}

function makePosition(overrides: Partial<LatestReadingPositionDto> = {}): LatestReadingPositionDto {
  return {
    anchorBlockEntryId: null,
    unitEntryId: "unit-1",
    workEntryId: "work-1",
    workTitle: "Aesop's Fables",
    ...overrides
  };
}

function makeNudge(overrides: Partial<NudgeDto> = {}): NudgeDto {
  return {
    blockEntryId: "blk-1",
    caseId: "harvest-note-1",
    chunkId: "harvest-chunk-note-1",
    text: "thrive under pressure",
    workTitle: "On Grit",
    ...overrides
  };
}

// Hold both async arms open so the component stays in its loading state for a render assertion.
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function renderToday(): void {
  render(
    <MemoryRouter>
      <TodayPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRecall.mockReturnValue(pending<ReadonlyArray<RecallItemDto>>());
  mockedReading.mockReturnValue(pending<LatestReadingPositionDto | undefined>());
  mockedNudge.mockReturnValue(pending<NudgeDto | undefined>());
  mockedWorks.mockReturnValue(pending<WorkListDto>());
});

afterEach(() => {
  cleanup();
});

describe("TodayPage", () => {
  it("always offers the unified tap-and-talk plus typed capture", () => {
    renderToday();

    expect(screen.getByText("Capture today")).toBeDefined();
    expect(screen.getByLabelText("Capture text")).toBeDefined();
  });

  it("offers no proposal / history-mining controls on Today capture (#571)", () => {
    renderToday();

    // A diary capture journals only — the "Mine my history" action and proposal cards are gone.
    expect(screen.queryByRole("button", { name: "Mine my history" })).toBeNull();
    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("shows the calm greeting header without any metric or streak", () => {
    renderToday();

    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeDefined();
    expect(screen.queryByText(/streak/i)).toBeNull();
  });

  it("shows loading states for both composed arms while they resolve", () => {
    renderToday();

    expect(screen.getByText("Gathering what's due…")).toBeDefined();
    expect(screen.getByText("Finding where you left off…")).toBeDefined();
  });

  it("surfaces the first due item at a glance with a Review link, holding back the rest", async () => {
    mockedRecall.mockResolvedValue([
      makeItem({ gloss: "to reveal a secret" }),
      makeItem({ id: "r2", text: "by and large" })
    ]);
    renderToday();

    expect(await screen.findByText("Recall these 2 items.")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
    expect(screen.getByText("to reveal a secret")).toBeDefined();
    // Restraint: only the first item is shown here; the rest live behind the Review link.
    expect(screen.queryByText("by and large")).toBeNull();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/recall");
  });

  it("phrases a single due item in the singular and omits an absent gloss", async () => {
    mockedRecall.mockResolvedValue([makeItem({ gloss: null })]);
    renderToday();

    expect(await screen.findByText("Recall this 1 item.")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("shows a quiet recall empty line when nothing is due", async () => {
    mockedRecall.mockResolvedValue([]);
    renderToday();

    expect(await screen.findByText(/Nothing due — you’re caught up/)).toBeDefined();
  });

  it("shows a quiet inline note when recall fails to load, without blanking the page", async () => {
    mockedRecall.mockRejectedValue(new Error("boom"));
    renderToday();

    expect(await screen.findByText(/Couldn’t load recall/)).toBeDefined();
    // The page does not blank — the always-present capture invitation still renders.
    expect(screen.getByText("Capture today")).toBeDefined();
  });

  it("offers Continue reading from the latest position, deep-linking into the reader", async () => {
    mockedReading.mockResolvedValue(makePosition());
    renderToday();

    expect(await screen.findByText("Aesop's Fables")).toBeDefined();
    expect(screen.getByRole("link", { name: "Continue" }).getAttribute("href")).toBe(
      "#/reader?work=work-1"
    );
  });

  it("shows a quiet line when there is nothing to continue", async () => {
    mockedReading.mockResolvedValue(undefined);
    renderToday();

    expect(await screen.findByText("Nothing to continue yet.")).toBeDefined();
  });

  it("shows a quiet inline note when the latest position fails to load", async () => {
    mockedReading.mockRejectedValue(new Error("boom"));
    renderToday();

    expect(await screen.findByText(/Couldn’t load your reading/)).toBeDefined();
  });

  it("surfaces a single proposed practice nudge with an accept link to Practice", async () => {
    mockedNudge.mockResolvedValue(makeNudge());
    renderToday();

    expect(await screen.findByText("thrive under pressure")).toBeDefined();
    expect(screen.getByText("On Grit")).toBeDefined();
    const links = screen.getAllByRole("link", { name: "Practise now" });
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("/practice");
  });

  it("shortens a long captured snippet so the nudge card stays calm", async () => {
    const longText = "a".repeat(120);
    mockedNudge.mockResolvedValue(makeNudge({ text: longText }));
    renderToday();

    const snippet = await screen.findByText(/a{80}…$/);
    expect(snippet.textContent).toBe(`${"a".repeat(80)}…`);
  });

  it("dismisses the nudge — removing the card and telling the server (cooldown)", async () => {
    mockedNudge.mockResolvedValue(makeNudge());
    mockedDismiss.mockResolvedValue(undefined);
    renderToday();

    await screen.findByText("thrive under pressure");
    const dismiss = screen.getByRole("button", { name: "Dismiss this practice nudge" });
    // The dismiss control is a >=44px hit target (#489); it was just the ✕ glyph (~13x24) before.
    // jsdom has no layout, so assert the sizing utilities (min-h-11 = min-w-11 = 44px).
    expect(dismiss.className).toContain("min-h-11");
    expect(dismiss.className).toContain("min-w-11");
    fireEvent.click(dismiss);

    expect(mockedDismiss).toHaveBeenCalledWith("harvest-chunk-note-1");
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Practice nudge" })).toBeNull();
    });
  });

  it("still removes the card when the dismiss call fails, never blanking Today", async () => {
    mockedNudge.mockResolvedValue(makeNudge());
    mockedDismiss.mockRejectedValue(new Error("boom"));
    renderToday();

    await screen.findByText("thrive under pressure");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this practice nudge" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Practice nudge" })).toBeNull();
    });
    expect(screen.getByText("Capture today")).toBeDefined();
  });

  it("renders no nudge card when there is nothing to surface (null)", async () => {
    mockedNudge.mockResolvedValue(undefined);
    mockedRecall.mockResolvedValue([]);
    renderToday();

    await screen.findByText(/Nothing due — you’re caught up/);
    expect(screen.queryByRole("region", { name: "Practice nudge" })).toBeNull();
  });

  it("never blanks Today when the nudge fails to load", async () => {
    mockedNudge.mockRejectedValue(new Error("boom"));
    renderToday();

    expect(await screen.findByText("Capture today")).toBeDefined();
    expect(screen.queryByRole("region", { name: "Practice nudge" })).toBeNull();
  });

  it("shows a compassionate cleared state when nothing is due — no streak, guilt, or penalty", async () => {
    // A learner with a work but nothing due: a truthful cleared board (not a cold start).
    mockedWorks.mockResolvedValue(makeWorkList(1));
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    expect(await screen.findByText(/You’re done for today/)).toBeDefined();
    for (const word of [/streak/i, /guilt/i, /penalty/i, /broke/i]) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it("does not show the cleared state while there is still a due item to act on", async () => {
    mockedRecall.mockResolvedValue([makeItem()]);
    mockedReading.mockResolvedValue(undefined);
    renderToday();

    await screen.findByText("spill the beans");
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("does not show the cleared state while a practice nudge is still actionable", async () => {
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(makeNudge());
    renderToday();

    await screen.findByText("thrive under pressure");
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("shows a truthful first-run on-ramp on a cold start, hiding done-for-today", async () => {
    // No works, no reading position, no recall due, no nudge: point to the on-ramp, not "done".
    mockedWorks.mockResolvedValue(emptyWorks);
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    expect(await screen.findByText("Start with one source")).toBeDefined();
    expect(screen.getByRole("link", { name: "Open Library" }).getAttribute("href")).toBe(
      "/library"
    );
    // The done-for-today message is untruthful here, so it stays hidden.
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("returns to the normal cleared board once the learner has at least one work", async () => {
    mockedWorks.mockResolvedValue(makeWorkList(1));
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    expect(await screen.findByText(/You’re done for today/)).toBeDefined();
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
  });

  it("does not show the first-run on-ramp when a learner trace exists though the library is empty", async () => {
    // A due recall item is a trace: the learner is not truly at a cold start, so no on-ramp card.
    mockedWorks.mockResolvedValue(emptyWorks);
    mockedRecall.mockResolvedValue([makeItem()]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    await screen.findByText("spill the beans");
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("does not show the on-ramp when a practice nudge marks the learner though the library is empty", async () => {
    // A present nudge is a trace/action: not a cold start, so the nudge shows and no on-ramp appears.
    mockedWorks.mockResolvedValue(emptyWorks);
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(makeNudge());
    renderToday();

    await screen.findByText("thrive under pressure");
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("makes no state claim while the library load is still pending", async () => {
    // Recall/reading/nudge are empty but the library is still loading: Today must not claim the
    // first-run card NOR "done for today" — a done claim on unknown cold-start info is untruthful.
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    mockedWorks.mockReturnValue(pending<WorkListDto>());
    renderToday();

    await screen.findByText(/Nothing to continue yet/);
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
  });

  it("makes no state claim when the library load fails", async () => {
    // A failed library arm cannot confirm or rule out a cold start: neither the on-ramp card nor
    // "done for today" appears, and the page does not blank.
    mockedWorks.mockRejectedValue(new Error("boom"));
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    await screen.findByText(/Nothing to continue yet/);
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
    expect(screen.queryByText(/You’re done for today/)).toBeNull();
    expect(screen.getByText("Capture today")).toBeDefined();
  });

  it("shows the cleared board for a returning learner known only by a reading position", async () => {
    // A loaded reading position rules out a cold start even when the library request is empty.
    mockedWorks.mockResolvedValue(emptyWorks);
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(makePosition());
    mockedNudge.mockResolvedValue(undefined);
    renderToday();

    expect(await screen.findByText(/You’re done for today/)).toBeDefined();
    expect(screen.queryByRole("region", { name: "Start with one source" })).toBeNull();
  });
});
