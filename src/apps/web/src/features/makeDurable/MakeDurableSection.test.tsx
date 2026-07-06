// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./makeDurableApi", () => ({
  fetchMakeDurableCards: vi.fn(),
  reviewMakeDurableCard: vi.fn(),
  submitQuickCapture: vi.fn()
}));

import type { MakeDurableCardDto, QuickCaptureResultDto } from "@whetstone/contracts";

import { fetchMakeDurableCards, reviewMakeDurableCard, submitQuickCapture } from "./makeDurableApi";
import { MakeDurableSection } from "./MakeDurableSection";

const mockedFetch = vi.mocked(fetchMakeDurableCards);
const mockedSubmit = vi.mocked(submitQuickCapture);
const mockedReview = vi.mocked(reviewMakeDurableCard);

const card: MakeDurableCardDto = {
  proposalCandidateId: "cand-1",
  timelineEntryId: "entry-1",
  type: "phrase_chunk",
  target: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  reason: "a reusable status phrase",
  category: "work",
  tags: ["service-status"]
};

function captureResult(withCard: MakeDurableCardDto | null): QuickCaptureResultDto {
  return {
    card: withCard,
    timelineEntry: {
      entryId: "entry-1",
      createdAt: "2026-07-06T09:30:00.000Z",
      entryDate: "2026-07-06",
      inputMode: "typed",
      captureSource: "quick_capture",
      rawInputText: "the deploy failed",
      tidiedText: null,
      language: null,
      rawAudioPath: null
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
});

async function typeCapture(text: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Quick capture text"), text);
  await user.click(screen.getByRole("button", { name: "Capture" }));
}

describe("MakeDurableSection", () => {
  it("loads and shows pending cards on mount", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<MakeDurableSection />);

    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("keeps Capture disabled until there is text", async () => {
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    expect((screen.getByRole("button", { name: "Capture" }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it("submits a capture and shows the returned review card", async () => {
    mockedSubmit.mockResolvedValue(captureResult(card));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("I couldn't say it");

    expect(mockedSubmit).toHaveBeenCalledWith("I couldn't say it");
    expect(await screen.findByText("WorkInsight is back up now")).toBeTruthy();
  });

  it("shows no card when the capture yields no proposal", async () => {
    mockedSubmit.mockResolvedValue(captureResult(null));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("nothing special");

    expect(screen.queryByText("Make this durable?")).toBeNull();
  });

  it("surfaces a quiet error when the capture fails", async () => {
    mockedSubmit.mockRejectedValue(new Error("boom"));
    render(<MakeDurableSection />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalled());

    await typeCapture("try me");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't save your capture");
  });

  it("saves an approved card and removes it", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "saved" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("dismisses a card on Not useful now", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Not useful now" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "not_useful_now" });
    await waitFor(() => expect(screen.queryByText("WorkInsight is back up now")).toBeNull());
  });

  it("marks a card Wrong", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Wrong" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", { outcome: "wrong_hallucinated" });
  });

  it("edits the target and saves the edited payload", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockResolvedValue(null);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const targetInput = screen.getByLabelText("Target");
    await user.clear(targetInput);
    await user.type(targetInput, "It's back up now");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(mockedReview).toHaveBeenCalledWith("cand-1", {
      outcome: "edited_saved",
      editedPayload: {
        target: "It's back up now",
        cue: "a service is back",
        useContext: "reporting availability",
        category: "work",
        tags: ["service-status"]
      }
    });
  });

  it("cancels an edit without saving", async () => {
    mockedFetch.mockResolvedValue([card]);
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Target")).toBeNull();
    expect(mockedReview).not.toHaveBeenCalled();
  });

  it("surfaces a quiet error when a review action fails", async () => {
    mockedFetch.mockResolvedValue([card]);
    mockedReview.mockRejectedValue(new Error("nope"));
    render(<MakeDurableSection />);
    await screen.findByText("WorkInsight is back up now");

    await userEvent.setup().click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't record your choice");
  });
});
