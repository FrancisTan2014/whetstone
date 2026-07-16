// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationSessionApi", () => ({
  getRecitationSession: vi.fn()
}));

vi.mock("./recitationPassageApi", () => ({
  fetchDuePassageForPlan: vi.fn(),
  getIntroductionStatus: vi.fn(),
  introduceNextPassage: vi.fn(),
  listPassages: vi.fn()
}));

vi.mock("./recitationChainingApi", () => ({
  completeChain: vi.fn(),
  fetchChaining: vi.fn(),
  reviewWholeWork: vi.fn(),
  startChain: vi.fn()
}));

vi.mock("./RecitationReviewCard", () => ({
  RecitationReviewCard: ({
    onReviewed,
    passage
  }: {
    onReviewed: () => void;
    passage: { passageEntryId: string };
  }) => (
    <button onClick={onReviewed} type="button">
      reviewed {passage.passageEntryId}
    </button>
  )
}));

import type {
  DueRecitationPassageDto,
  RecitationChainingDto,
  RecitationIntroductionStatusDto,
  RecitationPassageDto,
  RecitationPassageListDto,
  RecitationSessionDto
} from "@whetstone/contracts";

import { RecitationSessionPanel } from "./RecitationSessionPanel";
import { completeChain, fetchChaining, reviewWholeWork, startChain } from "./recitationChainingApi";
import {
  fetchDuePassageForPlan,
  getIntroductionStatus,
  introduceNextPassage,
  listPassages
} from "./recitationPassageApi";
import { getRecitationSession } from "./recitationSessionApi";

const mockedSession = vi.mocked(getRecitationSession);
const mockedDue = vi.mocked(fetchDuePassageForPlan);
const mockedIntro = vi.mocked(getIntroductionStatus);
const mockedIntroduce = vi.mocked(introduceNextPassage);
const mockedList = vi.mocked(listPassages);
const mockedChaining = vi.mocked(fetchChaining);
const mockedComplete = vi.mocked(completeChain);
const mockedReviewWhole = vi.mocked(reviewWholeWork);
const mockedStart = vi.mocked(startChain);

function makeSession(
  overrides: Partial<Extract<RecitationSessionDto, { status: "active" }>> = {}
): Extract<RecitationSessionDto, { status: "active" }> {
  return {
    chainAvailable: false,
    due: { dueCount: 0, nextDueAt: null, overdueCount: 0 },
    hasDuePassage: false,
    newPassage: {
      anyIntroduced: true,
      available: false,
      dailyCap: 3,
      introducedToday: 1,
      remainingCapacity: 2
    },
    planEntryId: "plan-1",
    status: "active",
    step: "clear",
    wholeWorkDue: false,
    workTitle: "Meditations",
    ...overrides
  };
}

function makeDuePassage(overrides: Partial<DueRecitationPassageDto> = {}): DueRecitationPassageDto {
  return {
    anchorStatus: "anchored",
    context: "Chapter 1",
    defaultCueStrength: "opening",
    passageEntryId: "passage-1",
    planEntryId: "plan-1",
    precedingText: null,
    supportLevel: "full",
    targetText: "Remember this.",
    workTitle: "Meditations",
    ...overrides
  };
}

function makePassage(overrides: Partial<RecitationPassageDto> = {}): RecitationPassageDto {
  return {
    anchorStatus: "anchored",
    dueAt: "2026-01-01T00:00:00.000Z",
    endBlockEntryId: "block-a",
    endOffset: 10,
    entryId: "passage-1",
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

function makeChaining(overrides: Partial<RecitationChainingDto> = {}): RecitationChainingDto {
  return {
    activeChain: null,
    chainEligibility: { maxEndIndex: 1, status: "eligible" },
    ownedPrefix: { ownedCount: 2, total: 2 },
    planEntryId: "plan-1",
    wholeWork: { due: true, dueAt: "2026-07-01T00:00:00.000Z", exists: true },
    wholeWorkOwned: true,
    ...overrides
  };
}

function makeIntroduction(
  overrides: Partial<RecitationIntroductionStatusDto> = {}
): RecitationIntroductionStatusDto {
  return {
    anyIntroduced: true,
    dailyCap: 3,
    dueCount: 0,
    introducedToday: 1,
    newPassageAvailable: true,
    nextQueued: { entryId: "passage-2", orderIndex: 1, sourceText: "Second line." },
    phase: "learning",
    planEntryId: "plan-1",
    reason: "available",
    remainingCapacity: 2,
    ...overrides
  };
}

function renderPanel(onExit = vi.fn()): void {
  render(<RecitationSessionPanel onExit={onExit} planEntryId="plan-1" />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedSession.mockResolvedValue(makeSession());
  mockedDue.mockResolvedValue(makeDuePassage());
  mockedChaining.mockResolvedValue(makeChaining());
  mockedList.mockResolvedValue(listOf(makePassage(), makePassage({ entryId: "passage-2" })));
  mockedIntro.mockResolvedValue(makeIntroduction());
  mockedIntroduce.mockResolvedValue({
    passage: makePassage({ entryId: "passage-2" }),
    status: makeIntroduction({ anyIntroduced: true, introducedToday: 2, remainingCapacity: 1 })
  });
  mockedStart.mockResolvedValue({
    chainId: "chain-1",
    endOrderIndex: 1,
    passages: [],
    planEntryId: "plan-1",
    status: "active"
  });
  mockedComplete.mockResolvedValue({
    chainId: "chain-1",
    endOrderIndex: 1,
    passages: [],
    planEntryId: "plan-1",
    status: "completed"
  });
  mockedReviewWhole.mockResolvedValue({ due: false, dueAt: null, exists: true });
});

afterEach(() => {
  cleanup();
});

describe("RecitationSessionPanel", () => {
  it("shows loading, error, and no-plan states from the session API", async () => {
    mockedSession.mockReturnValueOnce(new Promise(() => {}));
    renderPanel();
    expect(screen.getByRole("status").textContent).toContain("Loading recitation session");
    cleanup();

    mockedSession.mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
    cleanup();

    mockedSession.mockResolvedValueOnce({ status: "no_plan" });
    renderPanel();
    expect(await screen.findByText(/No recitation routine is ready/)).toBeDefined();
  });

  it("omits the exit affordance when no exit callback is supplied", async () => {
    render(<RecitationSessionPanel planEntryId="plan-1" />);

    expect(await screen.findByText("Due recitation clear")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Exit session" })).toBeNull();
  });

  it("runs a due passage step and reloads after the review card records", async () => {
    mockedSession
      .mockResolvedValueOnce(
        makeSession({
          due: { dueCount: 1, nextDueAt: "2026-07-01T06:00:00.000Z", overdueCount: 0 },
          hasDuePassage: true
        })
      )
      .mockResolvedValueOnce(makeSession());
    renderPanel();

    expect(await screen.findByText(/Session for/)).toBeDefined();
    expect(mockedDue).toHaveBeenCalledWith("plan-1");
    await userEvent.click(await screen.findByRole("button", { name: "reviewed passage-1" }));

    await waitFor(() => expect(mockedSession).toHaveBeenCalledTimes(2));
  });

  it("pins the shown Work on reload and advances to the next Work once it clears", async () => {
    mockedSession
      .mockResolvedValueOnce(
        makeSession({
          due: { dueCount: 2, nextDueAt: "2026-07-01T06:00:00.000Z", overdueCount: 0 },
          hasDuePassage: true,
          planEntryId: "plan-1",
          workTitle: "First"
        })
      )
      .mockResolvedValueOnce(
        makeSession({
          due: { dueCount: 1, nextDueAt: "2026-07-01T07:00:00.000Z", overdueCount: 0 },
          hasDuePassage: true,
          planEntryId: "plan-2",
          workTitle: "Second"
        })
      );
    mockedDue.mockResolvedValue(makeDuePassage({ planEntryId: "plan-2" }));
    renderPanel();

    expect(await screen.findByText("First")).toBeDefined();
    expect(mockedDue).toHaveBeenCalledWith("plan-1");
    await userEvent.click(await screen.findByRole("button", { name: "reviewed passage-1" }));

    // The reload pins the Work that was on screen so a rating never context-switches mid-Work; once that
    // Work clears, the aggregate hands the routine to the next Work and its steps fetch against it.
    await waitFor(() => expect(mockedSession).toHaveBeenLastCalledWith("plan-1"));
    expect(await screen.findByText("Second")).toBeDefined();
    await waitFor(() => expect(mockedDue).toHaveBeenCalledWith("plan-2"));
  });

  it("surfaces due-passage loading failures and already-cleared races", async () => {
    mockedSession.mockResolvedValue(makeSession({ hasDuePassage: true }));
    mockedDue.mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load your due passage"
    );
    cleanup();

    mockedSession.mockResolvedValue(makeSession({ hasDuePassage: true }));
    mockedDue.mockResolvedValueOnce(null);
    renderPanel();
    expect(await screen.findByText(/already clear/)).toBeDefined();
  });

  it("presents whole-work before chain and records the aggregate outcome", async () => {
    mockedSession.mockResolvedValue(makeSession({ chainAvailable: true, wholeWorkDue: true }));
    renderPanel();

    expect(await screen.findByText("Whole-work maintenance")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start chain" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Complete, with effort" }));

    expect(mockedReviewWhole).toHaveBeenCalledWith("plan-1", "good", { status: "held" });
  });

  it("starts a chain and can dismiss the chain offer to move on", async () => {
    mockedSession.mockResolvedValue(
      makeSession({
        chainAvailable: true,
        newPassage: { ...makeSession().newPassage, available: true }
      })
    );
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Start chain" }));
    expect(mockedStart).toHaveBeenCalledWith("plan-1", 1);
    cleanup();

    mockedSession.mockResolvedValue(
      makeSession({
        chainAvailable: true,
        newPassage: { ...makeSession().newPassage, available: true }
      })
    );
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Done with chains" }));
    expect(await screen.findByRole("button", { name: "New passage" })).toBeDefined();
  });

  it("advances past chains automatically after an active chain is completed", async () => {
    mockedSession.mockResolvedValue(
      makeSession({
        chainAvailable: true,
        newPassage: { ...makeSession().newPassage, available: true }
      })
    );
    mockedChaining.mockResolvedValue(
      makeChaining({
        activeChain: {
          chainId: "chain-1",
          endOrderIndex: 1,
          passages: [
            { orderIndex: 0, passageEntryId: "passage-1", sourceText: "First line." },
            { orderIndex: 1, passageEntryId: "passage-2", sourceText: "Second line." }
          ],
          planEntryId: "plan-1",
          status: "active"
        }
      })
    );
    renderPanel();
    const chain = await screen.findByRole("list", { name: "Chain passages" });
    await userEvent.click(within(chain).getAllByRole("button", { name: "Recall broke here" })[1]!);
    expect(mockedComplete).toHaveBeenCalledWith("chain-1", {
      passageEntryId: "passage-2",
      status: "broke"
    });

    // No manual "Done with chains" click — completing the active chain ends the chain step for this
    // pass even though the still-owned prefix stays eligible on reload.
    expect(await screen.findByRole("button", { name: "New passage" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Done with chains" })).toBeNull();
  });

  it("surfaces maintenance load and action errors without losing the step", async () => {
    mockedSession.mockResolvedValue(makeSession({ chainAvailable: true }));
    mockedChaining.mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not load this session step"
    );
    cleanup();

    mockedSession.mockResolvedValue(makeSession({ chainAvailable: true }));
    mockedChaining.mockResolvedValue(makeChaining());
    mockedStart.mockRejectedValueOnce(new Error("offline"));
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Start chain" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not update");
  });

  it("introduces a new passage, can skip it to completion, and exits", async () => {
    const onExit = vi.fn();
    mockedSession
      .mockResolvedValueOnce(
        makeSession({ newPassage: { ...makeSession().newPassage, available: true } })
      )
      .mockResolvedValueOnce(makeSession());
    renderPanel(onExit);

    await userEvent.click(await screen.findByRole("button", { name: "New passage" }));
    expect(mockedIntroduce).toHaveBeenCalledWith("plan-1");
    await waitFor(() => expect(mockedSession).toHaveBeenCalledTimes(2));
    await userEvent.click(screen.getByRole("button", { name: "Exit session" }));
    expect(onExit).toHaveBeenCalledTimes(1);

    cleanup();
    mockedSession.mockResolvedValue(
      makeSession({ newPassage: { ...makeSession().newPassage, available: true } })
    );
    renderPanel();
    await userEvent.click(await screen.findByRole("button", { name: "Skip new passage for now" }));
    expect(await screen.findByText("Due recitation clear")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "New passage" }));
    await waitFor(() => expect(mockedIntroduce).toHaveBeenCalledWith("plan-1"));
  });

  it("drains to the next due passage after one is reviewed, without reopening the session", async () => {
    mockedSession.mockResolvedValue(
      makeSession({
        due: { dueCount: 2, nextDueAt: "2026-07-01T06:00:00.000Z", overdueCount: 0 },
        hasDuePassage: true
      })
    );
    mockedDue
      .mockResolvedValueOnce(makeDuePassage({ passageEntryId: "passage-1" }))
      .mockResolvedValueOnce(makeDuePassage({ passageEntryId: "passage-2" }));
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "reviewed passage-1" }));

    expect(await screen.findByRole("button", { name: "reviewed passage-2" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "reviewed passage-1" })).toBeNull();
    expect(mockedDue).toHaveBeenCalledTimes(2);
  });

  it("advances from chain start to the active chain in place after Start chain", async () => {
    mockedSession.mockResolvedValue(makeSession({ chainAvailable: true }));
    mockedChaining.mockResolvedValueOnce(makeChaining()).mockResolvedValueOnce(
      makeChaining({
        activeChain: {
          chainId: "chain-1",
          endOrderIndex: 1,
          passages: [
            { orderIndex: 0, passageEntryId: "passage-1", sourceText: "First line." },
            { orderIndex: 1, passageEntryId: "passage-2", sourceText: "Second line." }
          ],
          planEntryId: "plan-1",
          status: "active"
        }
      })
    );
    renderPanel();

    await userEvent.click(await screen.findByRole("button", { name: "Start chain" }));

    expect(mockedStart).toHaveBeenCalledWith("plan-1", 1);
    expect(await screen.findByRole("list", { name: "Chain passages" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Start chain" })).toBeNull();
    expect(mockedChaining).toHaveBeenCalledTimes(2);
  });
});
