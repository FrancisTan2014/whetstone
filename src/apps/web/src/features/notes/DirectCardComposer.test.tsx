// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { DirectCardResultDto, MaterialReviewDto } from "@whetstone/contracts";
import { documentText } from "@whetstone/document";

import type * as NotesReviewApi from "../notesReview/notesReviewApi";
import type { MaterialMatchesResult } from "../notesReview/notesReviewApi";
import { DirectCardComposer } from "./DirectCardComposer";
import {
  createDirectCard,
  CreateDirectCardError,
  fetchMaterialMatches,
  keepSeparateMaterial,
  MaterialDecisionError,
  reuseExistingMaterial
} from "../notesReview/notesReviewApi";

// Replace only the network calls; keep the real `CreateDirectCardError`/`MaterialDecisionError` so the
// composer's `instanceof` mapping is exercised, not restubbed.
vi.mock("../notesReview/notesReviewApi", async () => {
  const actual = await vi.importActual<typeof NotesReviewApi>("../notesReview/notesReviewApi");
  return {
    ...actual,
    createDirectCard: vi.fn(),
    fetchMaterialMatches: vi.fn(async () => ({ status: "ok", exact: [], near: [] })),
    keepSeparateMaterial: vi.fn(),
    reuseExistingMaterial: vi.fn()
  };
});

// The shared editor stands in as a textarea keyed by its aria-label so the Answer, Question, and Success
// check documents can be driven and read as plain text.
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

beforeAll(() => {
  // Radix Dialog reads pointer-capture and layout APIs jsdom lacks; stub them so the stacked review Sheet
  // does not throw during interaction tests.
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
    "scrollIntoView"
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: () => false
    });
  }
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    addEventListener: vi.fn(),
    addListener: vi.fn(),
    dispatchEvent: vi.fn(),
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: vi.fn(),
    removeListener: vi.fn()
  }));
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

function materialReview(overrides: Partial<MaterialReviewDto> = {}): MaterialReviewDto {
  return {
    attemptId: "attempt-1",
    candidateFingerprint: "fp-1",
    candidates: [
      {
        answerExcerpt: "Paris is the capital of France.",
        cardCount: 2,
        noteId: "note-9",
        sourceContext: null
      }
    ],
    nearCandidates: [],
    revision: 0,
    ...overrides
  };
}

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

async function fillAndSave(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.type(screen.getByLabelText("Answer"), "Paris is the capital of France.");
  await user.type(screen.getByLabelText("Question"), "Capital of France?");
  await user.click(screen.getByRole("button", { name: "Create card" }));
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

  it("creates a card that grades against the whole note and announces it as created", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockResolvedValue({ result, status: "created" });
    const { onCreated } = renderComposer();

    await fillAndSave(user);

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));
    const request = vi.mocked(createDirectCard).mock.calls[0]![0];
    expect(request.submissionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(request.target).toEqual({ kind: "current_note" });
    expect(documentText(request.answerDoc)).toBe("Paris is the capital of France.");
    expect(documentText(request.questionDoc)).toBe("Capital of France?");
  });

  it("creates a card that grades against an authored success check", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard).mockResolvedValue({ result, status: "created" });
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
      .mockResolvedValueOnce({ result, status: "created" });
    const { onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() =>
      expect(screen.getByText("Could not create the card. Please try again.")).toBeTruthy()
    );

    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));

    const first = vi.mocked(createDirectCard).mock.calls[0]![0].submissionId;
    const second = vi.mocked(createDirectCard).mock.calls[1]![0].submissionId;
    expect(second).toBe(first);
  });

  it("mints a fresh submission id after a conflict so the edited card is not trapped", async () => {
    const user = userEvent.setup();
    vi.mocked(createDirectCard)
      .mockRejectedValueOnce(new CreateDirectCardError("conflict"))
      .mockResolvedValueOnce({ result, status: "created" });
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

    await user.type(screen.getByLabelText("Question"), " (of France)");
    await user.click(screen.getByRole("button", { name: "Create card" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));

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
    let settle: ((value: { result: DirectCardResultDto; status: "created" }) => void) | undefined;
    vi.mocked(createDirectCard).mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      })
    );
    const { onClose, onCreated } = renderComposer();

    await user.type(screen.getByLabelText("Answer"), "Paris.");
    await user.type(screen.getByLabelText("Question"), "Capital?");
    await user.click(screen.getByRole("button", { name: "Create card" }));

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).not.toHaveBeenCalled();

    settle?.({ result, status: "created" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));
  });

  describe("material review", () => {
    it("parks the review panel over the intact draft when the saved answer already exists", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      const { onCreated } = renderComposer();

      await fillAndSave(user);

      await waitFor(() =>
        expect(
          screen.getByRole("heading", { name: "This material is already in Notes" })
        ).toBeTruthy()
      );
      expect(onCreated).not.toHaveBeenCalled();
    });

    it("adds the card to a chosen existing note and announces it as reused", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(reuseExistingMaterial).mockResolvedValue({ result, status: "reused" });
      const { onCreated } = renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(
        screen.getByRole("button", {
          name: "Use existing material from Paris is the capital of France."
        })
      );

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "reused"));
      const request = vi.mocked(reuseExistingMaterial).mock.calls[0]![0];
      expect(request.attemptId).toBe("attempt-1");
      expect(request.revision).toBe(0);
      expect(request.noteEntryId).toBe("note-9");
      expect(request.submissionId).toBe("11111111-1111-4111-8111-111111111111");
      expect(documentText(request.answerDoc)).toBe("Paris is the capital of France.");
    });

    it("mints a distinct note on Keep separate and announces it as created", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial).mockResolvedValue({ result, status: "created" });
      const { onCreated } = renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));
      const request = vi.mocked(keepSeparateMaterial).mock.calls[0]![0];
      expect(request.attemptId).toBe("attempt-1");
      expect(request.revision).toBe(0);
      expect(documentText(request.questionDoc)).toBe("Capital of France?");
    });

    it("restores the intact draft with the same submission id when Back is pressed", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Back" }));

      await waitFor(() =>
        expect(
          screen.queryByRole("heading", { name: "This material is already in Notes" })
        ).toBeNull()
      );
      expect((screen.getByLabelText("Answer") as HTMLTextAreaElement).value).toBe(
        "Paris is the capital of France."
      );

      vi.mocked(createDirectCard).mockResolvedValue({ result, status: "created" });
      await user.click(screen.getByRole("button", { name: "Create card" }));
      await waitFor(() => expect(createDirectCard).toHaveBeenCalledTimes(2));
      const first = vi.mocked(createDirectCard).mock.calls[0]![0].submissionId;
      const second = vi.mocked(createDirectCard).mock.calls[1]![0].submissionId;
      expect(second).toBe(first);
    });

    it("keeps the panel and shows a retryable error when a decision fails transiently", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial)
        .mockRejectedValueOnce(new MaterialDecisionError("network"))
        .mockResolvedValueOnce({ result, status: "created" });
      const { onCreated } = renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      await waitFor(() =>
        expect(screen.getByText("Could not complete that just now. Please try again.")).toBeTruthy()
      );
      expect(onCreated).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Keep separate" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));
    });

    it("refreshes the review in place when the evidence changed under a decision", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial).mockResolvedValue({
        review: materialReview({ revision: 1 }),
        status: "needs_material_review"
      });
      renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      await waitFor(() =>
        expect(
          screen.getByText("The existing material changed — please review it again.")
        ).toBeTruthy()
      );
    });

    it("returns to the composer with a re-save notice when the attempt is superseded", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial).mockRejectedValue(new MaterialDecisionError("superseded"));
      renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      await waitFor(() =>
        expect(
          screen.getByText("This review is no longer available. Save again to re-check your Notes.")
        ).toBeTruthy()
      );
      expect(
        screen.queryByRole("heading", { name: "This material is already in Notes" })
      ).toBeNull();
    });

    it("maps a plain (non-typed) decision rejection to the retryable network message", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial).mockRejectedValue(new Error("offline"));
      renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      // A rejection that is not a MaterialDecisionError is treated as a transient network blip: keep the
      // panel and offer a retry rather than stranding the learner.
      await waitFor(() =>
        expect(screen.getByText("Could not complete that just now. Please try again.")).toBeTruthy()
      );
      expect(
        screen.getByRole("heading", { name: "This material is already in Notes" })
      ).toBeTruthy();
    });

    it("mints a fresh submission after a burned-receipt decision so the draft is not trapped", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      vi.mocked(keepSeparateMaterial).mockRejectedValue(new MaterialDecisionError("conflict"));
      renderComposer();

      await fillAndSave(user);
      await screen.findByRole("heading", { name: "This material is already in Notes" });
      await user.click(screen.getByRole("button", { name: "Keep separate" }));

      // A conflict/gone burned the receipt: the panel is dismissed and the composer asks the learner to edit
      // a field, minting a fresh submission id so the drafted card is not trapped behind a spent id.
      await waitFor(() =>
        expect(
          screen.getByText("That draft can no longer be used. Edit a field to start a fresh card.")
        ).toBeTruthy()
      );
      expect(
        screen.queryByRole("heading", { name: "This material is already in Notes" })
      ).toBeNull();
    });
  });

  describe("advisory material hint", () => {
    it("warns after the answer settles when matching material exists", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchMaterialMatches).mockResolvedValue({
        status: "ok",
        exact: [{ answerExcerpt: "Paris.", cardCount: 1, noteId: "note-9", sourceContext: null }],
        near: []
      });
      renderComposer();

      await user.type(screen.getByLabelText("Answer"), "Paris.");

      // The advisory fires only after the Answer settles (350ms debounce), then the hint appears.
      expect(await screen.findByText(/This material is already in Notes\./)).toBeTruthy();
      expect(fetchMaterialMatches).toHaveBeenCalled();
      expect(documentText(vi.mocked(fetchMaterialMatches).mock.calls.at(-1)![0])).toBe("Paris.");
    });

    it("warns of a possible duplicate after the answer settles when near material exists", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchMaterialMatches).mockResolvedValue({
        status: "ok",
        exact: [],
        near: [
          {
            answerExcerpt: "Paris.",
            cardCount: 1,
            differences: [{ after: "capital", before: "capitol" }],
            noteId: "note-8",
            sourceContext: null
          }
        ]
      });
      renderComposer();

      await user.type(screen.getByLabelText("Answer"), "Paris.");

      // A near match shows the softer "Similar material" hint, not the exact-match one.
      expect(await screen.findByText(/Similar material may already be in Notes\./)).toBeTruthy();
      expect(screen.queryByText(/This material is already in Notes\./)).toBeNull();
    });

    it("offers Retry when the advisory query fails, then clears once it succeeds", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchMaterialMatches)
        .mockResolvedValueOnce({ status: "error" })
        .mockResolvedValue({ status: "ok", exact: [], near: [] });
      renderComposer();

      await user.type(screen.getByLabelText("Answer"), "Paris.");

      const retry = await screen.findByRole("button", { name: "Retry" });
      await user.click(retry);

      // A successful re-query with no matches clears the advisory entirely.
      await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    });

    it("debounces so continuous typing fires a single query for the latest answer", async () => {
      const user = userEvent.setup({ delay: null });
      vi.mocked(fetchMaterialMatches).mockResolvedValue({ status: "ok", exact: [], near: [] });
      renderComposer();

      // `delay: null` types the whole string without pausing, so the debounce never elapses between
      // keystrokes: exactly one query fires, and it carries the final Answer.
      await user.type(screen.getByLabelText("Answer"), "Paris");

      await waitFor(() => expect(fetchMaterialMatches).toHaveBeenCalledTimes(1));
      expect(documentText(vi.mocked(fetchMaterialMatches).mock.calls[0]![0])).toBe("Paris");
    });

    it("ignores a stale response that resolves after the answer moved on", async () => {
      const user = userEvent.setup({ delay: null });
      const deferred: Array<(value: MaterialMatchesResult) => void> = [];
      vi.mocked(fetchMaterialMatches).mockImplementation(
        () =>
          new Promise((resolve) => {
            deferred.push(resolve);
          })
      );
      renderComposer();

      const answer = screen.getByLabelText("Answer");
      await user.type(answer, "old");
      await waitFor(() => expect(deferred).toHaveLength(1));
      await user.clear(answer);
      await user.type(answer, "new");
      await waitFor(() => expect(deferred).toHaveLength(2));

      // The current (second) request resolves empty; then the stale (first) request resolves with a
      // match. The stale response must not resurrect the hint.
      deferred[1]!({ status: "ok", exact: [], near: [] });
      deferred[0]!({
        status: "ok",
        exact: [{ answerExcerpt: "old", cardCount: 1, noteId: "note-x", sourceContext: null }],
        near: []
      });
      await waitFor(() => expect(fetchMaterialMatches).toHaveBeenCalledTimes(2));

      expect(screen.queryByText(/This material is already in Notes\./)).toBeNull();
    });

    it("resolves the save without waiting on the advisory query", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({ result, status: "created" });
      const { onCreated } = renderComposer();

      await fillAndSave(user);

      // The authoritative save resolves the flow regardless of the advisory query's timing.
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(result, "created"));
      expect(createDirectCard).toHaveBeenCalledTimes(1);
    });
  });

  describe("related material disclosure", () => {
    it("offers Find related material only for an eligible single-word Answer", async () => {
      const user = userEvent.setup();
      renderComposer();

      await user.type(screen.getByLabelText("Answer"), "born");
      expect(screen.getByRole("button", { name: "Find related material" })).toBeTruthy();

      // A multi-word Answer is ineligible for lexical inspection, so the disclosure is not offered.
      await user.clear(screen.getByLabelText("Answer"));
      await user.type(screen.getByLabelText("Answer"), "born free");
      expect(screen.queryByRole("button", { name: "Find related material" })).toBeNull();
    });

    it("hides Find related material while a duplicate review is active", async () => {
      const user = userEvent.setup();
      vi.mocked(createDirectCard).mockResolvedValue({
        review: materialReview(),
        status: "needs_material_review"
      });
      renderComposer();

      await user.type(screen.getByLabelText("Answer"), "born");
      await user.type(screen.getByLabelText("Question"), "What is birth?");
      expect(screen.getByRole("button", { name: "Find related material" })).toBeTruthy();

      await user.click(screen.getByRole("button", { name: "Create card" }));
      await screen.findByRole("heading", { name: "This material is already in Notes" });

      // The disclosure is suppressed while a duplicate-review decision owns the surface.
      expect(screen.queryByRole("button", { name: "Find related material" })).toBeNull();
    });
  });
});
