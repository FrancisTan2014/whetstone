// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addOwnedNoteToReview: vi.fn(),
  fetchOwnedNoteReviewStatus: vi.fn()
}));

import type { NoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { addOwnedNoteToReview, fetchOwnedNoteReviewStatus } from "../notesReview/notesReviewApi";
import { OwnedNoteReviewSection } from "./OwnedNoteReviewSection";

const mockedStatus = vi.mocked(fetchOwnedNoteReviewStatus);
const mockedEnroll = vi.mocked(addOwnedNoteToReview);

function anchoredNote(): NoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("block-1"),
      contextSnapshot: "context",
      endBlockEntryId: toEntryId("block-1"),
      selectedTextSnapshot: "the exact source"
    },
    blockEntryId: toEntryId("block-1"),
    bodyDoc: createTextDocument("body"),
    bodyText: "body",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z"
  };
}

function standaloneNote(): NoteDto {
  return { ...anchoredNote(), anchor: null, blockEntryId: null, captureSource: "manual" };
}

function renderSection(note: NoteDto): void {
  render(
    <MemoryRouter>
      <OwnedNoteReviewSection note={note} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("OwnedNoteReviewSection (#659)", () => {
  it("enrolls an anchored note by reusing its exact source, sending no question", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    renderSection(anchoredNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    // The anchor snapshot is shown as the read-only Question — the learner never retypes the cue.
    expect(screen.getByText("the exact source")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    expect(mockedEnroll).toHaveBeenCalledWith("note-1", undefined);
    expect(screen.getByRole("link", { name: "Review" }).getAttribute("href")).toBe("/notes/review");
  });

  it("requires a non-blank question to enroll a standalone note", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({
      nextReviewAt: "2026-07-11T00:00:00.000Z",
      status: "scheduled"
    });
    renderSection(standaloneNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));

    const input = screen.getByLabelText("What should Whetstone ask you?");
    const add = screen.getByRole("button", { name: "Add to review" });
    expect(add).toHaveProperty("disabled", true);

    await userEvent.type(input, "What is a WAL?");
    expect(add).toHaveProperty("disabled", false);
    await userEvent.click(add);

    await waitFor(() => expect(screen.getByText(/Next review/)).toBeDefined());
    expect(mockedEnroll).toHaveBeenCalledWith("note-1", "What is a WAL?");
  });

  it("shows Due now with a Review link when the note is already due", async () => {
    mockedStatus.mockResolvedValue({ status: "due" });
    renderSection(anchoredNote());

    expect(await screen.findByText("Due now")).toBeDefined();
    expect(screen.getByRole("link", { name: "Review" })).toBeDefined();
  });

  it("shows the next review date when scheduled", async () => {
    mockedStatus.mockResolvedValue({
      nextReviewAt: "2026-07-11T00:00:00.000Z",
      status: "scheduled"
    });
    renderSection(anchoredNote());

    expect(await screen.findByText(/Next review ·/)).toBeDefined();
  });

  it("shows Paused when the note is withheld from the due scan", async () => {
    mockedStatus.mockResolvedValue({ status: "paused" });
    renderSection(anchoredNote());

    expect(await screen.findByText("Paused")).toBeDefined();
  });

  it("offers a retry when the status cannot be loaded", async () => {
    mockedStatus.mockRejectedValueOnce(new Error("boom"));
    mockedStatus.mockResolvedValueOnce({ status: "not_enrolled" });
    renderSection(anchoredNote());

    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByText("This note is not in review yet.")).toBeDefined();
  });

  it("surfaces an enrollment failure without leaving the confirmation", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockRejectedValue(new Error("boom"));
    renderSection(anchoredNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

    expect(
      await screen.findByText("Could not add the note to review. Please try again.")
    ).toBeDefined();
  });

  it("cancels the confirmation and returns to the invitation", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    renderSection(standaloneNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("This note is not in review yet.")).toBeDefined();
  });
});
