// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recallApi", () => ({
  fetchDueRecall: vi.fn(),
  gradeRecall: vi.fn(),
  snoozeRecall: vi.fn()
}));

import type { RecallItemDto } from "@whetstone/contracts";

import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";
import { RecallPage } from "./RecallPage";

const mockedFetch = vi.mocked(fetchDueRecall);
const mockedGrade = vi.mocked(gradeRecall);
const mockedSnooze = vi.mocked(snoozeRecall);

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

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("RecallPage", () => {
  it("shows a loading state while due items load", () => {
    mockedFetch.mockReturnValue(new Promise<ReadonlyArray<RecallItemDto>>(() => {}));
    render(<RecallPage />);
    expect(screen.getByText("Gathering what's due…")).toBeDefined();
  });

  it("shows an error state when due items cannot load", async () => {
    mockedFetch.mockRejectedValue(new Error("boom"));
    render(<RecallPage />);
    expect(await screen.findByText(/Could not load your recall items/)).toBeDefined();
  });

  it("shows the calm empty state when nothing is due", async () => {
    mockedFetch.mockResolvedValue([]);
    render(<RecallPage />);
    expect(await screen.findByText(/Nothing due/)).toBeDefined();
    expect(screen.queryByRole("list", { name: "Items due to recall" })).toBeNull();
  });

  it("renders each due item with its text and gloss", async () => {
    mockedFetch.mockResolvedValue([
      makeItem({ gloss: "to reveal a secret" }),
      makeItem({ gloss: null, id: "r2", text: "by and large" })
    ]);
    render(<RecallPage />);

    expect(await screen.findByText("spill the beans")).toBeDefined();
    expect(screen.getByText("to reveal a secret")).toBeDefined();
    expect(screen.getByText("by and large")).toBeDefined();
  });

  it("grades an item and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([makeItem(), makeItem({ id: "r2", text: "by and large" })]);
    mockedGrade.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    const firstCard = (await screen.findByText("spill the beans")).closest("li");
    expect(firstCard).not.toBeNull();
    await user.click(within(firstCard as HTMLElement).getByRole("button", { name: "Good" }));

    expect(mockedGrade).toHaveBeenCalledWith("r1", "good");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(screen.getByText("by and large")).toBeDefined();
  });

  it("snoozes an item and removes it from today's list", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedSnooze.mockResolvedValue(makeItem());
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(mockedSnooze).toHaveBeenCalledWith("r1");
    expect(screen.queryByText("spill the beans")).toBeNull();
    expect(await screen.findByText(/Nothing due/)).toBeDefined();
  });

  it("surfaces an action error and keeps the item when grading fails", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedGrade.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Again" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });

  it("surfaces an action error and keeps the item when snoozing fails", async () => {
    mockedFetch.mockResolvedValue([makeItem()]);
    mockedSnooze.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<RecallPage />);

    await screen.findByText("spill the beans");
    await user.click(screen.getByRole("button", { name: "Snooze" }));

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(screen.getByText("spill the beans")).toBeDefined();
  });
});
