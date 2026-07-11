// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./recitationPassageApi", () => ({
  reviewPassage: vi.fn(),
  setSupportLevel: vi.fn()
}));

import type { DueRecitationPassageDto } from "@whetstone/contracts";
import { recitationRatingChoices } from "@whetstone/domain";

import { RecitationReviewCard } from "./RecitationReviewCard";
import { reviewPassage, setSupportLevel } from "./recitationPassageApi";

const mockedReview = vi.mocked(reviewPassage);
const mockedSetSupport = vi.mocked(setSupportLevel);

function makePassage(overrides: Partial<DueRecitationPassageDto> = {}): DueRecitationPassageDto {
  return {
    anchorStatus: "anchored",
    context: "Aesop's Fables · The Fox and the Grapes",
    defaultCueStrength: "opening",
    passageEntryId: "passage-2",
    planEntryId: "plan-1",
    precedingText: "Earlier line here.",
    supportLevel: "full",
    targetText: "The quick brown fox jumps.",
    workTitle: "Aesop's Fables",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedReview.mockResolvedValue({} as never);
  mockedSetSupport.mockResolvedValue("full");
});

afterEach(() => {
  cleanup();
});

describe("RecitationReviewCard", () => {
  it("opens at the remembered level and shows the whole passage at full support", () => {
    const { container } = render(
      <RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />
    );

    expect(screen.getByRole("button", { name: "Full text" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(screen.getByText("The quick brown fox jumps.")).toBeDefined();
    expect(container.querySelector(".sr-only")).toBeNull();
    expect(screen.queryByRole("button", { name: recitationRatingChoices[0].label })).toBeNull();
  });

  it("opens at a previously chosen reduced level, showing only the first half of the clause", () => {
    const { container } = render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({ supportLevel: "reduced" })}
      />
    );

    expect(screen.getByRole("button", { name: "Reduced" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(container.textContent).toContain("The quick brown");
    expect(container.textContent).not.toContain("jumps");
    // Two masked words (fox, jumps) each announce themselves as hidden text.
    expect(screen.getAllByText("hidden text")).toHaveLength(2);
  });

  it("reduces to the first word and masks the rest, announcing each gap as hidden text", async () => {
    const { container } = render(
      <RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />
    );

    await userEvent.click(screen.getByRole("button", { name: "First characters" }));

    expect(mockedSetSupport).toHaveBeenCalledWith("passage-2", "first");
    expect(container.textContent).toContain("The");
    expect(container.textContent).not.toContain("quick");
    // The, then quick/brown/fox/jumps masked -> four hidden runs.
    expect(screen.getAllByText("hidden text")).toHaveLength(4);
    // Choosing a level is a preference: it never reveals or grades.
    expect(mockedReview).not.toHaveBeenCalled();
    expect(screen.queryByText("The quick brown fox jumps.")).toBeNull();
  });

  it("fades a Chinese passage by character within each clause", () => {
    const { container } = render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({ supportLevel: "first", targetText: "床前明月光" })}
      />
    );

    // First character shown; the remaining four masked as one contiguous hidden run.
    expect(container.textContent).toContain("床");
    expect(container.textContent).not.toContain("月");
    expect(screen.getAllByText("hidden text")).toHaveLength(1);
  });

  it("preserves blank lines in the passage shape when fading", () => {
    const { container } = render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({ supportLevel: "reduced", targetText: "Line one.\n\nLine two." })}
      />
    );

    // The blank middle line is kept (as a non-breaking space) so a reduced passage holds its shape.
    expect(container.textContent).toContain("\u00a0");
    expect(container.textContent).toContain("Line");
    expect(screen.getAllByText("hidden text").length).toBeGreaterThan(0);
  });

  it("shows the external cue and none of the target at the hidden level", async () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Hidden" }));

    expect(mockedSetSupport).toHaveBeenCalledWith("passage-2", "hidden");
    expect(screen.getByLabelText("Cue").textContent).toBe("The qu");
    expect(screen.queryByText("hidden text")).toBeNull();
  });

  it("shows a calm hint when the hidden-level cue is empty", () => {
    render(
      <RecitationReviewCard
        onReviewed={vi.fn()}
        passage={makePassage({
          defaultCueStrength: "preceding_line",
          precedingText: "",
          supportLevel: "hidden"
        })}
      />
    );

    expect(screen.getByLabelText("Cue").textContent).toBe("No cue — begin from memory.");
  });

  it("keeps the chosen level applied even when persisting the preference fails", async () => {
    mockedSetSupport.mockRejectedValue(new Error("offline"));
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Hidden" }));

    expect(screen.getByLabelText("Cue").textContent).toBe("The qu");
    expect(screen.getByRole("button", { name: "Reveal" })).toBeDefined();
  });

  it("reveals the exact target and offers the four ratings", async () => {
    render(<RecitationReviewCard onReviewed={vi.fn()} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByText("The quick brown fox jumps.")).toBeDefined();
    for (const choice of recitationRatingChoices) {
      expect(screen.getByRole("button", { name: choice.label })).toBeDefined();
    }
  });

  it("reveals the exact target even after fading it down first", async () => {
    render(
      <RecitationReviewCard onReviewed={vi.fn()} passage={makePassage({ supportLevel: "first" })} />
    );

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));

    expect(screen.getByText("The quick brown fox jumps.")).toBeDefined();
  });

  it("records each rating with the passage's cue strength then advances", async () => {
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

  it("surfaces an error and does not advance when the review fails", async () => {
    mockedReview.mockRejectedValue(new Error("boom"));
    const onReviewed = vi.fn();
    render(<RecitationReviewCard onReviewed={onReviewed} passage={makePassage()} />);

    await userEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await userEvent.click(screen.getByRole("button", { name: recitationRatingChoices[0].label }));

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
