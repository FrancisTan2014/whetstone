// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NotePromptSettingsDto } from "@whetstone/contracts";
import { createTextDocument, type DocumentNodeJSON } from "@whetstone/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  fetchNotePromptSettings: vi.fn()
}));

vi.mock("../../shared/preferences/useLearnerTimeZone", () => ({
  useLearnerTimeZone: () => "UTC"
}));

// The Cards leaves have their own suites; here they are controllable stubs so CardsView's own orchestration
// (list -> detail -> history navigation, row refresh, reload, the Add-card compose slot) is asserted in
// isolation.
vi.mock("./CardDetail", () => ({
  CardDetail: (props: {
    focusHistoryButton: boolean;
    noteBodyDoc: DocumentNodeJSON | null;
    onOpenHistory: () => void;
    onRefreshed: (refreshed: NotePromptSettingsDto) => void;
    onReload: () => void;
    prompt: NotePromptSettingsDto;
  }) => (
    <div
      data-testid="card-detail"
      data-body={props.noteBodyDoc === null ? "null" : "present"}
      data-from-history={String(props.focusHistoryButton)}
    >
      <span>detail:{props.prompt.promptId}</span>
      <button onClick={props.onOpenHistory} type="button">
        stub-open-history
      </button>
      <button
        onClick={() => props.onRefreshed({ ...props.prompt, questionText: "refreshed question" })}
        type="button"
      >
        stub-refresh
      </button>
      <button onClick={props.onReload} type="button">
        stub-reload
      </button>
    </div>
  )
}));

vi.mock("./CardHistory", () => ({
  CardHistory: (props: { promptId: string }) => <div>history:{props.promptId}</div>
}));

vi.mock("./SavedNoteCardComposer", () => ({
  SavedNoteCardComposer: (props: {
    noteEntryId: string;
    sourceSnapshot: string | null;
    onCancel: () => void;
    onCreated: () => void;
  }) => (
    <div data-testid="composer">
      <span>
        compose:{props.noteEntryId}:{String(props.sourceSnapshot)}
      </span>
      <button onClick={props.onCreated} type="button">
        stub-created
      </button>
      <button onClick={props.onCancel} type="button">
        stub-cancel
      </button>
    </div>
  )
}));

import { CardsView } from "./CardsView";
import { fetchNotePromptSettings } from "../notesReview/notesReviewApi";

const mockedList = vi.mocked(fetchNotePromptSettings);
const noteBody = createTextDocument("Merge sort is stable.");

function prompt(overrides: Partial<NotePromptSettingsDto> = {}): NotePromptSettingsDto {
  return {
    cardState: { state: "due" },
    promptId: "prompt-1",
    revision: 0,
    questionDoc: createTextDocument("What is a WAL?"),
    questionText: "What is a WAL?",
    reveal: { kind: "current_note" },
    ...overrides
  };
}

function renderView(
  overrides: {
    noteBodyDoc?: DocumentNodeJSON | null;
    onReviewChanged?: () => void;
    sourceSnapshot?: string | null;
  } = {}
) {
  const onReviewChanged = overrides.onReviewChanged ?? vi.fn<() => void>();
  render(
    <CardsView
      noteBodyDoc={overrides.noteBodyDoc === undefined ? noteBody : overrides.noteBodyDoc}
      noteEntryId="note-1"
      onReviewChanged={onReviewChanged}
      sourceSnapshot={overrides.sourceSnapshot ?? null}
    />
  );
  return { onReviewChanged };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("CardsView", () => {
  it("recovers from a failed load via Retry", async () => {
    mockedList.mockRejectedValueOnce(new Error("boom"));
    mockedList.mockResolvedValueOnce({ prompts: [prompt()] });
    renderView();

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("What is a WAL?")).toBeDefined();
  });

  it("offers Add card and empty copy for a no-card note that has a body", async () => {
    mockedList.mockResolvedValue({ prompts: [] });
    renderView();

    expect(await screen.findByRole("button", { name: "Add card" })).toBeDefined();
    expect(screen.getByText("This note has no review cards yet.")).toBeDefined();
  });

  it("hides Add card for a bodyless note (a Mark), leaving only the empty copy", async () => {
    mockedList.mockResolvedValue({ prompts: [] });
    renderView({ noteBodyDoc: null });

    expect(await screen.findByText("This note has no review cards yet.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Add card" })).toBeNull();
  });

  it("opens the compose slot from Add card, forwarding the note id and source snapshot", async () => {
    mockedList.mockResolvedValue({ prompts: [] });
    renderView({ sourceSnapshot: "the exact source" });

    await userEvent.click(await screen.findByRole("button", { name: "Add card" }));
    expect(screen.getByText("compose:note-1:the exact source")).toBeDefined();
  });

  it("authoring a card from the compose slot reloads the list and notifies the parent", async () => {
    mockedList.mockResolvedValueOnce({ prompts: [] });
    mockedList.mockResolvedValueOnce({ prompts: [prompt()] });
    const { onReviewChanged } = renderView();

    await userEvent.click(await screen.findByRole("button", { name: "Add card" }));
    await userEvent.click(screen.getByRole("button", { name: "stub-created" }));

    expect(await screen.findByText("What is a WAL?")).toBeDefined();
    expect(onReviewChanged).toHaveBeenCalled();
  });

  it("cancelling the compose slot returns to the list without reloading", async () => {
    mockedList.mockResolvedValue({ prompts: [] });
    const { onReviewChanged } = renderView();

    await userEvent.click(await screen.findByRole("button", { name: "Add card" }));
    await userEvent.click(screen.getByRole("button", { name: "stub-cancel" }));

    expect(await screen.findByText("This note has no review cards yet.")).toBeDefined();
    // Only the initial load ran; cancel does not reload or notify.
    expect(mockedList).toHaveBeenCalledTimes(1);
    expect(onReviewChanged).not.toHaveBeenCalled();
  });

  it("returns to the list from the compose slot's Back control", async () => {
    mockedList.mockResolvedValue({ prompts: [] });
    renderView();

    await userEvent.click(await screen.findByRole("button", { name: "Add card" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to cards" }));
    expect(screen.getByText("This note has no review cards yet.")).toBeDefined();
  });

  it("lists each card's question, reveal summary, and state, and STILL offers Add card", async () => {
    // #688: a note may own many authored cards, so an existing authored `current_note` prompt no longer
    // hides Add card — every non-Mark note can always add another independently-scheduled direction.
    mockedList.mockResolvedValue({ prompts: [prompt()] });
    renderView();

    expect(await screen.findByText("What is a WAL?")).toBeDefined();
    expect(screen.getByText("Whole note")).toBeDefined();
    expect(screen.getByText("Due now")).toBeDefined();
    expect(screen.getByRole("button", { name: "Add card" })).toBeDefined();
  });

  it("offers Add card for a legacy-only note while still showing its legacy row", async () => {
    // A `legacy_custom` prompt is read-only, and Add card is offered for every non-Mark note regardless of
    // which prompts already exist (#688), so the legacy row renders alongside an available Add card.
    mockedList.mockResolvedValue({
      prompts: [
        prompt({
          promptId: "legacy-1",
          questionDoc: createTextDocument("Legacy cue?"),
          questionText: "Legacy cue?",
          reveal: {
            kind: "legacy_custom",
            answerDoc: createTextDocument("Legacy answer."),
            answerText: "Legacy answer."
          }
        })
      ]
    });
    renderView();

    // The legacy row renders...
    expect(await screen.findByText("Legacy cue?")).toBeDefined();
    // ...and Add card is still offered for the non-Mark note.
    expect(screen.getByRole("button", { name: "Add card" })).toBeDefined();
    // The legacy-only note is not the true empty state.
    expect(screen.queryByText("This note has no review cards yet.")).toBeNull();
  });

  it("drills list -> detail -> history and back, restoring the row's focus", async () => {
    mockedList.mockResolvedValue({ prompts: [prompt()] });
    renderView();

    await userEvent.click(await screen.findByText("What is a WAL?"));
    expect(screen.getByText("detail:prompt-1")).toBeDefined();
    // The live note body is forwarded to the detail as the read-only Reference.
    expect(screen.getByTestId("card-detail").getAttribute("data-body")).toBe("present");
    expect(screen.getByTestId("card-detail").getAttribute("data-from-history")).toBe("false");

    await userEvent.click(screen.getByRole("button", { name: "stub-open-history" }));
    expect(screen.getByText("history:prompt-1")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Back to card" }));
    // Returning from history flags the detail to restore focus to its Review history control.
    expect(screen.getByTestId("card-detail").getAttribute("data-from-history")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Back to cards" }));
    await waitFor(() =>
      expect((document.activeElement as HTMLElement).textContent).toContain("What is a WAL?")
    );
  });

  it("replaces exactly the refreshed row and notifies the parent", async () => {
    mockedList.mockResolvedValue({ prompts: [prompt()] });
    const { onReviewChanged } = renderView();

    await userEvent.click(await screen.findByText("What is a WAL?"));
    await userEvent.click(screen.getByRole("button", { name: "stub-refresh" }));
    expect(onReviewChanged).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Back to cards" }));
    expect(screen.getByText("refreshed question")).toBeDefined();
  });

  it("leaves sibling rows untouched when one row is refreshed", async () => {
    const other = prompt({ promptId: "prompt-2", questionText: "What is fsync?" });
    mockedList.mockResolvedValue({ prompts: [prompt(), other] });
    renderView();

    await userEvent.click(await screen.findByText("What is a WAL?"));
    await userEvent.click(screen.getByRole("button", { name: "stub-refresh" }));
    await userEvent.click(screen.getByRole("button", { name: "Back to cards" }));

    // The mutated row shows its refreshed question; the sibling row is returned unchanged (the map's
    // non-matching branch), so its original question survives.
    expect(screen.getByText("refreshed question")).toBeDefined();
    expect(screen.getByText("What is fsync?")).toBeDefined();
  });

  it("reloads the list after a mutation, falling back to the list when the card is gone", async () => {
    mockedList.mockResolvedValueOnce({ prompts: [prompt()] });
    mockedList.mockResolvedValueOnce({ prompts: [] });
    const { onReviewChanged } = renderView();

    await userEvent.click(await screen.findByText("What is a WAL?"));
    await userEvent.click(screen.getByRole("button", { name: "stub-reload" }));

    // The reloaded list no longer has this card, so the detail falls back to the (now empty) list.
    expect(await screen.findByText("This note has no review cards yet.")).toBeDefined();
    expect(onReviewChanged).toHaveBeenCalled();
  });
});
