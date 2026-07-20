// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectCardResultDto } from "@whetstone/contracts";
import { documentText } from "@whetstone/document";

import type * as NotesReviewApi from "../notesReview/notesReviewApi";
import { DirectCardComposer } from "./DirectCardComposer";
import { createDirectCard, CreateDirectCardError } from "../notesReview/notesReviewApi";

// Replace only the network call; keep the real `CreateDirectCardError` so the composer's `instanceof`
// mapping is exercised, not restubbed.
vi.mock("../notesReview/notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("../notesReview/notesReviewApi");
  return { ...actual, createDirectCard: vi.fn() };
});

// The shared editor stands in as a textarea keyed by its aria-label so the Answer, Question, and Success
// check documents can be driven and read as plain text.
vi.mock("../../shared/editor/index.js", async () => {
  const React = await import("react");
  const { createTextDocument, documentText: read } = await import("@whetstone/document");
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
        onChange: (event: { target: { value: string } }) =>
          onChange(createTextDocument(event.target.value)),
        value: read(document as never)
      })
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

beforeEach(() => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-4111-8111-111111111111");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function renderComposer(): {
  onClose: ReturnType<typeof vi.fn>;
  onCreated: ReturnType<typeof vi.fn>;
} {
  const onClose = vi.fn();
  const onCreated = vi.fn();
  render(<DirectCardComposer onClose={onClose} onCreated={onCreated} />);
  return { onClose, onCreated };
}

describe("DirectCardComposer", () => {
  it("opens the New card sheet with the target-first order and the recurring-review guidance", () => {
    renderComposer();

    expect(screen.getByRole("heading", { name: "New card" })).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: "What do you want to be able to recall or do?" })
    ).toBeTruthy();
    expect(screen.getByText("What should bring it to mind?")).toBeTruthy();
    expect(screen.getByText("Adds one recurring review.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create card" })).toBeTruthy();
  });

  it("blocks creation and shows inline errors when required fields are blank", async () => {
    const user = userEvent.setup();
    const { onCreated } = renderComposer();

    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(screen.getByText("Write what you want to be able to recall or do.")).toBeTruthy();
    expect(screen.getByText("Write what should bring it to mind.")).toBeTruthy();
    expect(createDirectCard).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("creates a card that grades against the whole note and reports the result", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockResolvedValue(result);
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris is the capital of France.");
    await user.type(screen.getByLabelText("Question"), "Capital of France?");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
    const request = vi.mocked(createDirectCard).mock.calls[0]![0];
    expect(request.submissionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(request.target).toEqual({ kind: "current_note" });
    expect(documentText(request.answerDoc)).toBe("Paris is the capital of France.");
    expect(documentText(request.questionDoc)).toBe("Capital of France?");
  });

  it("creates a card that grades against an authored success check", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockResolvedValue(result);
    renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris is the capital of France.");
    await user.type(screen.getByLabelText("Question"), "Capital of France?");
    await user.click(screen.getByRole("button", { name: "Add a specific success check" }));
    await user.type(screen.getByLabelText("Success check"), "Must say Paris.");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    await waitFor(() => expect(createDirectCard).toHaveBeenCalled());
    const request = vi.mocked(createDirectCard).mock.calls[0]![0];
    expect(request.target.kind).toBe("expected_response");
    if (request.target.kind === "expected_response") {
      expect(documentText(request.target.successCheckDoc)).toBe("Must say Paris.");
    }
  });

  it("keeps every draft and surfaces the reason when a create conflicts", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockRejectedValue(new CreateDirectCardError("conflict"));
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    await waitFor(() =>
      expect(screen.getByText(/This card was already started with different wording/)).toBeTruthy()
    );
    expect(onCreated).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe("Paris.");
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe("Capital?");
  });

  it("maps a plain (non-typed) rejection to the generic network message", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockRejectedValue(new Error("boom"));
    renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    await waitFor(() =>
      expect(screen.getByText("Could not create the card. Please try again.")).toBeTruthy()
    );
  });

  it("retries with the same submission id after a recoverable failure", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard)
      .mockRejectedValueOnce(new CreateDirectCardError("network"))
      .mockResolvedValueOnce(result);
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() =>
      expect(screen.getByText("Could not create the card. Please try again.")).toBeTruthy()
    );

    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));

    const first = vi.mocked(createDirectCard).mock.calls[0]![0].submissionId;
    const second = vi.mocked(createDirectCard).mock.calls[1]![0].submissionId;
    expect(second).toBe(first);
  });

  it("mints a fresh submission id after a conflict so the edited card is not trapped", async () => {
    const user = userEvent.setup();
    // The server burned the first id (a receipt with different wording already exists), then accepts the
    // genuinely new card. `gone` behaves identically; `conflict` stands in for both burned-receipt paths.
    vi.mocked(createDirectCard)
      .mockRejectedValueOnce(new CreateDirectCardError("conflict"))
      .mockResolvedValueOnce(result);
    let minted = 0;
    vi.mocked(crypto.randomUUID).mockImplementation(
      () => `0000000${minted++}-0000-4000-8000-000000000000` as ReturnType<typeof crypto.randomUUID>
    );
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() =>
      expect(screen.getByText(/This card was already started with different wording/)).toBeTruthy()
    );

    // The learner edits and retries exactly as the copy tells them to; the burned id must not be reused.
    await user.type(screen.getByLabelText("Question"), " (of France)");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));

    const first = vi.mocked(createDirectCard).mock.calls[0]![0].submissionId;
    const second = vi.mocked(createDirectCard).mock.calls[1]![0].submissionId;
    expect(second).not.toBe(first);
  });

  it("closes when the learner cancels", async () => {
    const user = userEvent.setup();
    const { onClose } = renderComposer();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("ignores a close while a create is in flight", async () => {
    const user = userEvent.setup();
    let settle: ((value: DirectCardResultDto) => void) | undefined;
    vi.mocked(createDirectCard).mockReturnValue(
      new Promise<DirectCardResultDto>((resolve) => {
        settle = resolve;
      })
    );
    const { onClose, onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    // The parent's Cancel is disabled while pending, and the sheet's own Close affordance is guarded too:
    // dismissing mid-request is ignored so a card the retry-safe id would recover is never stranded.
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();

    settle?.(result);
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result));
  });
});
