// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./memoryApi", () => ({
  deleteMemoryNote: vi.fn(),
  editMemoryNote: vi.fn(),
  getMemoryNote: vi.fn()
}));

vi.mock("./MemoryPromptRow", () => ({
  MemoryPromptRow: ({
    onSaved,
    prompt
  }: {
    onSaved: () => void;
    prompt: { promptId: string };
  }): React.JSX.Element => (
    <li>
      <button onClick={onSaved} type="button">
        reload from {prompt.promptId}
      </button>
    </li>
  )
}));

vi.mock("./MemoryAddDirection", () => ({
  MemoryAddDirection: ({ onAdded }: { onAdded: () => void }): React.JSX.Element => (
    <button onClick={onAdded} type="button">
      stub add direction
    </button>
  )
}));

import type { MemoryNoteDetailDto } from "@whetstone/contracts";

import { deleteMemoryNote, editMemoryNote, getMemoryNote } from "./memoryApi";
import { MemoryNoteDetail } from "./MemoryNoteDetail";

const mockedGet = vi.mocked(getMemoryNote);
const mockedEdit = vi.mocked(editMemoryNote);
const mockedDelete = vi.mocked(deleteMemoryNote);

function makeDetail(bodyText = "spill the beans"): MemoryNoteDetailDto {
  return {
    note: { bodyText, captureSource: "manual", derivedFromEntryId: null, noteId: "note-1" },
    prompts: [
      {
        answerText: null,
        cardStatus: null,
        chunkId: null,
        cueText: "spill the beans",
        lifecycle: "draft",
        noteId: "note-1",
        promptId: "prompt-1",
        review: null
      }
    ]
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGet.mockResolvedValue(makeDetail());
  mockedEdit.mockResolvedValue(makeDetail());
  mockedDelete.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("MemoryNoteDetail", () => {
  it("shows a loading state while the note opens", () => {
    mockedGet.mockReturnValue(new Promise<MemoryNoteDetailDto>(() => {}));
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    expect(screen.getByText(/Opening this memory/)).toBeDefined();
  });

  it("shows an error state when the note cannot open", async () => {
    mockedGet.mockRejectedValue(new Error("boom"));
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    expect((await screen.findByRole("alert")).textContent).toMatch(/Could not open this memory/);
  });

  it("renders the fragment, its prompts, and the add-a-direction form", async () => {
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    const fragment = (await screen.findByLabelText("Fragment")) as HTMLTextAreaElement;
    expect(fragment.value).toBe("spill the beans");
    expect(screen.getByRole("button", { name: "reload from prompt-1" })).toBeDefined();
    expect(screen.getByRole("button", { name: "stub add direction" })).toBeDefined();
  });

  it("saves an edited fragment and reflects the returned body", async () => {
    mockedEdit.mockResolvedValue(makeDetail("new fragment"));
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    const fragment = (await screen.findByLabelText("Fragment")) as HTMLTextAreaElement;
    await user.clear(fragment);
    await user.type(fragment, "new fragment");
    await user.click(screen.getByRole("button", { name: "Save fragment" }));

    await waitFor(() =>
      expect(mockedEdit).toHaveBeenCalledWith("note-1", { noteText: "new fragment" })
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Fragment") as HTMLTextAreaElement).value).toBe("new fragment")
    );
  });

  it("surfaces an error when saving the fragment fails", async () => {
    mockedEdit.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    await screen.findByLabelText("Fragment");
    await user.click(screen.getByRole("button", { name: "Save fragment" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/did not go through/);
  });

  it("disables Save fragment when the body is cleared", async () => {
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    await user.clear(await screen.findByLabelText("Fragment"));

    expect(
      (screen.getByRole("button", { name: "Save fragment" }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("deletes the note and closes back to the list", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={onClose} />);

    await screen.findByLabelText("Fragment");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith("note-1"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("surfaces an error when deleting fails", async () => {
    mockedDelete.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={onClose} />);

    await screen.findByLabelText("Fragment");
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect((await screen.findByRole("alert")).textContent).toMatch(/did not go through/);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reloads the detail after a prompt is saved", async () => {
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    await screen.findByLabelText("Fragment");
    expect(mockedGet).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "reload from prompt-1" }));

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
  });

  it("reloads the detail after a direction is added", async () => {
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={vi.fn()} />);

    await screen.findByLabelText("Fragment");
    await user.click(screen.getByRole("button", { name: "stub add direction" }));

    await waitFor(() => expect(mockedGet).toHaveBeenCalledTimes(2));
  });

  it("closes when Back to memory is pressed", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<MemoryNoteDetail noteId="note-1" onClose={onClose} />);

    await user.click(screen.getByRole("button", { name: "Back to memory" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
