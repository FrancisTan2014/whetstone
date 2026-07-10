// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationPassageApi", () => ({
  reviewPassage: vi.fn()
}));

import type { DueRecitationPassageDto } from "@whetstone/contracts";
import { recitationRatingChoices } from "@whetstone/domain";

import { RecitationReviewCard } from "./RecitationReviewCard";
import { reviewPassage } from "./recitationPassageApi";

const mockedReview = vi.mocked(reviewPassage);

function makePassage(overrides: Partial<DueRecitationPassageDto> = {}): DueRecitationPassageDto {
  return {
    anchorStatus: "anchored",
    context: "Aesop's Fables · The Fox and the Grapes",
    defaultCueStrength: "opening",
    passageEntryId: "passage-2",
    planEntryId: "plan-1",
    precedingText: "Earlier line here.",
    targetText: "The quick brown fox jumps.",
    workTitle: "Aesop's Fables",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReview.mockResolvedValue({} as never);
});

afterEach(() => {
  cleanup();
});

describe("RecitationReviewCard", () => {
  it("shows the opening cue and hides the target before reveal", () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    expect(screen.getByLabelText("Cue").textContent).toBe("The qu");
    expect(screen.queryByText("The quick brown fox jumps.")).toBeNull();
    expect(screen.queryByRole("button", { name: recitationRatingChoices[0].label })).toBeNull();
  });

  it("switches the cue to the preceding line without revealing the target", async () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Preceding line" }));

    expect(screen.getByLabelText("Cue").textContent).toBe("Earlier line here.");
    expect(screen.queryByText("The quick brown fox jumps.")).toBeNull();
  });

  it("shows a calm hint when the chosen cue is empty", async () => {
    render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({ defaultCueStrength: "preceding_line", precedingText: "" })}
      />
    );

    expect(screen.getByLabelText("Cue").textContent).toBe("No cue — begin from memory.");
  });

  it("reveals the target and offers the four ratings", async () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByText("The quick brown fox jumps.")).toBeDefined();
    for (const choice of recitationRatingChoices) {
      expect(screen.getByRole("button", { name: choice.label })).toBeDefined();
    }
  });

  it("records each rating with the attempted cue strength then advances", async () => {
    for (const choice of recitationRatingChoices) {
      const onReviewed = vi.fn();
      render(<RecitationReviewCard onReviewed={onReviewed} passage={makePassage()} />);
      await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
      await userEvent.click(screen.getByRole("button", { name: choice.label }));

      expect(mockedReview).toHaveBeenCalledWith("passage-2", choice.rating, "opening");
      expect(onReviewed).toHaveBeenCalledTimes(1);
      cleanup();
      mockedReview.mockClear();
    }
  });

  it("records the rating with a switched cue strength", async () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Preceding line" }));
    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await userEvent.click(
      screen.getByRole("button", { name: recitationRatingChoices[0].label })
    );

    expect(mockedReview).toHaveBeenCalledWith("passage-2", "again", "preceding_line");
  });

  it("surfaces an error and does not advance when the review fails", async () => {
    mockedReview.mockRejectedValue(new Error("boom"));
    const onReviewed = vi.fn();
    render(<RecitationReviewCard onReviewed={onReviewed} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await userEvent.click(
      screen.getByRole("button", { name: recitationRatingChoices[0].label })
    );

    expect(await screen.findByRole("alert")).toBeDefined();
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it("shows a repair notice for a drifted passage and offers no practice controls", () => {
    render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({ anchorStatus: "needs_repair" })}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain("needs repair");
    expect(screen.queryByRole("button", { name: "Reveal" })).toBeNull();
  });
});
