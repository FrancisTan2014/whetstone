// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationPassageApi", () => ({
  listPassages: vi.fn(),
  mergeNextPassage: vi.fn(),
  seedPassages: vi.fn(),
  splitPassage: vi.fn()
}));

vi.mock("./recitationChainingApi", () => ({
  completeChain: vi.fn(),
  fetchChaining: vi.fn(),
  reviewWholeWork: vi.fn(),
  startChain: vi.fn()
}));

import type { RecitationPassageDto, RecitationPassageListDto } from "@whetstone/contracts";

import { RecitePage } from "./RecitePage";
import { fetchChaining } from "./recitationChainingApi";
import { listPassages, mergeNextPassage, seedPassages, splitPassage } from "./recitationPassageApi";

const mockedChaining = vi.mocked(fetchChaining);
const mockedList = vi.mocked(listPassages);
const mockedMerge = vi.mocked(mergeNextPassage);
const mockedSeed = vi.mocked(seedPassages);
const mockedSplit = vi.mocked(splitPassage);

function makePassage(overrides: Partial<RecitationPassageDto> = {}): RecitationPassageDto {
  return {
    anchorStatus: "anchored",
    dueAt: "2026-01-01T00:00:00.000Z",
    endBlockEntryId: "block-a",
    endOffset: 20,
    entryId: "passage-2",
    lapses: 0,
    lastReviewedAt: null,
    orderIndex: 0,
    planEntryId: "plan-1",
    reps: 0,
    reviewCount: 0,
    sourceText: "The quick brown fox.",
    startBlockEntryId: "block-a",
    startOffset: 0,
    status: "active",
    ...overrides
  };
}

function listOf(...passages: ReadonlyArray<RecitationPassageDto>): RecitationPassageListDto {
  return { passages: [...passages], planEntryId: "plan-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedChaining.mockResolvedValue({
    activeChain: null,
    chainEligibility: { status: "not_eligible" },
    ownedPrefix: { ownedCount: 0, total: 2 },
    planEntryId: "plan-1",
    wholeWork: { due: false, dueAt: null, exists: false },
    wholeWorkOwned: false
  });
});

afterEach(() => {
  cleanup();
});

describe("RecitePage", () => {
  it("prompts to open a routine when no plan is given", () => {
    render(<RecitePage />);

    expect(screen.getByText(/Open a recitation routine/)).toBeDefined();
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("shows an error when the passages fail to load", async () => {
    mockedList.mockRejectedValue(new Error("boom"));
    render(<RecitePage planEntryId="plan-1" />);

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("offers to divide an undivided work, then lists the seeded passages", async () => {
    mockedList.mockResolvedValue(listOf());
    mockedSeed.mockResolvedValue(listOf(makePassage(), makePassage({ entryId: "passage-3" })));
    render(<RecitePage planEntryId="plan-1" />);

    const seedButton = await screen.findByRole("button", { name: "Divide into passages" });
    await userEvent.click(seedButton);

    expect(mockedSeed).toHaveBeenCalledWith("plan-1");
    expect(screen.getAllByText(/reviewed 0 times/)).toHaveLength(2);
  });

  it("lists passages with singular review progress", async () => {
    mockedList.mockResolvedValue(listOf(makePassage({ reviewCount: 1 })));
    render(<RecitePage planEntryId="plan-1" />);

    expect(await screen.findByText(/reviewed 1 time$/)).toBeDefined();
  });

  it("splits a single-block passage at the chosen character position", async () => {
    mockedList.mockResolvedValue(
      listOf(makePassage({ sourceText: "Jumps over the lazy dog.", startOffset: 3 }))
    );
    mockedSplit.mockResolvedValue(listOf(makePassage(), makePassage({ entryId: "passage-3" })));
    render(<RecitePage planEntryId="plan-1" />);

    const input = await screen.findByLabelText(/Split at character/);
    await userEvent.clear(input);
    await userEvent.type(input, "5");
    await userEvent.click(screen.getByRole("button", { name: "Split" }));

    expect(mockedSplit).toHaveBeenCalledWith("passage-2", "block-a", 8);
  });

  it("does not offer a split control for a multi-block passage", async () => {
    mockedList.mockResolvedValue(listOf(makePassage({ endBlockEntryId: "block-b" })));
    render(<RecitePage planEntryId="plan-1" />);

    await screen.findByText("The quick brown fox.");
    expect(screen.queryByRole("button", { name: "Split" })).toBeNull();
  });

  it("merges a passage with the next and hides merge on the last passage", async () => {
    mockedList.mockResolvedValue(
      listOf(makePassage(), makePassage({ entryId: "passage-3", orderIndex: 1 }))
    );
    mockedMerge.mockResolvedValue(listOf(makePassage()));
    render(<RecitePage planEntryId="plan-1" />);

    const items = await screen.findAllByRole("listitem");
    expect(within(items[1]!).queryByRole("button", { name: "Merge with next" })).toBeNull();

    await userEvent.click(within(items[0]!).getByRole("button", { name: "Merge with next" }));

    expect(mockedMerge).toHaveBeenCalledWith("passage-2");
  });

  it("surfaces an error when an edit fails", async () => {
    mockedList.mockResolvedValue(listOf(makePassage(), makePassage({ entryId: "passage-3" })));
    mockedMerge.mockRejectedValue(new Error("boom"));
    render(<RecitePage planEntryId="plan-1" />);

    const items = await screen.findAllByRole("listitem");
    await userEvent.click(within(items[0]!).getByRole("button", { name: "Merge with next" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });
});
