// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../recall/recallApi", () => ({ fetchDueRecall: vi.fn() }));
vi.mock("./todayApi", () => ({ fetchLatestReadingPosition: vi.fn() }));

import type { LatestReadingPositionDto, RecallItemDto } from "@whetstone/contracts";

import { fetchDueRecall } from "../recall/recallApi";
import { fetchLatestReadingPosition } from "./todayApi";
import { TodayPage } from "./TodayPage";

const mockedRecall = vi.mocked(fetchDueRecall);
const mockedReading = vi.mocked(fetchLatestReadingPosition);

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
});

afterEach(() => {
  cleanup();
});

describe("TodayPage", () => {
  it("always offers the voice-diary quick-capture, linking to the diary", () => {
    renderToday();

    const link = screen.getByRole("link", { name: "Open your diary" });
    expect(link.getAttribute("href")).toBe("/diary");
    expect(screen.getByText("Capture a thought")).toBeDefined();
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
    expect(screen.getByText("Capture a thought")).toBeDefined();
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

  it("renders no practice-nudge card (the #245 slot stays empty until it ships)", () => {
    renderToday();

    expect(screen.queryByText(/practice/i)).toBeNull();
    expect(screen.queryByText(/nudge/i)).toBeNull();
  });

  it("shows a compassionate cleared state when nothing is due — no streak, guilt, or penalty", async () => {
    mockedRecall.mockResolvedValue([]);
    mockedReading.mockResolvedValue(undefined);
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
});
