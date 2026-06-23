// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./readerApi", () => ({
  fetchWorkContent: vi.fn(),
  fetchWorks: vi.fn()
}));

vi.mock("../notes/notesApi", () => ({
  createNote: vi.fn(),
  fetchNoteTemplates: vi.fn()
}));

import { createNote, fetchNoteTemplates } from "../notes/notesApi";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { ReaderPage } from "./ReaderPage";
import type {
  NoteDto,
  NoteTemplateDto,
  WorkContentDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);
const mockedFetchNoteTemplates = vi.mocked(fetchNoteTemplates);
const mockedCreateNote = vi.mocked(createNote);

const noteTemplates: ReadonlyArray<NoteTemplateDto> = [
  {
    fields: [{ id: "meaning", label: "Meaning in this context", type: "long_text" }],
    id: "vocabulary",
    name: "Vocabulary"
  }
];

const author = { id: toAuthorId("author-1"), name: "George Orwell" };

const workA: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Politics and the English Language",
    workType: "essay"
  }
};

const workB: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-2"),
    language: "en",
    title: "A Tale of Two Cities",
    workType: "book"
  }
};

function emptyContent(workEntryId: string): WorkContentDto {
  return { readingUnits: [], workEntryId: toEntryId(workEntryId) };
}

// Units and blocks are stored out of reading order to confirm the page renders them
// sorted, grouped by unit, as one continuous scroll.
const multiUnitContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-2"),
          mdast: { children: [{ type: "text", value: "Heading text" }], depth: 2, type: "heading" },
          orderIndex: 0,
          plaintext: "Heading text"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-3"),
          mdast: {
            children: [
              { children: [{ type: "text", value: "emphasized word" }], type: "emphasis" }
            ],
            type: "paragraph"
          },
          orderIndex: 1,
          plaintext: "emphasized word"
        }
      ],
      entryId: toEntryId("u-2"),
      orderIndex: 1,
      title: "Section Two"
    },
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-1"),
          mdast: { children: [{ type: "text", value: "Intro paragraph." }], type: "paragraph" },
          orderIndex: 0,
          plaintext: "Intro paragraph."
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

const unsafeContent: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-safe"),
          mdast: { children: [{ type: "text", value: "Safe heading" }], depth: 1, type: "heading" },
          orderIndex: 0,
          plaintext: "Safe heading"
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-evil"),
          mdast: { type: "html", value: "<script>window.__xssReader = true;</script>" },
          orderIndex: 1,
          plaintext: ""
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-1")
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchWorks.mockResolvedValue({ works: [workA] });
  mockedFetchWorkContent.mockResolvedValue(emptyContent("work-1"));
  mockedFetchNoteTemplates.mockResolvedValue({ templates: noteTemplates });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe("ReaderPage", () => {
  it("shows a loading state before works resolve", async () => {
    render(<ReaderPage />);

    expect(screen.getByText("Loading works…")).toBeDefined();
    await screen.findByRole("button", { name: "Politics and the English Language" });
  });

  it("shows an error when works fail to load", async () => {
    mockedFetchWorks.mockRejectedValue(new Error("network"));

    render(<ReaderPage />);

    expect(await screen.findByText("Could not load works.")).toBeDefined();
  });

  it("prompts to create a work when none exist", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [] });

    render(<ReaderPage />);

    expect(await screen.findByText("No works yet. Create one in the library admin.")).toBeDefined();
  });

  it("lists works and prompts the reader to open one", async () => {
    render(<ReaderPage />);

    const openButton = await screen.findByRole("button", {
      name: "Politics and the English Language"
    });

    expect(screen.getByText("Select a work to start reading.")).toBeDefined();
    expect(openButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens a work and renders its units and blocks as one continuous scroll", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Section Two" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Heading text" })).toBeDefined();
    expect(container.querySelector("em")?.textContent).toBe("emphasized word");

    const blockIds = Array.from(container.querySelectorAll("[data-block-id]")).map((element) =>
      element.getAttribute("data-block-id")
    );
    expect(blockIds).toEqual(["b-1", "b-2", "b-3"]);

    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-1");
    expect(
      screen
        .getByRole("button", { name: "Politics and the English Language" })
        .getAttribute("aria-pressed")
    ).toBe("true");
  });

  it("shows the untitled unit without a heading", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    expect(screen.queryByRole("heading", { name: "Untitled section" })).toBeNull();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("shows a loading state while a work's content loads", async () => {
    let resolveContent!: (value: WorkContentDto) => void;
    mockedFetchWorkContent.mockReturnValue(
      new Promise<WorkContentDto>((resolve) => {
        resolveContent = resolve;
      })
    );
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(screen.getByText("Loading the work…")).toBeDefined();

    resolveContent(emptyContent("work-1"));

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("shows an error when a work's content fails to load", async () => {
    mockedFetchWorkContent.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("Could not load this work. Please try again.")).toBeDefined();
  });

  it("shows a message when an opened work has no content", async () => {
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByText("This work has no content yet.")).toBeDefined();
  });

  it("marks only the open work as pressed among several", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    const user = userEvent.setup();
    render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");

    expect(
      screen
        .getByRole("button", { name: "Politics and the English Language" })
        .getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "A Tale of Two Cities" }).getAttribute("aria-pressed")
    ).toBe("false");
  });

  it("renders Markdown safely and does not execute raw HTML", async () => {
    mockedFetchWorkContent.mockResolvedValue(unsafeContent);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Safe heading" })).toBeDefined();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).not.toContain("__xssReader");
  });

  it("opens the note editor when text is selected in a block", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Intro"
    } as unknown as Selection);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    fireEvent.mouseUp(container.querySelector('[data-block-id="b-1"]') as HTMLElement);

    expect(await screen.findByRole("heading", { name: "New note" })).toBeDefined();
    expect(screen.getByText(/Selected: Intro/)).toBeDefined();
  });

  it("does not open the editor when there is no selection", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    fireEvent.mouseUp(container.querySelector('[data-block-id="b-1"]') as HTMLElement);

    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("confirms and closes the editor after a note is saved", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedCreateNote.mockResolvedValue({ entryId: "note-1" } as unknown as NoteDto);
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Intro"
    } as unknown as Selection);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    fireEvent.mouseUp(container.querySelector('[data-block-id="b-1"]') as HTMLElement);

    await user.type(await screen.findByLabelText("Meaning in this context"), "the start");
    await user.click(screen.getByRole("button", { name: "Save note" }));

    expect(await screen.findByText("Note saved.")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("closes the editor when cancelled", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Intro"
    } as unknown as Selection);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    fireEvent.mouseUp(container.querySelector('[data-block-id="b-1"]') as HTMLElement);
    await screen.findByRole("heading", { name: "New note" });

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("heading", { name: "New note" })).toBeNull();
  });

  it("shows the unavailable editor when note templates fail to load", async () => {
    mockedFetchWorkContent.mockResolvedValue(multiUnitContent);
    mockedFetchNoteTemplates.mockRejectedValue(new Error("nope"));
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "Intro"
    } as unknown as Selection);
    const user = userEvent.setup();
    const { container } = render(<ReaderPage />);

    await user.click(
      await screen.findByRole("button", { name: "Politics and the English Language" })
    );
    await screen.findByText("Intro paragraph.");
    fireEvent.mouseUp(container.querySelector('[data-block-id="b-1"]') as HTMLElement);

    expect(
      await screen.findByText("Note templates are unavailable. Please try again.")
    ).toBeDefined();
  });
});
