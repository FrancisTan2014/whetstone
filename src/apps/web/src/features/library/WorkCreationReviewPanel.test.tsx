// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkCreationReviewDto, WorkDuplicateCandidateReviewDto } from "@whetstone/contracts";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkCreationReviewPanel } from "./WorkCreationReviewPanel";

beforeAll(() => {
  // Radix Dialog reads pointer-capture and layout APIs jsdom lacks; stub them so rendering the Sheet
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

afterEach(() => {
  cleanup();
});

function candidate(
  overrides: Partial<WorkDuplicateCandidateReviewDto> = {}
): WorkDuplicateCandidateReviewDto {
  const { evidence, ...rest } = overrides;

  return {
    author: { id: "author-2", name: "Charles Dickens" },
    entryId: "work-2",
    language: "en",
    matchTier: "same_author_fuzzy",
    origin: "imported",
    title: "Great Expectations",
    workType: "book",
    ...rest,
    evidence: {
      editionMarkerDifferences: [],
      languageDiffers: false,
      sameAuthor: true,
      titleSimilarity: 0.91,
      workTypeDiffers: false,
      ...evidence
    }
  };
}

function review(overrides: Partial<WorkCreationReviewDto> = {}): WorkCreationReviewDto {
  return {
    attemptId: "attempt-1",
    candidateFingerprint: "fp-1",
    candidates: [candidate()],
    proposed: {
      authorName: "Charles Dickens",
      language: "en",
      title: "Great Expectations",
      workType: "book"
    },
    revision: 0,
    sourceFileName: "great-expectations.md",
    ...overrides
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof WorkCreationReviewPanel>> = {}): {
  onBack: ReturnType<typeof vi.fn>;
  onKeepSeparate: ReturnType<typeof vi.fn>;
  onOpenExisting: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onBack = vi.fn();
  const onKeepSeparate = vi.fn();
  const onOpenExisting = vi.fn();
  const user = userEvent.setup();
  render(
    <WorkCreationReviewPanel
      onBack={onBack}
      onKeepSeparate={onKeepSeparate}
      onOpenExisting={onOpenExisting}
      pending={false}
      review={review()}
      {...props}
    />
  );

  return { onBack, onKeepSeparate, onOpenExisting, user };
}

describe("WorkCreationReviewPanel", () => {
  it("presents the proposal, filename, and a single candidate's full identity", () => {
    renderPanel();

    expect(screen.getByText("Possible duplicate")).toBeTruthy();
    expect(screen.getByText("great-expectations.md")).toBeTruthy();
    expect(
      screen.getByText("This work looks similar to one already in your library.", { exact: false })
    ).toBeTruthy();

    const list = screen.getByRole("list", { name: "Possible duplicates" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Great Expectations")).toBeTruthy();
    expect(within(rows[0]!).getByText("Charles Dickens · English · book · Imported")).toBeTruthy();
    expect(within(rows[0]!).getByText("Similar title, same author")).toBeTruthy();
  });

  it("names the reviewed upload from the review DTO, never a separately-passed file", () => {
    // The panel is framed only by the review DTO's own filename. On a resumed single-active-attempt race
    // the DTO carries the older attempt's upload name, so the two uploads can't be conflated in the UI.
    renderPanel({ review: review({ sourceFileName: "older-pending-upload.md" }) });

    expect(screen.getByText("older-pending-upload.md")).toBeTruthy();
  });

  it("counts multiple candidates in the summary copy", () => {
    renderPanel({
      review: review({
        candidates: [candidate(), candidate({ entryId: "work-3", title: "David Copperfield" })]
      })
    });

    expect(
      screen.getByText("This work looks similar to 2 already in your library.", { exact: false })
    ).toBeTruthy();
    const list = screen.getByRole("list", { name: "Possible duplicates" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows only the factual evidence that distinguishes or corroborates a candidate", () => {
    renderPanel({
      review: review({
        candidates: [
          candidate({
            evidence: {
              editionMarkerDifferences: ["2nd", "revised"],
              languageDiffers: true,
              sameAuthor: false,
              titleSimilarity: 0.72,
              workTypeDiffers: true
            },
            matchTier: "cross_author_fuzzy"
          })
        ]
      })
    });

    expect(screen.getByText("Title match 72%")).toBeTruthy();
    expect(screen.getByText("Different author")).toBeTruthy();
    expect(screen.getByText("Different language")).toBeTruthy();
    expect(screen.getByText("Different type")).toBeTruthy();
    expect(screen.getByText("Edition differs: 2nd, revised")).toBeTruthy();
    expect(screen.getByText("Similar title, different author")).toBeTruthy();
  });

  it("omits difference facts and reports Same author when nothing differs", () => {
    renderPanel();

    expect(screen.getByText("Same author")).toBeTruthy();
    expect(screen.queryByText("Different language")).toBeNull();
    expect(screen.queryByText("Different type")).toBeNull();
    expect(screen.queryByText(/^Edition differs/)).toBeNull();
  });

  it("routes Open existing to the chosen candidate's entry id", async () => {
    const { onOpenExisting, user } = renderPanel({
      review: review({
        candidates: [candidate(), candidate({ entryId: "work-3", title: "David Copperfield" })]
      })
    });

    await user.click(screen.getByRole("button", { name: "Open existing “David Copperfield”" }));
    expect(onOpenExisting).toHaveBeenCalledWith("work-3");
  });

  it("routes Keep separate and Back to their handlers", async () => {
    const { onBack, onKeepSeparate, user } = renderPanel();

    await user.click(screen.getByRole("button", { name: "Keep separate" }));
    expect(onKeepSeparate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("treats an Escape dismissal as Back", async () => {
    const { onBack, user } = renderPanel();

    await user.keyboard("{Escape}");
    expect(onBack).toHaveBeenCalled();
  });

  it("ignores a Sheet dismissal while a decision is pending so Back cannot cancel it", async () => {
    const { onBack, user } = renderPanel({ pending: true });

    // Escape, the Close control, and the overlay all route through the Sheet's dismissal path. While a
    // decision is in flight none of them may reach Back — otherwise a close would cancel the still-pending
    // attempt and delete the staged upload out from under the decision the learner just submitted.
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onBack).not.toHaveBeenCalled();
  });

  it("disables every action while a decision is pending", () => {
    renderPanel({ pending: true });

    expect(screen.getByRole("button", { name: /Open existing/ }).hasAttribute("disabled")).toBe(
      true
    );
    expect(screen.getByRole("button", { name: "Back" }).hasAttribute("disabled")).toBe(true);
    const keepSeparate = screen.getByRole("button", { name: "Keep separate" });
    expect(keepSeparate.hasAttribute("disabled")).toBe(true);
    expect(keepSeparate.getAttribute("aria-busy")).toBe("true");
  });
});
