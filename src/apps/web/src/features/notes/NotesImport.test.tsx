// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  importNotes: vi.fn(),
  suggestGloss: vi.fn()
}));

vi.mock("../../shared/editor", async () => {
  const { createTextDocument, documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
    }) => {
      const [value, setValue] = React.useState(() => documentText(document as never));
      React.useEffect(() => {
        const incoming = documentText(document as never);
        setValue((current) => (current === incoming ? current : incoming));
      }, [document]);
      return React.createElement("textarea", {
        "aria-label": ariaLabel,
        onChange: (event: { target: { value: string } }) => {
          setValue(event.target.value);
          onChange(createTextDocument(event.target.value));
        },
        value
      });
    }
  };
});

import type { ImportNotesRequest, ImportNotesResultDto } from "@whetstone/contracts";
import { documentText } from "@whetstone/document";

import { importNotes, suggestGloss } from "./notesApi";
import { NotesImport } from "./NotesImport";

const mockedImport = vi.mocked(importNotes);
const mockedSuggest = vi.mocked(suggestGloss);

const result: ImportNotesResultDto = {
  imported: [{ noteEntryId: "note-1", promptId: "prompt-1" }]
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

async function paste(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  await user.click(screen.getByLabelText("Paste your list"));
  await user.paste(text);
  await user.click(screen.getByRole("button", { name: "Preview" }));
}

function itemsOf(request: ImportNotesRequest): ReadonlyArray<{ question: string; note: string }> {
  return request.items.map((item) => ({
    note: documentText(item.noteDoc),
    question: documentText(item.questionDoc)
  }));
}

describe("NotesImport", () => {
  it("previews pasted rows, folds refined Question/Note edits, and imports the batch atomically", async () => {
    const user = userEvent.setup();
    mockedImport.mockResolvedValue(result);
    const onImported = vi.fn();
    render(<NotesImport onCancel={vi.fn()} onImported={onImported} />);

    await paste(user, "per -> each\nquorum -> a majority of replicas");

    const questions = screen.getAllByLabelText("Question");
    const notes = screen.getAllByLabelText("Note");
    expect(questions).toHaveLength(2);

    // Refine both fields, then import.
    await user.clear(questions[0]!);
    await user.type(questions[0]!, "What is per?");
    await user.clear(notes[0]!);
    await user.type(notes[0]!, "each");

    await user.click(screen.getByRole("button", { name: /^Import 2$/ }));

    await waitFor(() => expect(mockedImport).toHaveBeenCalledTimes(1));
    expect(itemsOf(mockedImport.mock.calls[0]![0])).toEqual([
      { note: "each", question: "What is per?" },
      { note: "a majority of replicas", question: "quorum" }
    ]);
    expect(onImported).toHaveBeenCalledWith(result);
  });

  it("blocks import while any row is incomplete and flags it inline", async () => {
    const user = userEvent.setup();
    mockedImport.mockResolvedValue(result);
    const onImported = vi.fn();
    render(<NotesImport onCancel={vi.fn()} onImported={onImported} />);

    // A bare heading has no note yet.
    await paste(user, "serendipity");
    expect(screen.getByText("Add a note, or remove this row.")).toBeDefined();

    // Submitting an incomplete batch imports nothing and explains why.
    await user.click(screen.getByRole("button", { name: /^Import 0$/ }));
    expect(mockedImport).not.toHaveBeenCalled();
    expect(
      screen.getByText("Give every row a question and a note, or remove it, before importing.")
    ).toBeDefined();

    // Completing the row clears the flag and lets it import.
    await user.type(screen.getByLabelText("Note"), "a happy accident");
    expect(screen.queryByText("Add a note, or remove this row.")).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Import 1$/ }));
    await waitFor(() => expect(mockedImport).toHaveBeenCalledTimes(1));
    expect(itemsOf(mockedImport.mock.calls[0]![0])).toEqual([
      { note: "a happy accident", question: "serendipity" }
    ]);
  });

  it("removes a row, and reports nothing to import once every row is gone", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(<NotesImport onCancel={vi.fn()} onImported={onImported} />);

    await paste(user, "per -> each\nquorum -> a majority");
    expect(screen.getAllByLabelText("Question")).toHaveLength(2);

    // Remove the first row.
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(screen.getAllByLabelText("Question")).toHaveLength(1);
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe("quorum");

    // Remove the last row too: importing an empty batch is blocked with the same message.
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: /^Import 0$/ }));
    expect(mockedImport).not.toHaveBeenCalled();
    expect(
      screen.getByText("Give every row a question and a note, or remove it, before importing.")
    ).toBeDefined();
    expect(onImported).not.toHaveBeenCalled();
  });

  it("undoes a proposed Question/Note split, restoring the whole heading", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);

    await paste(user, "push back -> pushback");
    // The heading split into a Question and a Note; undoing folds it back.
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe("push back");
    await user.click(screen.getByRole("button", { name: "Undo split" }));
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe(
      "push back -> pushback"
    );
    expect(screen.queryByRole("button", { name: "Undo split" })).toBeNull();
  });

  it("splits trailing context off into its own row, then merges adjacent rows losslessly", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);

    // Row 0 carries an answer plus an indented context line (a splittable Note).
    await paste(user, "push back -> pushback\n    resisted the plan\nserendipity");
    expect(screen.getAllByLabelText("Question")).toHaveLength(2);

    // Split the trailing context off into its own following row.
    await user.click(screen.getByRole("button", { name: "Split off" }));
    expect(screen.getAllByLabelText("Question")).toHaveLength(3);

    // Merge the first row back with the next, folding its text into the note (nothing dropped).
    await user.click(screen.getAllByRole("button", { name: "Merge with next" })[0]!);
    expect(screen.getAllByLabelText("Question")).toHaveLength(2);
  });

  it("returns to the paste step to revise the original text", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);

    await paste(user, "per -> each");
    await user.click(screen.getByRole("button", { name: "Back to paste" }));
    expect((screen.getByLabelText("Paste your list") as HTMLTextAreaElement).value).toBe(
      "per -> each"
    );
  });

  it("surfaces an error when the dictionary suggestion request fails", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);
    await paste(user, "serendipity");

    mockedSuggest.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "Suggest note" }));
    await waitFor(() => expect(screen.getByText(/Nothing was saved/)).toBeDefined());
  });

  it("does not call the dictionary when the row has no question to look up", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);
    await paste(user, "serendipity");

    // Clearing the Question leaves nothing to look up, so Suggest is a no-op.
    await user.clear(screen.getByLabelText("Question"));
    await user.click(screen.getByRole("button", { name: "Suggest note" }));
    expect(mockedSuggest).not.toHaveBeenCalled();
  });

  it("keeps every draft and surfaces an error when the import request fails", async () => {
    const user = userEvent.setup();
    mockedImport.mockRejectedValue(new Error("network"));
    const onImported = vi.fn();
    render(<NotesImport onCancel={vi.fn()} onImported={onImported} />);

    await paste(user, "per -> each");
    await user.click(screen.getByRole("button", { name: /^Import 1$/ }));

    await waitFor(() =>
      expect(screen.getByText(/Nothing was saved/)).toBeDefined()
    );
    expect(onImported).not.toHaveBeenCalled();
    // The refined row is still present to retry.
    expect((screen.getByLabelText("Question") as HTMLTextAreaElement).value).toBe("per");
  });

  it("cancels immediately when there is nothing to discard", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm");
    render(<NotesImport onCancel={onCancel} onImported={vi.fn()} />);

    // No pasted text and no drafts: cancel needs no confirmation.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it("confirms before discarding pasted edits on cancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<NotesImport onCancel={onCancel} onImported={vi.fn()} />);

    await user.click(screen.getByLabelText("Paste your list"));
    await user.paste("per -> each");

    // Declined confirm keeps the panel open.
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    // Accepted confirm discards.
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it("still confirms cancel when only previewed rows remain after clearing the pasted text", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<NotesImport onCancel={onCancel} onImported={vi.fn()} />);

    await paste(user, "per -> each");
    // Back to paste and clear the text: drafts still exist, so cancel must confirm.
    await user.click(screen.getByRole("button", { name: "Back to paste" }));
    await user.clear(screen.getByLabelText("Paste your list"));

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);

    confirmSpy.mockRestore();
  });

  it("fills a blank note from the offline dictionary, and reports when there is no suggestion", async () => {
    const user = userEvent.setup();
    render(<NotesImport onCancel={vi.fn()} onImported={vi.fn()} />);
    await paste(user, "serendipity");

    mockedSuggest.mockResolvedValueOnce({ suggestion: "a happy accident", term: "serendipity" });
    await user.click(screen.getByRole("button", { name: "Suggest note" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Note") as HTMLTextAreaElement).value).toBe("a happy accident")
    );
    expect(mockedSuggest).toHaveBeenCalledWith("serendipity");

    // A blank note again to request a second, empty suggestion.
    await user.clear(screen.getByLabelText("Note"));
    mockedSuggest.mockResolvedValueOnce({ suggestion: null, term: "serendipity" });
    await user.click(screen.getByRole("button", { name: "Suggest note" }));
    await waitFor(() => expect(screen.getByText(/No dictionary suggestion/)).toBeDefined());
  });
});
