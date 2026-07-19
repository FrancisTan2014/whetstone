// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../notesReview/notesReviewApi", () => ({
  addOwnedNoteToReview: vi.fn(),
  fetchOwnedNoteReviewStatus: vi.fn()
}));

vi.mock("./NoteReviewSettings", () => ({
  NoteReviewSettings: (props: { noteEntryId: string; onChanged: () => void }) => (
    <button onClick={() => props.onChanged()} type="button">
      settings-stub:{props.noteEntryId}
    </button>
  )
}));

// A fixed learner zone so the scheduled next-review label is deterministic (#676).
vi.mock("../../shared/preferences/useLearnerTimeZone", () => ({
  useLearnerTimeZone: () => "UTC"
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-01T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
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

  it("reuses an imported note's confirmed question read-only, sending no question (#661)", async () => {
    // An imported standalone note already owns a cardless prompt: its status carries the confirmed cue.
    mockedStatus.mockResolvedValue({ question: "What is a WAL?", status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    renderSection(standaloneNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));

    // The confirmed question is shown read-only — no free-text input to retype it.
    expect(screen.getByText("What is a WAL?")).toBeDefined();
    expect(screen.queryByLabelText("What should Whetstone ask you?")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    // Like an anchored note, it reuses the existing source server-side, so no question is sent.
    expect(mockedEnroll).toHaveBeenCalledWith("note-1", undefined);
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

    expect(await screen.findByText("Next review · July 11, 2026 at 12:00 AM")).toBeDefined();
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

  it("notifies the host after a successful enrollment so the list can refresh", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    mockedEnroll.mockResolvedValue({ status: "due" });
    const onEnrolled = vi.fn();
    render(
      <MemoryRouter>
        <OwnedNoteReviewSection note={anchoredNote()} onEnrolled={onEnrolled} />
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Add to review" }));

    await waitFor(() => expect(onEnrolled).toHaveBeenCalledTimes(1));
  });

  it("cancels the confirmation and returns to the invitation", async () => {
    mockedStatus.mockResolvedValue({ status: "not_enrolled" });
    renderSection(standaloneNote());

    await userEvent.click(await screen.findByRole("button", { name: "Add to review" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByText("This note is not in review yet.")).toBeDefined();
  });
});

describe("OwnedNoteReviewSection review-settings disclosure (#660)", () => {
  it("expands and collapses the review settings in place", async () => {
    mockedStatus.mockResolvedValue({ status: "paused" });
    renderSection(anchoredNote());

    const toggle = await screen.findByRole("button", { name: "Review settings" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("settings-stub:note-1")).toBeNull();

    await userEvent.click(toggle);
    expect(screen.getByText("settings-stub:note-1")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Hide review settings" }).getAttribute("aria-expanded")
    ).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Hide review settings" }));
    expect(screen.queryByText("settings-stub:note-1")).toBeNull();
  });

  it("refreshes the compact status and notifies the host when a setting changes", async () => {
    mockedStatus.mockResolvedValueOnce({ status: "paused" });
    mockedStatus.mockResolvedValueOnce({ status: "due" });
    const onEnrolled = vi.fn();
    render(
      <MemoryRouter>
        <OwnedNoteReviewSection note={anchoredNote()} onEnrolled={onEnrolled} />
      </MemoryRouter>
    );

    await userEvent.click(await screen.findByRole("button", { name: "Review settings" }));
    await userEvent.click(screen.getByText("settings-stub:note-1"));

    // The settings change re-reads the status (now due) and tells the host to refresh its row.
    await waitFor(() => expect(screen.getByText("Due now")).toBeDefined());
    expect(onEnrolled).toHaveBeenCalledTimes(1);
    expect(mockedStatus).toHaveBeenCalledTimes(2);
  });
});
