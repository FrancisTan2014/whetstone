// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationHubApi", () => ({
  getRecitationHub: vi.fn(),
  pausePlan: vi.fn(),
  resumePlan: vi.fn()
}));

vi.mock("./recitationPassageApi", () => ({
  fetchDuePassageForPlan: vi.fn()
}));

// The real due-review card is exercised by RecitationReviewCard.test.tsx and the hub E2E; here it is
// stubbed to a minimal control so these tests assert the HUB's wiring — that it launches the session with
// the fetched passage and refreshes on completion — not the card's internals.
vi.mock("./RecitationReviewCard", () => ({
  RecitationReviewCard: ({
    onReviewed,
    passage
  }: {
    onReviewed: () => void;
    passage: { passageEntryId: string };
  }) => (
    <button onClick={onReviewed} type="button">
      complete review {passage.passageEntryId}
    </button>
  )
}));

import type {
  DueRecitationPassageDto,
  RecitationHubDto,
  RecitationIntroductionStatusDto,
  RecitationTodayActionDto,
  RecitationRoutineStageDto
} from "@whetstone/contracts";

import { RecitationHubPage } from "./RecitationHubPage";
import { getRecitationHub, pausePlan, resumePlan } from "./recitationHubApi";
import { fetchDuePassageForPlan } from "./recitationPassageApi";

const mockedGet = vi.mocked(getRecitationHub);
const mockedPause = vi.mocked(pausePlan);
const mockedResume = vi.mocked(resumePlan);
const mockedDue = vi.mocked(fetchDuePassageForPlan);

function makeDuePassage(overrides: Partial<DueRecitationPassageDto> = {}): DueRecitationPassageDto {
  return {
    anchorStatus: "anchored",
    context: "Chapter 1",
    defaultCueStrength: "opening",
    passageEntryId: "passage-1",
    planEntryId: "plan-1",
    precedingText: null,
    supportLevel: "full",
    targetText: "To be, or not to be.",
    workTitle: "Meditations",
    ...overrides
  };
}

function makeIntro(
  overrides: Partial<RecitationIntroductionStatusDto> = {}
): RecitationIntroductionStatusDto {
  return {
    anyIntroduced: true,
    dailyCap: 3,
    dueCount: 0,
    introducedToday: 0,
    newPassageAvailable: false,
    nextQueued: null,
    phase: "learning",
    planEntryId: "plan-1",
    reason: "cap_reached",
    remainingCapacity: 0,
    ...overrides
  };
}

function makeHub(
  overrides: Partial<Extract<RecitationHubDto, { status: "active" }>> = {},
  intro: Partial<RecitationIntroductionStatusDto> = {}
): Extract<RecitationHubDto, { status: "active" }> {
  return {
    due: { dueCount: 0, overdueCount: 0 },
    introduction: makeIntro(intro),
    passages: { introducedCount: 4, totalCount: 12 },
    paused: false,
    phase: "learning",
    planEntryId: "plan-1",
    primaryAction: "none" as RecitationTodayActionDto,
    stage: "learn_passage" as RecitationRoutineStageDto,
    status: "active",
    workTitle: "Meditations",
    ...overrides
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <RecitationHubPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("RecitationHubPage", () => {
  it("shows a quiet loading indicator while the hub resolves", () => {
    mockedGet.mockReturnValue(new Promise(() => {}));
    renderPage();
    expect(screen.getByRole("status").textContent).toContain("Loading your recitation");
  });

  it("shows a calm inline error when the hub fails to load", async () => {
    mockedGet.mockRejectedValue(new Error("network"));
    renderPage();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t load your recitation");
  });

  it("shows the restrained empty state with a Library link when there is no plan", async () => {
    mockedGet.mockResolvedValue({ status: "no_plan" });
    renderPage();
    expect(await screen.findByText(/no recitation routine yet/i)).toBeDefined();
    expect(screen.getByRole("link", { name: "Go to Library" }).getAttribute("href")).toBe(
      "/library"
    );
  });

  it("projects an active learning plan with owned progress as human copy and a due-first action", async () => {
    mockedGet.mockResolvedValue(
      makeHub({
        due: { dueCount: 2, overdueCount: 1 },
        passages: { introducedCount: 4, totalCount: 12 },
        primaryAction: "due_passage",
        stage: "learn_passage"
      })
    );
    renderPage();

    expect(await screen.findByRole("heading", { name: "Meditations" })).toBeDefined();
    expect(screen.getByText("4 of 12 passages introduced")).toBeDefined();
    expect(screen.getByText("Stage: Learning passages")).toBeDefined();

    const due = screen.getByLabelText("Due review");
    expect(within(due).getByText("2 due · 1 overdue")).toBeDefined();
    // The due action launches the real review session inline — it is a control, not a link to the
    // segmentation surface.
    expect(within(due).getByRole("button", { name: "Start review" })).toBeDefined();
    expect(within(due).queryByRole("link")).toBeNull();
  });

  it("shows a due count without the overdue clause when nothing is overdue", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 1, overdueCount: 0 }, primaryAction: "due_passage" })
    );
    renderPage();
    const due = await screen.findByLabelText("Due review");
    expect(within(due).getByText("1 due")).toBeDefined();
    expect(within(due).queryByText(/overdue/)).toBeNull();
  });

  it("runs the due review session inline and refreshes the hub when a review completes", async () => {
    mockedGet
      .mockResolvedValueOnce(
        makeHub({
          due: { dueCount: 1, overdueCount: 0 },
          planEntryId: "plan-hub",
          primaryAction: "due_passage"
        })
      )
      .mockResolvedValueOnce(makeHub({ primaryAction: "none" }));
    mockedDue.mockResolvedValue(makeDuePassage({ passageEntryId: "passage-7" }));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start review" }));

    // The fetched due passage is handed to the shared review card (stubbed here), and it is fetched for
    // the SAME plan the hub projects — never the earliest-due passage across other plans (#608 review).
    const complete = await screen.findByRole("button", { name: "complete review passage-7" });
    expect(mockedDue).toHaveBeenCalledTimes(1);
    expect(mockedDue).toHaveBeenCalledWith("plan-hub");

    // Completing the review refreshes the hub, which re-decides the next action (now caught up).
    await userEvent.click(complete);
    expect(await screen.findByLabelText("Caught up")).toBeDefined();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Due review")).toBeNull();
  });

  it("resolves to a calm caught-up line when the due passage cleared before it was fetched", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 1, overdueCount: 0 }, primaryAction: "due_passage" })
    );
    mockedDue.mockResolvedValue(null);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start review" }));
    const due = screen.getByLabelText("Due review");
    expect(await within(due).findByText(/Nothing to recite/i)).toBeDefined();
    expect(within(due).queryByRole("button", { name: "Start review" })).toBeNull();
  });

  it("surfaces an inline error when the due passage fails to load, keeping the hub", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 1, overdueCount: 0 }, primaryAction: "due_passage" })
    );
    mockedDue.mockRejectedValue(new Error("network"));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start review" }));
    const due = screen.getByLabelText("Due review");
    expect(await within(due).findByRole("alert")).toBeDefined();
    // The session can be retried; the hub itself is intact.
    expect(within(due).getByRole("button", { name: "Start review" })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Meditations" })).toBeDefined();
  });

  it("shows a quiet loading line while the due passage resolves", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 1, overdueCount: 0 }, primaryAction: "due_passage" })
    );
    mockedDue.mockReturnValue(new Promise(() => {}));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start review" }));
    expect(screen.getByText(/Finding your next passage/i)).toBeDefined();
  });

  it("labels the chain and whole-work primary actions from the stage", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 3, overdueCount: 1 }, primaryAction: "chain", stage: "chain" })
    );
    renderPage();
    expect(await screen.findByRole("link", { name: "Continue chain" })).toBeDefined();
    expect(screen.getByText("Stage: Chaining passages")).toBeDefined();
    expect(screen.getByText("3 due · 1 overdue")).toBeDefined();

    cleanup();
    mockedGet.mockResolvedValue(
      makeHub({
        due: { dueCount: 1, overdueCount: 0 },
        phase: "maintenance",
        primaryAction: "whole_work",
        stage: "whole_work_maintenance"
      })
    );
    renderPage();
    expect(await screen.findByRole("link", { name: "Whole-work review" })).toBeDefined();
    expect(screen.getByText("Stage: Whole-work maintenance")).toBeDefined();
  });

  it("offers a New passage affordance with today's capacity when introduction is available", async () => {
    mockedGet.mockResolvedValue(
      makeHub(
        { primaryAction: "none" },
        {
          anyIntroduced: true,
          introducedToday: 1,
          newPassageAvailable: true,
          reason: "available",
          remainingCapacity: 2
        }
      )
    );
    renderPage();
    const panel = await screen.findByLabelText("New passage");
    expect(within(panel).getByText("1 of 3 introduced today · 2 left")).toBeDefined();
    expect(within(panel).getByRole("link", { name: "New passage" }).getAttribute("href")).toBe(
      "#/recite?plan=plan-1"
    );
    // With a new passage available, the learner is not "caught up".
    expect(screen.queryByLabelText("Caught up")).toBeNull();
  });

  it("labels the first introduction and omits remaining capacity when none is left", async () => {
    mockedGet.mockResolvedValue(
      makeHub(
        { primaryAction: "none" },
        {
          anyIntroduced: false,
          introducedToday: 3,
          newPassageAvailable: true,
          reason: "available",
          remainingCapacity: 0
        }
      )
    );
    renderPage();
    const panel = await screen.findByLabelText("New passage");
    expect(within(panel).getByRole("link", { name: "Start first passage" })).toBeDefined();
    expect(within(panel).getByText("3 of 3 introduced today")).toBeDefined();
    expect(within(panel).queryByText(/left/)).toBeNull();
  });

  it("shows a calm caught-up state when nothing is due and nothing is to introduce", async () => {
    mockedGet.mockResolvedValue(makeHub({ primaryAction: "none" }));
    renderPage();
    const caughtUp = await screen.findByLabelText("Caught up");
    expect(within(caughtUp).getByText(/caught up for today/i)).toBeDefined();
    expect(screen.queryByLabelText("Due review")).toBeNull();
    expect(screen.queryByLabelText("New passage")).toBeNull();
  });

  it("shows a paused banner and resumes from the returned hub", async () => {
    mockedGet.mockResolvedValue(makeHub({ paused: true, primaryAction: "none" }));
    mockedResume.mockResolvedValue(makeHub({ paused: false, primaryAction: "none" }));
    renderPage();

    expect(await screen.findByText(/this routine is paused/i)).toBeDefined();
    // A paused plan withholds obligations and the new-passage affordance.
    expect(screen.queryByLabelText("Due review")).toBeNull();
    expect(screen.queryByRole("button", { name: "Pause routine" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Resume routine" }));
    expect(mockedResume).toHaveBeenCalledWith("plan-1");
    expect(await screen.findByRole("button", { name: "Pause routine" })).toBeDefined();
    expect(screen.queryByText(/this routine is paused/i)).toBeNull();
  });

  it("pauses an active plan from the returned hub", async () => {
    mockedGet.mockResolvedValue(makeHub({ primaryAction: "none" }));
    mockedPause.mockResolvedValue(makeHub({ paused: true, primaryAction: "none" }));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pause routine" }));
    expect(mockedPause).toHaveBeenCalledWith("plan-1");
    expect(await screen.findByText(/this routine is paused/i)).toBeDefined();
  });

  it("surfaces a transient failure inline without blanking the resolved hub", async () => {
    mockedGet.mockResolvedValue(makeHub({ primaryAction: "none" }));
    mockedPause.mockRejectedValue(new Error("boom"));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Pause routine" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn’t update the routine");
    // The resolved hub is still on screen.
    expect(screen.getByRole("heading", { name: "Meditations" })).toBeDefined();
  });

  it("activates the pause control from the keyboard", async () => {
    mockedGet.mockResolvedValue(makeHub({ primaryAction: "none" }));
    mockedPause.mockResolvedValue(makeHub({ paused: true, primaryAction: "none" }));
    renderPage();

    const pause = await screen.findByRole("button", { name: "Pause routine" });
    pause.focus();
    expect(document.activeElement).toBe(pause);
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(mockedPause).toHaveBeenCalledWith("plan-1"));
  });
});
