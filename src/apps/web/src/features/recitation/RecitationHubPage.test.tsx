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

vi.mock("./RecitationSessionPanel", () => ({
  RecitationSessionPanel: ({
    onExit,
    planEntryId
  }: {
    onExit: () => void;
    planEntryId: string;
  }) => (
    <div aria-label="Recitation session" role="group">
      <p>session for {planEntryId}</p>
      <button onClick={onExit} type="button">
        Exit session
      </button>
    </div>
  )
}));

import type {
  RecitationHubDto,
  RecitationIntroductionStatusDto,
  RecitationTodayActionDto,
  RecitationRoutineStageDto
} from "@whetstone/contracts";

import { RecitationHubPage } from "./RecitationHubPage";
import { getRecitationHub, pausePlan, resumePlan } from "./recitationHubApi";

const mockedGet = vi.mocked(getRecitationHub);
const mockedPause = vi.mocked(pausePlan);
const mockedResume = vi.mocked(resumePlan);

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

    const session = screen.getByLabelText("Session");
    expect(within(session).getByText("2 due · 1 overdue")).toBeDefined();
    expect(within(session).getByText("Next: Start review")).toBeDefined();
    expect(within(session).getByRole("button", { name: "Start session" })).toBeDefined();
    expect(within(session).queryByRole("link")).toBeNull();
  });

  it("shows a due count without the overdue clause when nothing is overdue", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 1, overdueCount: 0 }, primaryAction: "due_passage" })
    );
    renderPage();
    const session = await screen.findByLabelText("Session");
    expect(within(session).getByText("1 due")).toBeDefined();
    expect(within(session).queryByText(/overdue/)).toBeNull();
  });

  it("starts the complete recitation session inline and refreshes the hub on exit", async () => {
    mockedGet
      .mockResolvedValueOnce(
        makeHub({
          due: { dueCount: 1, overdueCount: 0 },
          planEntryId: "plan-hub",
          primaryAction: "due_passage"
        })
      )
      .mockResolvedValueOnce(makeHub({ primaryAction: "none" }));
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Start session" }));

    const session = await screen.findByLabelText("Recitation session");
    expect(within(session).getByText("session for plan-hub")).toBeDefined();

    await userEvent.click(within(session).getByRole("button", { name: "Exit session" }));
    expect(await screen.findByLabelText("Caught up")).toBeDefined();
    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText("Session")).toBeNull();
  });

  it("labels the chain and whole-work primary actions from the stage", async () => {
    mockedGet.mockResolvedValue(
      makeHub({ due: { dueCount: 3, overdueCount: 1 }, primaryAction: "chain", stage: "chain" })
    );
    renderPage();
    expect(await screen.findByText("Next: Continue chain")).toBeDefined();
    expect(screen.getByRole("button", { name: "Start session" })).toBeDefined();
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
    expect(await screen.findByText("Next: Whole-work review")).toBeDefined();
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
    const panel = await screen.findByLabelText("Session");
    expect(within(panel).getByText("0 due")).toBeDefined();
    expect(within(panel).getByText("New passage available")).toBeDefined();
    expect(within(panel).getByRole("button", { name: "Start session" })).toBeDefined();
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
    const panel = await screen.findByLabelText("Session");
    expect(within(panel).getByText("Start first passage")).toBeDefined();
    expect(within(panel).queryByText(/left/)).toBeNull();
  });

  it("shows a calm caught-up state when nothing is due and nothing is to introduce", async () => {
    mockedGet.mockResolvedValue(makeHub({ primaryAction: "none" }));
    renderPage();
    const caughtUp = await screen.findByLabelText("Caught up");
    expect(within(caughtUp).getByText(/caught up for today/i)).toBeDefined();
    expect(screen.queryByLabelText("Session")).toBeNull();
  });

  it("shows a paused banner and resumes from the returned hub", async () => {
    mockedGet.mockResolvedValue(makeHub({ paused: true, primaryAction: "none" }));
    mockedResume.mockResolvedValue(makeHub({ paused: false, primaryAction: "none" }));
    renderPage();

    expect(await screen.findByText(/this routine is paused/i)).toBeDefined();
    // A paused plan withholds obligations and the new-passage affordance.
    expect(screen.queryByLabelText("Session")).toBeNull();
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
