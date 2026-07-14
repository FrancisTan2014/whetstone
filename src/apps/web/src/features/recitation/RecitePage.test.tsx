// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationPassageApi", () => ({
  getIntroductionStatus: vi.fn(),
  introduceNextPassage: vi.fn(),
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

import type {
  RecitationIntroductionStatusDto,
  RecitationPassageDto,
  RecitationPassageListDto
} from "@whetstone/contracts";

import { RecitePage } from "./RecitePage";
import { fetchChaining } from "./recitationChainingApi";
import {
  getIntroductionStatus,
  introduceNextPassage,
  listPassages,
  mergeNextPassage,
  seedPassages,
  splitPassage
} from "./recitationPassageApi";

const mockedChaining = vi.mocked(fetchChaining);
const mockedIntroStatus = vi.mocked(getIntroductionStatus);
const mockedIntroduce = vi.mocked(introduceNextPassage);
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

function makeIntroduction(
  overrides: Partial<RecitationIntroductionStatusDto> = {}
): RecitationIntroductionStatusDto {
  return {
    anyIntroduced: false,
    dailyCap: 3,
    dueCount: 0,
    introducedToday: 0,
    newPassageAvailable: true,
    nextQueued: { entryId: "passage-2", orderIndex: 0, sourceText: "The quick brown fox." },
    phase: "learning",
    planEntryId: "plan-1",
    reason: "available",
    remainingCapacity: 3,
    ...overrides
  };
}

function listOf(...passages: ReadonlyArray<RecitationPassageDto>): RecitationPassageListDto {
  return { passages: [...passages], planEntryId: "plan-1" };
}

beforeEach(() => {
  vi.clearAllMocks();
  // A non-learning default keeps the introduction panel silent for the segmentation-focused tests.
  mockedIntroStatus.mockResolvedValue(makeIntroduction({ reason: "not_learning" }));
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

  describe("introduction panel (#607)", () => {
    it("offers Start first passage for a learning plan with nothing introduced yet", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(makeIntroduction({ anyIntroduced: false }));
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByRole("button", { name: "Start first passage" })).toBeDefined();
      expect(screen.getByText(/Start reciting your first passage/)).toBeDefined();
    });

    it("labels the action New passage once a passage has been introduced, showing daily capacity", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({ anyIntroduced: true, introducedToday: 1, remainingCapacity: 2 })
      );
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByRole("button", { name: "New passage" })).toBeDefined();
      expect(screen.getByText("1 of 3 introduced today.")).toBeDefined();
    });

    it("directs the learner to Today when a single passage is due, offering no button", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({
          anyIntroduced: true,
          dueCount: 1,
          newPassageAvailable: false,
          reason: "due_work_remains"
        })
      );
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByText(/You have 1 passage to practise/)).toBeDefined();
      expect(screen.getByText(/Recite it on Today/)).toBeDefined();
      expect(screen.queryByRole("button", { name: "New passage" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start first passage" })).toBeNull();
    });

    it("pluralizes the due-work copy when several passages are due", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({
          anyIntroduced: true,
          dueCount: 2,
          newPassageAvailable: false,
          reason: "due_work_remains"
        })
      );
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByText(/You have 2 passages to practise/)).toBeDefined();
      expect(screen.getByText(/Recite them on Today/)).toBeDefined();
    });

    it("shows a calm cap state once the daily cap is reached", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({
          anyIntroduced: true,
          introducedToday: 3,
          newPassageAvailable: false,
          reason: "cap_reached",
          remainingCapacity: 0
        })
      );
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByText(/3 of 3 introduced today/)).toBeDefined();
      expect(screen.queryByRole("button", { name: "New passage" })).toBeNull();
    });

    it("shows an all-introduced state when no queued passage remains", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({
          anyIntroduced: true,
          newPassageAvailable: false,
          nextQueued: null,
          reason: "all_introduced"
        })
      );
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByText("Every passage has been introduced.")).toBeDefined();
      expect(screen.queryByRole("button", { name: "New passage" })).toBeNull();
    });

    it("introduces the next passage, refreshing both the status and the passage list", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(makeIntroduction({ anyIntroduced: false }));
      mockedIntroduce.mockResolvedValue({
        passage: makePassage(),
        status: makeIntroduction({
          anyIntroduced: true,
          dueCount: 1,
          newPassageAvailable: false,
          reason: "due_work_remains"
        })
      });
      render(<RecitePage planEntryId="plan-1" />);

      await screen.findByRole("button", { name: "Start first passage" });
      const listCallsBeforeIntroduce = mockedList.mock.calls.length;
      await userEvent.click(screen.getByRole("button", { name: "Start first passage" }));

      expect(mockedIntroduce).toHaveBeenCalledWith("plan-1");
      // The fresh status from the response is shown, and the passage list is re-fetched.
      expect(await screen.findByText(/You have 1 passage to practise/)).toBeDefined();
      expect(mockedList.mock.calls.length).toBeGreaterThan(listCallsBeforeIntroduce);
    });

    it("surfaces an error when the introduction status fails to load", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockRejectedValue(new Error("boom"));
      render(<RecitePage planEntryId="plan-1" />);

      expect(await screen.findByText(/Could not load the introduction/)).toBeDefined();
    });

    it("surfaces an error when introducing the next passage fails", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(makeIntroduction({ anyIntroduced: false }));
      mockedIntroduce.mockRejectedValue(new Error("boom"));
      render(<RecitePage planEntryId="plan-1" />);

      await userEvent.click(await screen.findByRole("button", { name: "Start first passage" }));

      expect(await screen.findByText(/Could not introduce the next passage/)).toBeDefined();
    });

    it("shows a loading indicator while the introduction status is pending", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockReturnValue(new Promise(() => {}));
      render(<RecitePage planEntryId="plan-1" />);

      // The passage list resolves and the panel mounts, but the introduction status stays pending.
      await screen.findByText("The quick brown fox.");
      expect(screen.getByText("Loading introduction…")).toBeDefined();
    });

    it("stays silent for a non-learning plan", async () => {
      mockedList.mockResolvedValue(listOf(makePassage()));
      mockedIntroStatus.mockResolvedValue(
        makeIntroduction({ phase: "maintenance", reason: "not_learning" })
      );
      render(<RecitePage planEntryId="plan-1" />);

      await screen.findByText("The quick brown fox.");
      expect(screen.queryByRole("button", { name: "New passage" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Start first passage" })).toBeNull();
      expect(screen.queryByLabelText("New passage")).toBeNull();
    });
  });
});
