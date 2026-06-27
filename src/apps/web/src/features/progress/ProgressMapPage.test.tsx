// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./progressApi", () => ({
  fetchProgressMap: vi.fn()
}));

import type { ProgressMapDto } from "@whetstone/contracts";

import { fetchProgressMap } from "./progressApi";
import { ProgressMapPage } from "./ProgressMapPage";

const mockedFetch = vi.mocked(fetchProgressMap);

function makeMap(overrides: Partial<ProgressMapDto> = {}): ProgressMapDto {
  return {
    domains: [
      {
        cases: [
          {
            caseId: "k.meal",
            communicativeFunction: "Proposing a plan",
            light: "dim",
            mastery: {
              caseId: "k.meal",
              dueChunks: 0,
              learningChunks: 1,
              masteredChunks: 2,
              newChunks: 4,
              totalChunks: 7
            },
            recommended: true,
            situation: "Planning a meal"
          },
          {
            caseId: "k.table",
            communicativeFunction: "Offering food",
            light: "lit",
            mastery: {
              caseId: "k.table",
              dueChunks: 0,
              learningChunks: 0,
              masteredChunks: 6,
              newChunks: 0,
              totalChunks: 6
            },
            recommended: false,
            situation: "At the table"
          }
        ],
        domain: { id: "kitchen", name: "Kitchen & cooking", weight: 0.9 }
      },
      {
        cases: [
          {
            caseId: "s.greet",
            communicativeFunction: "Saying hi",
            light: "dark",
            mastery: {
              caseId: "s.greet",
              dueChunks: 0,
              learningChunks: 0,
              masteredChunks: 0,
              newChunks: 6,
              totalChunks: 6
            },
            recommended: false,
            situation: "Greeting someone"
          }
        ],
        domain: { id: "small_talk", name: "Small talk", weight: 0.85 }
      }
    ],
    recommendedCaseId: "k.meal",
    signals: {
      errorTrend: [{ category: "article_drop", count: 3, lastSeenAt: "2026-01-01T00:00:00.000Z" }],
      ownedChunks: 8,
      summary: "You own 8 of 19 everyday phrasings; 1 need review.",
      totalChunks: 19,
      weakChunks: 1
    },
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("ProgressMapPage", () => {
  it("shows a loading state while the map loads", () => {
    mockedFetch.mockReturnValue(new Promise<ProgressMapDto>(() => {}));
    render(<ProgressMapPage />);
    expect(screen.getByText("Mapping your progress…")).toBeDefined();
  });

  it("shows an error state when the map cannot load", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    render(<ProgressMapPage />);
    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("renders domains, lit/dim/dark cases, the recommended region, counts and error trend", async () => {
    mockedFetch.mockResolvedValue(makeMap());
    render(<ProgressMapPage />);

    expect(
      await screen.findByText("You own 8 of 19 everyday phrasings; 1 need review.")
    ).toBeDefined();

    const counts = screen.getByRole("list", { name: "Progress counts" });
    expect(within(counts).getByText("Owned 8")).toBeDefined();
    expect(within(counts).getByText("Needs review 1")).toBeDefined();
    expect(within(counts).getByText("19 in your world")).toBeDefined();

    expect(screen.getByRole("heading", { level: 2, name: "Kitchen & cooking" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Small talk" })).toBeDefined();

    // Light levels are surfaced per case via the tile's accessible label.
    expect(screen.getByLabelText("Planning a meal — In progress, recommended next")).toBeDefined();
    expect(screen.getByLabelText("At the table — Owned")).toBeDefined();
    expect(screen.getByLabelText("Greeting someone — Unknown")).toBeDefined();

    // Exactly one region is highlighted as recommended.
    expect(screen.getAllByText("Recommended")).toHaveLength(1);

    const trend = screen.getByRole("list", { name: "Error trend" });
    expect(within(trend).getByText("article drop · 3")).toBeDefined();
  });

  it("shows an explicit empty state when there is no error trend", async () => {
    mockedFetch.mockResolvedValue(makeMap({ signals: { ...makeMap().signals, errorTrend: [] } }));
    render(<ProgressMapPage />);
    expect(await screen.findByText("No recurring errors yet.")).toBeDefined();
  });

  it("refetches the map when Refresh is pressed", async () => {
    mockedFetch.mockResolvedValue(makeMap());
    const user = userEvent.setup();
    render(<ProgressMapPage />);

    await screen.findByText(/everyday phrasings/);
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it("shows the error state when a refresh fails", async () => {
    mockedFetch.mockResolvedValueOnce(makeMap());
    const user = userEvent.setup();
    render(<ProgressMapPage />);

    await screen.findByText(/everyday phrasings/);
    mockedFetch.mockRejectedValueOnce(new Error("boom"));
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("starts a session from a chosen region when interactive", async () => {
    mockedFetch.mockResolvedValue(makeMap());
    const onStartRegion = vi.fn();
    const user = userEvent.setup();
    render(<ProgressMapPage onStartRegion={onStartRegion} />);

    const tile = await screen.findByRole("button", {
      name: "Planning a meal — In progress, recommended next"
    });
    await user.click(tile);

    expect(onStartRegion).toHaveBeenCalledWith("k.meal");
  });

  it("renders cases as non-interactive tiles when no start handler is provided", async () => {
    mockedFetch.mockResolvedValue(makeMap());
    render(<ProgressMapPage />);

    const tile = await screen.findByLabelText("At the table — Owned");
    expect(tile.tagName).toBe("ARTICLE");
    expect(screen.queryByRole("button", { name: "At the table — Owned" })).toBeNull();
  });
});
