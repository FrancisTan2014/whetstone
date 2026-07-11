// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  addPromptToNote: vi.fn()
}));

import type { MemoryNoteDetailDto } from "@whetstone/contracts";

import { addPromptToNote } from "./memoryApi";
import { MemoryAddDirection } from "./MemoryAddDirection";

const mockedAdd = vi.mocked(addPromptToNote);

const detail: MemoryNoteDetailDto = {
  note: {
    bodyText: "spill the beans",
    captureSource: "manual",
    derivedFromEntryId: null,
    noteId: "note-1"
  },
  prompts: []
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedAdd.mockResolvedValue(detail);
});

afterEach(() => {
  cleanup();
});

describe("MemoryAddDirection", () => {
  it("does not submit when the cue is blank", async () => {
    const user = userEvent.setup();
    render(<MemoryAddDirection noteId="note-1" onAdded={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Add direction" }));

    expect(mockedAdd).not.toHaveBeenCalled();
  });

  it("adds an answerless direction as a draft, clears, and reloads", async () => {
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<MemoryAddDirection noteId="note-1" onAdded={onAdded} />);

    await user.type(screen.getByLabelText("Cue"), "mitigation");
    await user.click(screen.getByRole("button", { name: "Add direction" }));

    await waitFor(() =>
      expect(mockedAdd).toHaveBeenCalledWith("note-1", { cueText: "mitigation" })
    );
    expect(onAdded).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((screen.getByLabelText("Cue") as HTMLInputElement).value).toBe(""));
  });

  it("adds an answered direction with both fields", async () => {
    const user = userEvent.setup();
    render(<MemoryAddDirection noteId="note-1" onAdded={vi.fn()} />);

    await user.type(screen.getByLabelText("Cue"), "mitigation");
    await user.type(screen.getByLabelText("Answer"), "a way to reduce risk");
    await user.click(screen.getByRole("button", { name: "Add direction" }));

    await waitFor(() =>
      expect(mockedAdd).toHaveBeenCalledWith("note-1", {
        answerText: "a way to reduce risk",
        cueText: "mitigation"
      })
    );
  });

  it("surfaces an error when adding fails", async () => {
    mockedAdd.mockRejectedValue(new Error("boom"));
    const onAdded = vi.fn();
    const user = userEvent.setup();
    render(<MemoryAddDirection noteId="note-1" onAdded={onAdded} />);

    await user.type(screen.getByLabelText("Cue"), "mitigation");
    await user.click(screen.getByRole("button", { name: "Add direction" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not add that direction/);
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("stays stable across a parent rerender (stable memoized props)", () => {
    const onAdded = vi.fn();
    const view = render(<MemoryAddDirection noteId="note-1" onAdded={onAdded} />);

    expect(screen.getByRole("button", { name: "Add direction" })).toBeDefined();
    view.rerender(<MemoryAddDirection noteId="note-1" onAdded={onAdded} />);

    expect(screen.getByRole("button", { name: "Add direction" })).toBeDefined();
  });
});
