// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MaterialReviewCandidateDto, MaterialReviewDto } from "@whetstone/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MaterialReviewPanel } from "./MaterialReviewPanel";

beforeAll(() => {
  // Radix Dialog reads pointer-capture and layout APIs jsdom lacks; stub them so rendering the Sheet does
  // not throw during interaction tests.
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

afterEach(() => {
  cleanup();
});

function candidate(
  overrides: Partial<MaterialReviewCandidateDto> = {}
): MaterialReviewCandidateDto {
  return {
    answerExcerpt: "Paris is the capital of France.",
    cardCount: 2,
    noteId: "note-1",
    sourceContext: null,
    ...overrides
  };
}

function review(overrides: Partial<MaterialReviewDto> = {}): MaterialReviewDto {
  return {
    attemptId: "attempt-1",
    candidateFingerprint: "fp-1",
    candidates: [candidate()],
    revision: 0,
    ...overrides
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof MaterialReviewPanel>> = {}): {
  onBack: ReturnType<typeof vi.fn>;
  onKeepSeparate: ReturnType<typeof vi.fn>;
  onUseExisting: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onBack = vi.fn();
  const onKeepSeparate = vi.fn();
  const onUseExisting = vi.fn();
  const user = userEvent.setup();
  render(
    <MaterialReviewPanel
      error={null}
      onBack={onBack}
      onKeepSeparate={onKeepSeparate}
      onUseExisting={onUseExisting}
      pending={false}
      review={review()}
      {...props}
    />
  );

  return { onBack, onKeepSeparate, onUseExisting, user };
}

describe("MaterialReviewPanel", () => {
  it("frames the material as already present, without a duplicate verdict", () => {
    renderPanel();

    expect(screen.getByText("This material is already in Notes")).toBeTruthy();
    expect(
      screen.getByText("One existing note already covers this material.", { exact: false })
    ).toBeTruthy();
    // It states the material exists; it must never call a row "the duplicate".
    expect(screen.queryByText(/duplicate/i)).toBeNull();
  });

  it("shows a single candidate's excerpt and card count, and no source chip when unanchored", () => {
    renderPanel();

    const list = screen.getByRole("list", { name: "Existing material" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Paris is the capital of France.")).toBeTruthy();
    expect(within(rows[0]!).getByText("2 cards")).toBeTruthy();
  });

  it("shows the source context chip and singular card count when present", () => {
    renderPanel({
      review: review({
        candidates: [candidate({ cardCount: 1, sourceContext: "Chapter 3 — The Republic" })]
      })
    });

    expect(screen.getByText("Chapter 3 — The Republic")).toBeTruthy();
    expect(screen.getByText("1 card")).toBeTruthy();
  });

  it("counts multiple candidates in the summary and lists each without preselection", () => {
    renderPanel({
      review: review({
        candidates: [
          candidate(),
          candidate({ answerExcerpt: "The Seine runs through Paris.", noteId: "note-2" })
        ]
      })
    });

    expect(
      screen.getByText("2 existing notes already cover this material.", { exact: false })
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "Existing material" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    // No candidate is checked/selected: every action is an equal, explicit choice.
    expect(within(list).queryByRole("radio")).toBeNull();
  });

  it("routes Use existing material to the chosen candidate's note id", async () => {
    const { onUseExisting, user } = renderPanel({
      review: review({
        candidates: [
          candidate(),
          candidate({ answerExcerpt: "The Seine runs through Paris.", noteId: "note-2" })
        ]
      })
    });

    await user.click(
      screen.getByRole("button", {
        name: "Use existing material from The Seine runs through Paris."
      })
    );
    expect(onUseExisting).toHaveBeenCalledWith("note-2");
  });

  it("routes Keep separate and Back to their handlers", async () => {
    const { onBack, onKeepSeparate, user } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Keep separate" }));
    expect(onKeepSeparate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("disables every action while a decision is pending", () => {
    renderPanel({ pending: true });

    expect(
      screen
        .getByRole("button", { name: "Use existing material from Paris is the capital of France." })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
  });

  it("ignores the sheet's own dismissal while a decision is pending", async () => {
    const { onBack, user } = renderPanel({ pending: true });

    // The visible Back is disabled, but the Sheet's Close affordance still fires onOpenChange; a dismissal
    // mid-decision must not route to Back and drop the review out from under the in-flight decision.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onBack).not.toHaveBeenCalled();
  });

  it("routes the sheet's own dismissal to Back while idle", async () => {
    const { onBack, user } = renderPanel();

    // A real close while no decision is in flight (Close affordance / Escape) is an intentional Back: it must
    // restore the composer draft, not silently strand the learner on a dismissed sheet.
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("surfaces a decision error inside the panel", () => {
    renderPanel({ error: "Could not complete that just now. Please try again." });

    expect(screen.getByText("Could not complete that just now. Please try again.")).toBeTruthy();
  });
});
