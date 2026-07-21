// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as NotesReviewApi from "./notesReviewApi";

vi.mock("./notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("./notesReviewApi");
  return {
    ...actual,
    editNotePromptQuestion: vi.fn(),
    fetchNextNotePrompt: vi.fn(),
    fetchNotePromptSettings: vi.fn(),
    fetchNoteReveal: vi.fn(),
    rateNotePrompt: vi.fn(),
    setNoteGradingTarget: vi.fn()
  };
});

vi.mock("../reader/PmDocument.js", async () => {
  const { documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    PmDocument: ({ document }: { document: unknown }) =>
      React.createElement("p", { "data-testid": "pm-document" }, documentText(document as never))
  };
});

// The editable editor stands in as a textarea keyed by its aria-label so a repair's Question/Success
// check can be driven and read as plain text (only the repair path renders it).
vi.mock("../../shared/editor/index.js", async () => {
  const React = await import("react");
  const { createTextDocument: make, documentText: read } = await import("@whetstone/document");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
    }) =>
      React.createElement("textarea", {
        "aria-label": ariaLabel,
        onChange: (event: { target: { value: string } }) => onChange(make(event.target.value)),
        value: read(document as never)
      })
  };
});

// A fixed learner zone so the rated confirmation's next-review label is deterministic (#676).
vi.mock("../../shared/preferences/useLearnerTimeZone", () => ({
  useLearnerTimeZone: () => "UTC"
}));

import type {
  NotePromptSettingsDto,
  NoteReviewPromptDto,
  NoteRevealDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import {
  editNotePromptQuestion,
  fetchNextNotePrompt,
  fetchNotePromptSettings,
  fetchNoteReveal,
  rateNotePrompt
} from "./notesReviewApi";
import { NotesReviewPage } from "./NotesReviewPage";

const mockedNext = vi.mocked(fetchNextNotePrompt);
const mockedReveal = vi.mocked(fetchNoteReveal);
const mockedRate = vi.mocked(rateNotePrompt);
const mockedSettings = vi.mocked(fetchNotePromptSettings);
const mockedEdit = vi.mocked(editNotePromptQuestion);

const review = {
  due: "2026-07-11T12:00:00.000Z",
  stability: 1,
  difficulty: 5,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: "review",
  lastReviewedAt: null
} as const;

// A short-term (learning) result whose next review is 6 minutes later the same day, so the rated
// confirmation must read "Short-term review · Later today at <time>" (#676).
const learningReview = {
  ...review,
  due: "2026-07-01T12:06:00.000Z",
  state: "learning"
} as const;

function makePrompt(overrides: Partial<NoteReviewPromptDto> = {}): NoteReviewPromptDto {
  return {
    promptId: "prompt-1",
    noteId: "note-1",
    cueDoc: createTextDocument("What is the capital of France?"),
    cueText: "What is the capital of France?",
    revealKind: "legacy_custom",
    review,
    ...overrides
  };
}

const legacyReveal: NoteRevealDto = {
  kind: "legacy_custom",
  answerDoc: createTextDocument("Paris, the preserved answer."),
  answerText: "Paris, the preserved answer."
};

const currentNoteReveal: NoteRevealDto = {
  kind: "current_note",
  bodyDoc: createTextDocument("Paris, the live note body."),
  bodyText: "Paris, the live note body."
};

const expectedResponseReveal: NoteRevealDto = {
  kind: "expected_response",
  successCheckDoc: createTextDocument("Names durability and ordering."),
  successCheckText: "Names durability and ordering.",
  referenceDoc: createTextDocument("The live note reference."),
  referenceText: "The live note reference."
};

// The settings row RepairCardView loads when the learner opens Fix card on the current prompt.
function settingsList(reveal: NotePromptSettingsDto["reveal"] = { kind: "current_note" }): {
  prompts: NotePromptSettingsDto[];
} {
  return {
    prompts: [
      {
        cardState: { state: "due" },
        promptId: "prompt-1",
        revision: 0,
        questionDoc: createTextDocument("What is the capital of France?"),
        questionText: "What is the capital of France?",
        reveal
      }
    ]
  };
}

const refreshedRow: NotePromptSettingsDto = {
  cardState: { state: "due" },
  promptId: "prompt-1",
  revision: 1,
  questionDoc: createTextDocument("Which city is the capital of France?"),
  questionText: "Which city is the capital of France?",
  reveal: { kind: "current_note" }
};

function deferred<T>(): Readonly<{ promise: Promise<T>; resolve: (value: T) => void }> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <NotesReviewPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Fake only Date so `now` is fixed for the label math; setTimeout stays real so userEvent works.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("NotesReviewPage", () => {
  it("always shows the Review heading and a Notes parent link, including while loading", () => {
    mockedNext.mockReturnValue(new Promise<NoteReviewPromptDto | null>(() => {}));
    renderPage();

    expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
    // The parent treatment is now the shared PageFrame parent link (#641): an ArrowLeft plus the
    // visible parent label "Notes", still a real /notes target above the title.
    expect(screen.getByRole("link", { name: "Notes" }).getAttribute("href")).toBe("/notes");
  });

  it("reports a calm due-complete state when nothing is due", async () => {
    mockedNext.mockResolvedValue(null);
    renderPage();

    expect(await screen.findByText(/Due complete/u)).toBeTruthy();
  });

  it("shows a truthful error (never completion) when the due read fails", async () => {
    mockedNext.mockRejectedValue(new Error("network"));
    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not load/u);
    expect(screen.queryByText(/Due complete/u)).toBeNull();
  });

  it("exposes only the question and Show note before reveal — no answer, no ratings", async () => {
    mockedNext.mockResolvedValue(makePrompt());
    renderPage();

    expect(await screen.findByText("What is the capital of France?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show note" })).toBeTruthy();
    expect(screen.queryByText(/preserved answer/u)).toBeNull();
    expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
  });

  it("keeps reveal and repair mutually exclusive while Show note is pending", async () => {
    const user = userEvent.setup();
    const pendingReveal = deferred<NoteRevealDto>();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedReveal.mockReturnValue(pendingReveal.promise);
    mockedSettings.mockResolvedValue(settingsList());
    renderPage();

    const showNote = (await screen.findByRole("button", {
      name: "Show note"
    })) as HTMLButtonElement;
    const fixCard = screen.getByRole("button", { name: "Fix card" }) as HTMLButtonElement;
    await user.click(showNote);

    expect(showNote.disabled).toBe(true);
    expect(showNote.getAttribute("aria-busy")).toBe("true");
    expect(fixCard.disabled).toBe(true);

    await user.click(showNote);
    await user.click(fixCard);

    expect(mockedReveal).toHaveBeenCalledTimes(1);
    expect(mockedSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();

    await act(async () => {
      pendingReveal.resolve(currentNoteReveal);
      await pendingReveal.promise;
    });

    expect(await screen.findByText("Paris, the live note body.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();
  });

  it("reveals a legacy prompt's preserved answer, moves focus to it, and shows four ratings", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));

    expect(await screen.findByText("Paris, the preserved answer.")).toBeTruthy();
    const noteRegion = screen.getByLabelText("Note");
    await waitFor(() => expect(document.activeElement).toBe(noteRegion));
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("renders a current-note reveal from the live note body", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedReveal.mockResolvedValue(currentNoteReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));

    expect(await screen.findByText("Paris, the live note body.")).toBeTruthy();
  });

  it("reveals an expected_response prompt's Success check plus Reference and focuses the Success check", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "expected_response" }));
    mockedReveal.mockResolvedValue(expectedResponseReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));

    const successCheck = await screen.findByLabelText("Success check");
    expect(successCheck.textContent).toContain("Names durability and ordering.");
    const reference = screen.getByLabelText("Reference");
    expect(reference.textContent).toContain("The live note reference.");
    await waitFor(() => expect(document.activeElement).toBe(successCheck));
    for (const label of ["Again", "Hard", "Good", "Easy"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("keeps the question with a specific retry and no ratings when reveal fails", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockRejectedValue(new Error("boom"));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not show the note/u);
    expect(screen.getByRole("button", { name: "Retry showing note" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Good" })).toBeNull();
  });

  it("rates by click, then shows the next scheduled date and Review next when more remain", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review, remainingDue: 1 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));

    expect(mockedRate).toHaveBeenCalledWith("prompt-1", "good");
    expect(await screen.findByText("July 11, 2026 at 12:00 PM")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review next" })).toBeTruthy();
    expect(screen.queryByText(/Due complete/u)).toBeNull();
  });

  it("keeps rating and repair mutually exclusive while a rating is pending", async () => {
    const user = userEvent.setup();
    const ratingResult = { review, remainingDue: 1 };
    const pendingRating = deferred<typeof ratingResult>();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedReveal.mockResolvedValue(currentNoteReveal);
    mockedRate.mockReturnValue(pendingRating.promise);
    mockedSettings.mockResolvedValue(settingsList());
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));

    for (const label of ["Again", "Hard", "Good", "Easy", "Fix card"]) {
      expect((screen.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(
        true
      );
    }
    expect(screen.getByRole("button", { name: "Good" }).getAttribute("aria-busy")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Hard" }));
    await user.click(screen.getByRole("button", { name: "Fix card" }));
    screen.getByLabelText("Note").focus();
    await user.keyboard("1");

    expect(mockedRate).toHaveBeenCalledTimes(1);
    expect(mockedSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();

    await act(async () => {
      pendingRating.resolve(ratingResult);
      await pendingRating.promise;
    });

    expect(await screen.findByText("July 11, 2026 at 12:00 PM")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();
  });

  it("prefixes a short-term (learning) next review with the shared marker and a local time (#676)", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review: learningReview, remainingDue: 1 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Again" }));

    expect(await screen.findByText("Short-term review · Later today at 12:06 PM")).toBeTruthy();
  });

  it("reports completion immediately after rating the final due prompt, with no Review next", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review, remainingDue: 0 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));

    expect(await screen.findByText("July 11, 2026 at 12:00 PM")).toBeTruthy();
    expect(await screen.findByText(/Due complete/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Review next" })).toBeNull();
  });

  it("rates via the 1–4 keyboard accelerators", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review, remainingDue: 1 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await screen.findByText("Paris, the preserved answer.");
    await user.keyboard("3");

    await waitFor(() => expect(mockedRate).toHaveBeenCalledWith("prompt-1", "good"));
  });

  it("ignores non-rating keys while revealed", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await screen.findByText("Paris, the preserved answer.");
    await user.keyboard("x");

    expect(mockedRate).not.toHaveBeenCalled();
  });

  it("surfaces a retryable alert when a rating fails, keeping the ratings in place", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockRejectedValue(new Error("save failed"));
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not save that rating/u);
    expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
  });

  it("advances to the next prompt via Review next, reaching due-complete when none remain", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValueOnce(makePrompt()).mockResolvedValueOnce(null);
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review, remainingDue: 1 });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));
    await user.click(await screen.findByRole("button", { name: "Review next" }));

    expect(await screen.findByText(/Due complete/u)).toBeTruthy();
  });

  it("offers Fix card before reveal and enters repair without recording a rating", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Fix card" }));

    expect(await screen.findByRole("heading", { name: "Fix this card" })).toBeTruthy();
    expect(mockedRate).not.toHaveBeenCalled();
  });

  it("returns to the same question and restores its Fix card focus when Escape cancels", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    renderPage();

    const fix = await screen.findByRole("button", { name: "Fix card" });
    fix.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("heading", { name: "Fix this card" });
    await user.keyboard("{Escape}");

    expect(await screen.findByText("What is the capital of France?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show note" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Fix this card" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fix card" }))
    );
    expect(mockedRate).not.toHaveBeenCalled();
  });

  it("returns to the revealed Fix card when Cancel is keyboard-activated", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await screen.findByText("Paris, the live note body.");
    const fix = screen.getByRole("button", { name: "Fix card" });
    fix.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Fix this card" })).toBeTruthy();

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Paris, the live note body.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Good" })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Fix card" }))
    );
    expect(mockedRate).not.toHaveBeenCalled();
  });

  it("re-attempts from a fresh question with the clarified cue after a repair saves, never rating", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    mockedEdit.mockResolvedValue(refreshedRow);
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Fix card" }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    await user.clear(question);
    await user.type(question, "Which city is the capital of France?");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Which city is the capital of France?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show note" })).toBeTruthy();
    expect(mockedEdit).toHaveBeenCalledTimes(1);
    expect(mockedRate).not.toHaveBeenCalled();
  });

  it("reloads the next due prompt instead of resurrecting a card made not-due while repair was open", async () => {
    const user = userEvent.setup();
    // Mount loads the due card under repair; after the save the session must re-ask what is actually due.
    mockedNext
      .mockResolvedValueOnce(makePrompt({ revealKind: "current_note" }))
      .mockResolvedValueOnce(null);
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    // The card was rated/paused/removed in another tab: the refreshed row comes back no longer due.
    mockedEdit.mockResolvedValue({
      ...refreshedRow,
      cardState: { state: "scheduled", nextReviewAt: "2026-07-30T00:00:00.000Z" }
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Fix card" }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    await user.clear(question);
    await user.type(question, "Which city is the capital of France?");
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The just-saved-but-no-longer-due card is NEVER presented for another reveal/rating: the session reloads
    // whatever is actually due (here nothing), and the stale clarified cue never appears — no early duplicate.
    expect(await screen.findByText(/Due complete/)).toBeTruthy();
    expect(screen.queryByText("Which city is the capital of France?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show note" })).toBeNull();
    expect(mockedEdit).toHaveBeenCalledTimes(1);
    expect(mockedRate).not.toHaveBeenCalled();
    expect(mockedNext).toHaveBeenCalledTimes(2);
  });

  it("navigates to open the shared note for editing", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt({ revealKind: "current_note" }));
    mockedSettings.mockResolvedValue(settingsList());
    mockedReveal.mockResolvedValue(currentNoteReveal);
    let location = "";
    function LocationProbe(): null {
      const current = useLocation();
      location = `${current.pathname}${current.search}`;
      return null;
    }
    render(
      <MemoryRouter>
        <NotesReviewPage />
        <LocationProbe />
      </MemoryRouter>
    );

    await user.click(await screen.findByRole("button", { name: "Fix card" }));
    await user.click(await screen.findByRole("button", { name: "Open note" }));

    expect(location).toBe("/notes?open=note-1");
  });
});
