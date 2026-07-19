// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addNoteToReview: vi.fn(),
  fetchNoteReviewStatus: vi.fn()
}));

// A fixed learner zone so the scheduled next-review label is deterministic (#676).
vi.mock("../../shared/preferences/useLearnerTimeZone", () => ({
  useLearnerTimeZone: () => "UTC"
}));

import type { NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";

import { addNoteToReview, fetchNoteReviewStatus } from "../notesReview/notesReviewApi";
import { NoteReviewSection } from "./NoteReviewSection";

const mockedFetchStatus = vi.mocked(fetchNoteReviewStatus);
const mockedAddToReview = vi.mocked(addNoteToReview);

function renderSection(): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <NoteReviewSection noteEntryId="note-7" question="brown fox" workEntryId="work-1" />
    </MemoryRouter>
  );
  return user;
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

describe("NoteReviewSection", () => {
  it("loads the status and offers to add a not-enrolled note to review", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "not_enrolled" });
    renderSection();

    expect(await screen.findByText("This note is not in review yet.")).toBeDefined();
    expect(mockedFetchStatus).toHaveBeenCalledWith("work-1", "note-7");
  });

  it("confirms the exact anchor snapshot as a read-only Question before adding, then reflects due", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedAddToReview.mockResolvedValue({ status: "due" });
    const user = renderSection();

    await user.click(await screen.findByRole("button", { name: "Add to review" }));

    // The confirmation shows the anchor snapshot labeled Question, with no editable field.
    expect(screen.getByText("Question")).toBeDefined();
    expect(screen.getByText("brown fox")).toBeDefined();
    expect(screen.queryByRole("textbox")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Add to review" }));

    await waitFor(() => expect(mockedAddToReview).toHaveBeenCalledWith("work-1", "note-7"));
    expect(await screen.findByText("Due now")).toBeDefined();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/notes/review");
  });

  it("cancels the confirmation without enrolling", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "not_enrolled" });
    const user = renderSection();

    await user.click(await screen.findByRole("button", { name: "Add to review" }));
    expect(screen.getByText("Question")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("Question")).toBeNull();
    expect(screen.getByText("This note is not in review yet.")).toBeDefined();
    expect(mockedAddToReview).not.toHaveBeenCalled();
  });

  it("surfaces a retryable error when enrollment fails, then succeeds on retry", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedAddToReview
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "due" });
    const user = renderSection();

    await user.click(await screen.findByRole("button", { name: "Add to review" }));
    await user.click(screen.getByRole("button", { name: "Add to review" }));

    expect(
      await screen.findByText("Could not add the note to review. Please try again.")
    ).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Add to review" }));

    expect(await screen.findByText("Due now")).toBeDefined();
    expect(mockedAddToReview).toHaveBeenCalledTimes(2);
  });

  it("shows the pending state while the enrollment request is in flight", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "not_enrolled" });
    let resolveAdd: (status: NoteReviewEnrollmentStatusDto) => void = () => {};
    mockedAddToReview.mockImplementation(
      () =>
        new Promise<NoteReviewEnrollmentStatusDto>((resolve) => {
          resolveAdd = resolve;
        })
    );
    const user = renderSection();

    await user.click(await screen.findByRole("button", { name: "Add to review" }));
    await user.click(screen.getByRole("button", { name: "Add to review" }));

    const addButton = screen.getAllByRole("button", {
      name: "Add to review"
    })[0] as HTMLButtonElement;
    await waitFor(() => expect(addButton.getAttribute("aria-busy")).toBe("true"));
    // Cancel is disabled while the enrollment is pending.
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    resolveAdd({ status: "due" });
    await screen.findByText("Due now");
  });

  it("renders the due state with a link to the review session", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "due" });
    renderSection();

    expect(await screen.findByText("Due now")).toBeDefined();
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/notes/review");
  });

  it("renders the scheduled state with a localized next-review date", async () => {
    mockedFetchStatus.mockResolvedValue({
      status: "scheduled",
      nextReviewAt: "2026-07-11T00:00:00.000Z"
    });
    renderSection();

    expect(await screen.findByText("Next review · July 11, 2026 at 12:00 AM")).toBeDefined();
  });

  it("renders the paused state", async () => {
    mockedFetchStatus.mockResolvedValue({ status: "paused" });
    renderSection();

    expect(await screen.findByText("Paused")).toBeDefined();
  });

  it("offers a retry when the status read fails, then loads on retry", async () => {
    mockedFetchStatus
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ status: "paused" });
    const user = renderSection();

    expect(await screen.findByText("Could not load the review status.")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Paused")).toBeDefined();
    expect(mockedFetchStatus).toHaveBeenCalledTimes(2);
  });
});
