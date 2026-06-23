// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./notesApi", () => ({
  createNote: vi.fn(),
  fetchNoteTemplates: vi.fn()
}));

import { createNote } from "./notesApi";
import { NoteEditor } from "./NoteEditor";
import type { NoteDraft } from "./noteCapture";
import type { NoteDto, NoteTemplateDto } from "@whetstone/contracts";

const mockedCreateNote = vi.mocked(createNote);

const templates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [
      { id: "meaning", label: "Meaning in this context", type: "long_text" },
      { id: "memory_hook", label: "Memory hook", type: "short_text" }
    ],
    id: "vocabulary",
    name: "Vocabulary"
  },
  {
    fields: [{ id: "noticed", label: "What I noticed", type: "long_text" }],
    id: "thought",
    name: "Thought / question"
  }
];

const subBlockDraft: NoteDraft = {
  blockEntryId: "block-1",
  contextSnapshot: "The quick brown fox.",
  endOffset: 19,
  preselectedTemplateId: "vocabulary",
  selectedText: "fox",
  startOffset: 16
};

const wholeBlockDraft: NoteDraft = {
  blockEntryId: "block-1",
  contextSnapshot: "The quick brown fox.",
  preselectedTemplateId: "thought",
  selectedText: "The quick brown fox."
};

const savedNote = { entryId: "note-1" } as unknown as NoteDto;

function renderEditor(
  overrides: {
    draft?: NoteDraft;
    onClose?: () => void;
    onSaved?: (note: NoteDto) => void;
    templates?: ReadonlyArray<NoteTemplateDto>;
  } = {}
): {
  onClose: () => void;
  onSaved: (note: NoteDto) => void;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onClose = overrides.onClose ?? vi.fn();
  const onSaved = overrides.onSaved ?? vi.fn();
  const user = userEvent.setup();
  render(
    <NoteEditor
      draft={overrides.draft ?? subBlockDraft}
      onClose={onClose}
      onSaved={onSaved}
      templates={overrides.templates ?? templates}
      workEntryId="work-1"
    />
  );

  return { onClose, onSaved, user };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("NoteEditor", () => {
  it("preselects the size-based template and renders its fields by type", () => {
    renderEditor();

    expect((screen.getByLabelText("Template") as HTMLSelectElement).value).toBe("vocabulary");
    expect(screen.getByLabelText("Meaning in this context").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Memory hook").tagName).toBe("INPUT");
    expect(screen.getByText(/Selected: fox/)).toBeDefined();
  });

  it("saves a sub-block note with structured answers and an offset anchor", async () => {
    mockedCreateNote.mockResolvedValue(savedNote);
    const { onSaved, user } = renderEditor();

    await user.type(screen.getByLabelText("Meaning in this context"), "to outwit");
    await user.type(screen.getByLabelText("Memory hook"), "fox = sly");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(mockedCreateNote).toHaveBeenCalledWith("work-1", {
        answers: { meaning: "to outwit", memory_hook: "fox = sly" },
        anchor: {
          blockEntryId: "block-1",
          contextSnapshot: "The quick brown fox.",
          endOffset: 19,
          selectedTextSnapshot: "fox",
          startOffset: 16
        },
        templateId: "vocabulary"
      })
    );
    expect(onSaved).toHaveBeenCalledWith(savedNote);
  });

  it("saves a whole-block note without an offset range", async () => {
    mockedCreateNote.mockResolvedValue(savedNote);
    const { user } = renderEditor({ draft: wholeBlockDraft });

    await user.type(screen.getByLabelText("What I noticed"), "tidy");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(mockedCreateNote).toHaveBeenCalledWith("work-1", {
        answers: { noticed: "tidy" },
        anchor: {
          blockEntryId: "block-1",
          contextSnapshot: "The quick brown fox.",
          selectedTextSnapshot: "The quick brown fox."
        },
        templateId: "thought"
      })
    );
  });

  it("lets the reader switch templates before saving", async () => {
    mockedCreateNote.mockResolvedValue(savedNote);
    const { user } = renderEditor();

    await user.selectOptions(screen.getByLabelText("Template"), "thought");
    await user.type(screen.getByLabelText("What I noticed"), "clever");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    await waitFor(() =>
      expect(mockedCreateNote).toHaveBeenCalledWith("work-1", {
        answers: { noticed: "clever" },
        anchor: expect.objectContaining({ blockEntryId: "block-1" }),
        templateId: "thought"
      })
    );
  });

  it("requires at least one answer before saving", async () => {
    const { user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(screen.getByText("Add at least one answer before saving.")).toBeDefined();
    expect(mockedCreateNote).not.toHaveBeenCalled();
  });

  it("shows an error when saving fails", async () => {
    mockedCreateNote.mockRejectedValue(new Error("boom"));
    const { user } = renderEditor();

    await user.type(screen.getByLabelText("Meaning in this context"), "to outwit");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Could not save the note. Please try again.")).toBeDefined();
  });

  it("closes when cancelled", async () => {
    const { onClose, user } = renderEditor();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalled();
  });

  it("falls back to the first template when the preselection is unknown", () => {
    renderEditor({ draft: { ...subBlockDraft, preselectedTemplateId: "missing" } });

    expect((screen.getByLabelText("Template") as HTMLSelectElement).value).toBe("vocabulary");
  });

  it("reports and closes when no templates are available", async () => {
    const { onClose, user } = renderEditor({ templates: [] });

    expect(screen.getByText("Note templates are unavailable. Please try again.")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});
