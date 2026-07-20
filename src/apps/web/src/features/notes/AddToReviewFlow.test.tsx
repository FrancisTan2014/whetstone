// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addOwnedNoteToReview: vi.fn(),
  fetchOwnedNoteReviewStatus: vi.fn()
}));

import { AddToReviewFlow } from "./AddToReviewFlow";
import { addOwnedNoteToReview, fetchOwnedNoteReviewStatus } from "../notesReview/notesReviewApi";

const mockedStatus = vi.mocked(fetchOwnedNoteReviewStatus);
const mockedEnroll = vi.mocked(addOwnedNoteToReview);

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("AddToReviewFlow", () => {
  it("renders nothing until the status resolves as not-enrolled", async () => {
    mockedStatus.mockResolvedValue({ status: "due" });
    const { container } = render(
      <AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot={null} />
    );
    await waitFor(() => expect(mockedStatus).toHaveBeenCalled());
    // An already-enrolled note offers no trigger — the toolbar slot stays empty.
    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing when the status read fails", async () => {
    mockedStatus.mockRejectedValue(new Error("boom"));
    const { container } = render(
      <AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot={null} />
    );
    await waitFor(() => expect(mockedStatus).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });

  it("enrolls an anchored note by reusing its exact source, sending no question", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    const onEnrolled = vi.fn();
    render(
      <AddToReviewFlow
        noteEntryId="note-1"
        onEnrolled={onEnrolled}
        sourceSnapshot="the exact source"
      />
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    // The source snapshot is shown read-only as the Question — never retyped.
    expect(screen.getByText("the exact source")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await waitFor(() => expect(mockedEnroll).toHaveBeenCalledWith("note-1", undefined));
    expect(onEnrolled).toHaveBeenCalled();
  });

  it("reuses an imported note's confirmed question read-only, sending no question", async () => {
    mockedStatus.mockResolvedValue({ question: "What is a WAL?", status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    render(<AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot={null} />);

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    expect(screen.getByText("What is a WAL?")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await waitFor(() => expect(mockedEnroll).toHaveBeenCalledWith("note-1", undefined));
  });

  it("requires a non-blank typed question for a plain standalone note", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    render(<AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot={null} />);

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    const input = screen.getByLabelText("What should Whetstone ask you?");
    const add = screen.getByRole("button", { name: "Add to review" });
    expect(add).toHaveProperty("disabled", true);

    await userEvent.type(input, "  What is a WAL?  ");
    expect(add).toHaveProperty("disabled", false);
    await userEvent.click(add);
    await waitFor(() => expect(mockedEnroll).toHaveBeenCalledWith("note-1", "What is a WAL?"));
  });

  it("reports a failed enrollment and keeps the form open to retry", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockRejectedValueOnce(new Error("offline"));
    render(
      <AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot="the source" />
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

    expect(
      await screen.findByText("Could not add the note to review. Please try again.")
    ).toBeDefined();
  });

  it("cancels the confirmation and clears any error", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockRejectedValueOnce(new Error("offline"));
    render(
      <AddToReviewFlow noteEntryId="note-1" onEnrolled={vi.fn()} sourceSnapshot="the source" />
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
    await screen.findByText("Could not add the note to review. Please try again.");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Back to the single trigger; the prior error is gone.
    expect(screen.queryByText("Could not add the note to review. Please try again.")).toBeNull();
    expect(screen.getByRole("button", { name: "Add to review" })).toBeDefined();
  });
});
