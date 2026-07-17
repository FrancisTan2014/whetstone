// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesReviewApi", () => ({
  fetchNextNotePrompt: vi.fn(),
  fetchNoteReveal: vi.fn(),
  rateNotePrompt: vi.fn()
}));

vi.mock("../reader/PmDocument.js", async () => {
  const { documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    PmDocument: ({ document }: { document: unknown }) =>
      React.createElement("p", { "data-testid": "pm-document" }, documentText(document as never))
  };
});

import type { NoteReviewPromptDto, NoteRevealDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { fetchNextNotePrompt, fetchNoteReveal, rateNotePrompt } from "./notesReviewApi";
import { NotesReviewPage } from "./NotesReviewPage";

const mockedNext = vi.mocked(fetchNextNotePrompt);
const mockedReveal = vi.mocked(fetchNoteReveal);
const mockedRate = vi.mocked(rateNotePrompt);

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

function renderPage(): void {
  render(
    <MemoryRouter>
      <NotesReviewPage />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("NotesReviewPage", () => {
  it("always shows the Review heading and a Back to Notes target, including while loading", () => {
    mockedNext.mockReturnValue(new Promise<NoteReviewPromptDto | null>(() => {}));
    renderPage();

    expect(screen.getByRole("heading", { name: "Review" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Back to Notes" }).getAttribute("href")).toBe("/notes");
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

  it("rates by click, then shows the next scheduled date and Review next", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));

    expect(mockedRate).toHaveBeenCalledWith("prompt-1", "good");
    expect(await screen.findByText(/Next review:.*2026/u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Review next" })).toBeTruthy();
  });

  it("rates via the 1–4 keyboard accelerators", async () => {
    const user = userEvent.setup();
    mockedNext.mockResolvedValue(makePrompt());
    mockedReveal.mockResolvedValue(legacyReveal);
    mockedRate.mockResolvedValue({ review });
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
    mockedRate.mockResolvedValue({ review });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "Show note" }));
    await user.click(await screen.findByRole("button", { name: "Good" }));
    await user.click(await screen.findByRole("button", { name: "Review next" }));

    expect(await screen.findByText(/Due complete/u)).toBeTruthy();
  });
});
