// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationChainingApi", () => ({
  completeChain: vi.fn(),
  fetchChaining: vi.fn(),
  reviewWholeWork: vi.fn(),
  startChain: vi.fn()
}));

vi.mock("./recitationPassageApi", () => ({
  listPassages: vi.fn()
}));

import type {
  RecitationChainingDto,
  RecitationPassageDto,
  RecitationPassageListDto
} from "@whetstone/contracts";

import { RecitationChainingPanel } from "./RecitationChainingPanel";
import { completeChain, fetchChaining, reviewWholeWork, startChain } from "./recitationChainingApi";
import { listPassages } from "./recitationPassageApi";

const mockedChaining = vi.mocked(fetchChaining);
const mockedComplete = vi.mocked(completeChain);
const mockedStart = vi.mocked(startChain);
const mockedReview = vi.mocked(reviewWholeWork);
const mockedList = vi.mocked(listPassages);

function makeChaining(overrides: Partial<RecitationChainingDto> = {}): RecitationChainingDto {
  return {
    activeChain: null,
    chainEligibility: { status: "not_eligible" },
    ownedPrefix: { ownedCount: 0, total: 3 },
    planEntryId: "plan-1",
    wholeWork: { due: false, dueAt: null, exists: false },
    wholeWorkOwned: false,
    ...overrides
  };
}

function makePassage(overrides: Partial<RecitationPassageDto> = {}): RecitationPassageDto {
  return {
    anchorStatus: "anchored",
    dueAt: "2026-01-01T00:00:00.000Z",
    endBlockEntryId: "block-a",
    endOffset: 10,
    entryId: "passage-0",
    lapses: 0,
    lastReviewedAt: null,
    orderIndex: 0,
    planEntryId: "plan-1",
    reps: 0,
    reviewCount: 0,
    sourceText: "First line.",
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
  mockedList.mockResolvedValue(
    listOf(makePassage(), makePassage({ entryId: "passage-1", sourceText: "Second line." }))
  );
});

afterEach(() => {
  cleanup();
});

describe("RecitationChainingPanel", () => {
  it("shows an error when the maintenance data fails to load", async () => {
    mockedChaining.mockRejectedValue(new Error("boom"));
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    expect(await screen.findByRole("alert")).toBeDefined();
  });

  it("shows the contiguous owned prefix, not a disconnected total", async () => {
    mockedChaining.mockResolvedValue(makeChaining({ ownedPrefix: { ownedCount: 2, total: 5 } }));
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    expect(
      await screen.findByText(/Owned from the start: 2 of 5 passages in a row\./)
    ).toBeDefined();
  });

  it("invites owning the first two passages when no chain is eligible", async () => {
    mockedChaining.mockResolvedValue(makeChaining());
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    expect(
      await screen.findByText(/Own the first two passages to start reciting them as a chain\./)
    ).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start chain" })).toBeNull();
  });

  it("starts a chain at the chosen boundary within the owned prefix", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        chainEligibility: { maxEndIndex: 2, status: "eligible" },
        ownedPrefix: { ownedCount: 3, total: 3 }
      })
    );
    mockedStart.mockResolvedValue({
      chainId: "chain-1",
      endOrderIndex: 1,
      passages: [],
      planEntryId: "plan-1",
      status: "active"
    });
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    const input = await screen.findByLabelText(/Chain through passage/);
    // Default is the furthest boundary (maxEndIndex 2 -> passage 3 in 1-based).
    expect((input as HTMLInputElement).value).toBe("3");
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.click(screen.getByRole("button", { name: "Start chain" }));

    // 1-based "2" maps to the 0-based end index 1.
    expect(mockedStart).toHaveBeenCalledWith("plan-1", 1);
  });

  it("completes an active chain as held when recall did not break", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        activeChain: {
          chainId: "chain-1",
          endOrderIndex: 1,
          passages: [
            { orderIndex: 0, passageEntryId: "passage-0", sourceText: "First line." },
            { orderIndex: 1, passageEntryId: "passage-1", sourceText: "Second line." }
          ],
          planEntryId: "plan-1",
          status: "active"
        }
      })
    );
    mockedComplete.mockResolvedValue({
      chainId: "chain-1",
      endOrderIndex: 1,
      passages: [],
      planEntryId: "plan-1",
      status: "completed"
    });
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Recall held throughout" }));

    expect(mockedComplete).toHaveBeenCalledWith("chain-1", { status: "held" });
  });

  it("completes an active chain by identifying the broken passage", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        activeChain: {
          chainId: "chain-1",
          endOrderIndex: 1,
          passages: [
            { orderIndex: 0, passageEntryId: "passage-0", sourceText: "First line." },
            { orderIndex: 1, passageEntryId: "passage-1", sourceText: "Second line." }
          ],
          planEntryId: "plan-1",
          status: "active"
        }
      })
    );
    mockedComplete.mockResolvedValue({
      chainId: "chain-1",
      endOrderIndex: 1,
      passages: [],
      planEntryId: "plan-1",
      status: "completed"
    });
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    const items = await screen.findAllByRole("listitem");
    await userEvent.click(within(items[1]!).getByRole("button", { name: "Recall broke here" }));

    expect(mockedComplete).toHaveBeenCalledWith("chain-1", {
      passageEntryId: "passage-1",
      status: "broke"
    });
  });

  it("offers whole-work maintenance once every passage is owned, held by default", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        ownedPrefix: { ownedCount: 2, total: 2 },
        wholeWorkOwned: true
      })
    );
    mockedReview.mockResolvedValue({ due: false, dueAt: null, exists: true });
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    expect(await screen.findByText("Whole-work maintenance")).toBeDefined();
    // Pick a break point, then change back to "held": the outcome must reset to held.
    const select = screen.getByLabelText(/Recall broke at/);
    await userEvent.selectOptions(select, "passage-1");
    await userEvent.selectOptions(select, "");
    await userEvent.click(screen.getByRole("button", { name: "Complete, with effort" }));

    expect(mockedReview).toHaveBeenCalledWith("plan-1", "good", { status: "held" });
  });

  it("reschedules only the aggregate on a whole-work lapse, resetting an identified passage", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        ownedPrefix: { ownedCount: 2, total: 2 },
        wholeWork: { due: true, dueAt: "2026-01-02T00:00:00.000Z", exists: true },
        wholeWorkOwned: true
      })
    );
    mockedReview.mockResolvedValue({ due: false, dueAt: null, exists: true });
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    const select = await screen.findByLabelText(/Recall broke at/);
    await userEvent.selectOptions(select, "passage-1");
    await userEvent.click(screen.getByRole("button", { name: "Couldn't continue" }));

    expect(mockedReview).toHaveBeenCalledWith("plan-1", "again", {
      passageEntryId: "passage-1",
      status: "broke"
    });
  });

  it("shows a scheduled-but-not-due whole work without a break-point picker when passages are absent", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        ownedPrefix: { ownedCount: 1, total: 1 },
        wholeWork: { due: false, dueAt: "2026-02-01T00:00:00.000Z", exists: true },
        wholeWorkOwned: false
      })
    );
    mockedList.mockResolvedValue(listOf());
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    expect(
      await screen.findByText(/Owned from the start: 1 of 1 passage in a row\./)
    ).toBeDefined();
    expect(screen.getByText("The whole work is scheduled; it is not due yet.")).toBeDefined();
    expect(screen.queryByLabelText(/Recall broke at/)).toBeNull();
  });

  it("surfaces an action error without losing the panel", async () => {
    mockedChaining.mockResolvedValue(
      makeChaining({
        chainEligibility: { maxEndIndex: 1, status: "eligible" },
        ownedPrefix: { ownedCount: 2, total: 2 }
      })
    );
    mockedStart.mockRejectedValue(new Error("offline"));
    render(<RecitationChainingPanel planEntryId="plan-1" />);

    await userEvent.click(await screen.findByRole("button", { name: "Start chain" }));

    expect(await screen.findByRole("alert")).toBeDefined();
  });
});
