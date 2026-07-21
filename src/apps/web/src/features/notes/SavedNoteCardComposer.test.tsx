// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectCardResultDto } from "@whetstone/contracts";
import { createTextDocument, documentText } from "@whetstone/document";

import type * as NotesReviewApi from "../notesReview/notesReviewApi";
import { SavedNoteCardComposer } from "./SavedNoteCardComposer";
import { authorNoteCard, AuthorNoteCardError } from "../notesReview/notesReviewApi";

// Replace only the network call; keep the real `AuthorNoteCardError` so the composer's `instanceof` mapping
// is exercised, not restubbed.
vi.mock("../notesReview/notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("../notesReview/notesReviewApi");
  return { ...actual, authorNoteCard: vi.fn() };
});

// The shared editor stands in as a textarea keyed by its aria-label so the Question and Success check
// documents can be driven and read as plain text.
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

// The read-only note body renders as plain text so its presence as the Reference can be asserted without
// depending on ProseMirror rendering internals.
vi.mock("../reader/PmDocument.js", async () => {
  const React = await import("react");
  const { documentText: read } = await import("@whetstone/document");
  return {
    PmDocument: ({ document }: { document: unknown }) =>
      React.createElement("div", { "data-testid": "pm" }, read(document as never))
  };
});

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

const result: DirectCardResultDto = { noteId: "note-1", promptId: "prompt-1", review };
const noteBody = createTextDocument("Merge sort is stable and runs in O(n log n).");

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderComposer(
  overrides: { sourceSnapshot?: string | null } = {}
): { onCancel: ReturnType<typeof vi.fn>; onCreated: ReturnType<typeof vi.fn> } {
  const onCancel = vi.fn();
  const onCreated = vi.fn();
  render(
    <SavedNoteCardComposer
      noteBodyDoc={noteBody}
      noteEntryId="note-1"
      onCancel={onCancel}
      onCreated={onCreated}
      sourceSnapshot={overrides.sourceSnapshot ?? null}
    />
  );
  return { onCancel, onCreated };
}

describe("SavedNoteCardComposer", () => {
  it("frames the read-only note body as the Answer/Reference with recurring-review guidance", () => {
    renderComposer();

    expect(screen.getByText("Merge sort is stable and runs in O(n log n).")).toBeTruthy();
    expect(screen.getByText("Adds one recurring review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add card" })).toBeTruthy();
  });

  it("shows an anchored source snapshot verbatim, and omits it for a standalone note", () => {
    const { onCancel: _ } = renderComposer({ sourceSnapshot: "the exact selected source" });
    expect(screen.getByText("the exact selected source")).toBeTruthy();

    cleanup();
    renderComposer();
    expect(screen.queryByText("the exact selected source")).toBeNull();
  });

  it("blocks creation and shows an inline error when the question is blank", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderComposer();

    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(screen.getByText("Write what should bring it to mind.")).toBeTruthy();
    expect(authorNoteCard).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("blocks creation when an opened Success check is left blank", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await user.click(screen.getByRole("button", { name: "Add card" }));

    expect(screen.getByText("Write the success check, or remove it.")).toBeTruthy();
    expect(authorNoteCard).not.toHaveBeenCalled();
  });

  it("authors a first card that grades against the whole note", async () => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard).mockResolvedValue(result);
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    const request = vi.mocked(authorNoteCard).mock.calls[0]![0];
    expect(request.noteEntryId).toBe("note-1");
    expect(request.submissionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(request.target).toEqual({ kind: "current_note" });
    expect(documentText(request.questionDoc)).toBe("Which sort is stable?");
  });

  it("authors a first card that grades against an authored success check", async () => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard).mockResolvedValue(result);
    renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await user.type(screen.getByLabelText("Success check"), "Must say merge sort.");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    await waitFor(() => expect(authorNoteCard).toHaveBeenCalled());
    const request = vi.mocked(authorNoteCard).mock.calls[0]![0];
    expect(request.target.kind).toBe("expected_response");
    if (request.target.kind === "expected_response") {
      expect(documentText(request.target.successCheckDoc)).toBe("Must say merge sort.");
    }
  });

  it("rehearses the card in the Try preview, revealing the note without authoring anything", async () => {
    const user = userEvent.setup();
    renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Try card" }));

    expect(screen.getByLabelText("Card preview")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Reveal" }));
    expect(screen.getByLabelText("Note")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to editing" }));

    expect(screen.getByRole("button", { name: "Add card" })).toBeTruthy();
    expect(authorNoteCard).not.toHaveBeenCalled();
  });

  it.each([
    ["already_authored", "This note already has a card. Go back to manage it."],
    [
      "conflict",
      "This card was already started with different wording. Edit a field and try again."
    ],
    ["gone", "This note is no longer available. Go back to the cards list."],
    ["invalid", "Whetstone could not accept this card. Check the question, then try again."],
    ["network", "Could not create the card. Please try again."],
    ["not_found", "This note is no longer available. Go back to the cards list."]
  ] as const)("keeps drafts and reports the reason on a %s failure", async (kind, message) => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard).mockRejectedValue(new AuthorNoteCardError(kind));
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
      "Which sort is stable?"
    );
  });

  it("maps a plain (non-typed) rejection to the generic network message", async () => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard).mockRejectedValue(new Error("boom"));
    renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    await waitFor(() =>
      expect(screen.getByText("Could not create the card. Please try again.")).toBeTruthy()
    );
  });

  it("retries with the same submission id after a recoverable network failure", async () => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard)
      .mockRejectedValueOnce(new AuthorNoteCardError("network"))
      .mockResolvedValueOnce(result);
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await waitFor(() =>
      expect(screen.getByText("Could not create the card. Please try again.")).toBeTruthy()
    );

    await user.click(screen.getByRole("button", { name: "Add card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));

    const first = vi.mocked(authorNoteCard).mock.calls[0]![0].submissionId;
    const second = vi.mocked(authorNoteCard).mock.calls[1]![0].submissionId;
    expect(second).toBe(first);
  });

  it("mints a fresh submission id after a conflict so the edited card is not trapped", async () => {
    const user = userEvent.setup();
    vi.mocked(authorNoteCard)
      .mockRejectedValueOnce(new AuthorNoteCardError("conflict"))
      .mockResolvedValueOnce(result);
    let minted = 0;
    vi.mocked(crypto.randomUUID).mockImplementation(
      () => `0000000${minted++}-0000-4000-8000-000000000000` as ReturnType<typeof crypto.randomUUID>
    );
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await waitFor(() =>
      expect(
        screen.getByText(/This card was already started with different wording/)
      ).toBeTruthy()
    );

    await user.type(screen.getByLabelText("Question"), " really?");
    await user.click(screen.getByRole("button", { name: "Add card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));

    const first = vi.mocked(authorNoteCard).mock.calls[0]![0].submissionId;
    const second = vi.mocked(authorNoteCard).mock.calls[1]![0].submissionId;
    expect(second).not.toBe(first);
  });

  it("cancels when the learner dismisses the composer", async () => {
    const user = userEvent.setup();
    const { onCancel } = renderComposer();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCancel).toHaveBeenCalled();
  });

  it("ignores a cancel while a create is in flight", async () => {
    const user = userEvent.setup();
    let settle: ((value: DirectCardResultDto) => void) | undefined;
    vi.mocked(authorNoteCard).mockReturnValue(
      new Promise<DirectCardResultDto>((resolve) => {
        settle = resolve;
      })
    );
    const { onCancel, onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Question"), "Which sort is stable?");
    await user.click(screen.getByRole("button", { name: "Add card" }));

    // Cancel is disabled while pending, so dismissing mid-request is ignored and a card the retry-safe id
    // would recover is never stranded.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).not.toHaveBeenCalled();

    settle?.(result);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
  });
});
