// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./contentApi", () => ({
  fetchWorkContent: vi.fn(),
  fetchWorks: vi.fn(),
  ingestMarkdown: vi.fn()
}));

import { fetchWorkContent, fetchWorks, ingestMarkdown } from "./contentApi";
import { WorkContentPanel } from "./WorkContentPanel";
import type { WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);
const mockedIngestMarkdown = vi.mocked(ingestMarkdown);

const author = { id: toAuthorId("author-1"), name: "George Orwell" };

const workA: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    title: "Work A",
    workType: "essay"
  }
};

const workB: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-2"),
    language: "en",
    title: "Work B",
    workType: "book"
  }
};

function emptyContent(workEntryId: string): WorkContentDto {
  return { readingUnits: [], workEntryId: toEntryId(workEntryId) };
}

const contentA: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-1"),
          mdast: { type: "paragraph" },
          orderIndex: 0,
          plaintext: "Intro paragraph."
        }
      ],
      entryId: toEntryId("u-1"),
      orderIndex: 0
    },
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("b-2"),
          mdast: { type: "heading" },
          orderIndex: 0,
          plaintext: "Chapter One"
        }
      ],
      entryId: toEntryId("u-2"),
      orderIndex: 1,
      title: "Chapter One"
    }
  ],
  workEntryId: toEntryId("work-1")
};

const contentB: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("b-9"),
          mdast: { type: "paragraph" },
          orderIndex: 0,
          plaintext: "Work B body."
        }
      ],
      entryId: toEntryId("u-9"),
      orderIndex: 0
    }
  ],
  workEntryId: toEntryId("work-2")
};

beforeAll(() => {
  // jsdom does not implement Blob.text(); the component uses the standard
  // File.text() web API (native in browsers), so provide it via FileReader here.
  if (typeof Blob.prototype.text !== "function") {
    Blob.prototype.text = function blobText(this: Blob): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener("load", () => {
          resolve(String(reader.result));
        });
        reader.addEventListener("error", () => {
          reject(reader.error ?? new Error("Could not read blob."));
        });
        reader.readAsText(this);
      });
    };
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchWorks.mockResolvedValue({ works: [workA] });
  mockedFetchWorkContent.mockResolvedValue(emptyContent("work-1"));
});

afterEach(() => {
  cleanup();
});

async function renderReady(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  render(<WorkContentPanel />);
  await screen.findByLabelText("Work");

  return user;
}

describe("WorkContentPanel", () => {
  it("shows an error when works fail to load", async () => {
    mockedFetchWorks.mockRejectedValue(new Error("network"));

    render(<WorkContentPanel />);

    expect(await screen.findByText("Could not load works.")).toBeDefined();
  });

  it("prompts to create a work when none exist", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [] });

    render(<WorkContentPanel />);

    expect(await screen.findByText("Create a work first to add content.")).toBeDefined();
  });

  it("lists a work's reading units and blocks in order", async () => {
    mockedFetchWorkContent.mockResolvedValue(contentA);

    await renderReady();

    expect(screen.getByRole("heading", { level: 3, name: "Untitled section" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 3, name: "Chapter One" })).toBeDefined();
    expect(screen.getByText("Intro paragraph.")).toBeDefined();
    expect(screen.getByText("paragraph")).toBeDefined();
    expect(screen.getByText("heading")).toBeDefined();
  });

  it("shows a no-content message for an empty work", async () => {
    await renderReady();

    expect(screen.getByText("No content yet.")).toBeDefined();
  });

  it("adds manual Markdown content and shows the new blocks", async () => {
    const user = await renderReady();
    mockedIngestMarkdown.mockResolvedValue(contentA);

    await user.type(screen.getByLabelText("Markdown"), "# Hi");
    await user.click(screen.getByRole("button", { name: "Add Markdown content" }));

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(mockedIngestMarkdown).toHaveBeenCalledWith("work-1", {
      kind: "manual",
      markdown: "# Hi"
    });
  });

  it("validates that Markdown is provided", async () => {
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Add Markdown content" }));

    expect(screen.getByText("Enter some Markdown to add.")).toBeDefined();
    expect(mockedIngestMarkdown).not.toHaveBeenCalled();
  });

  it("shows an error when adding Markdown fails", async () => {
    const user = await renderReady();
    mockedIngestMarkdown.mockRejectedValue(new Error("boom"));

    await user.type(screen.getByLabelText("Markdown"), "# Hi");
    await user.click(screen.getByRole("button", { name: "Add Markdown content" }));

    expect(
      await screen.findByText("Could not add the Markdown content. Please try again.")
    ).toBeDefined();
  });

  it("uploads a .md file and shows the new blocks", async () => {
    const user = await renderReady();
    mockedIngestMarkdown.mockResolvedValue(contentA);
    const file = new File(["# Hi from file"], "notes.md", { type: "text/markdown" });

    await user.upload(screen.getByLabelText("Upload a .md file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Intro paragraph.")).toBeDefined();
    expect(mockedIngestMarkdown).toHaveBeenCalledWith("work-1", {
      fileName: "notes.md",
      kind: "upload",
      markdown: "# Hi from file"
    });
  });

  it("validates that a file is chosen before upload", async () => {
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(screen.getByText("Choose a .md file to upload.")).toBeDefined();
    expect(mockedIngestMarkdown).not.toHaveBeenCalled();
  });

  it("shows an error when uploading fails", async () => {
    const user = await renderReady();
    mockedIngestMarkdown.mockRejectedValue(new Error("boom"));
    const file = new File(["# Hi"], "notes.md", { type: "text/markdown" });

    await user.upload(screen.getByLabelText("Upload a .md file"), file);
    await user.click(screen.getByRole("button", { name: "Upload file" }));

    expect(await screen.findByText("Could not upload the file. Please try again.")).toBeDefined();
  });

  it("switches the selected work and loads its content", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockImplementation(async (workEntryId: string) =>
      workEntryId === "work-2" ? contentB : emptyContent("work-1")
    );
    const user = await renderReady();

    await user.selectOptions(screen.getByLabelText("Work"), "work-2");

    expect(await screen.findByText("Work B body.")).toBeDefined();
    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-2");
  });

  it("shows an error when loading a switched work fails", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockImplementation(async (workEntryId: string) => {
      if (workEntryId === "work-2") {
        throw new Error("boom");
      }

      return emptyContent("work-1");
    });
    const user = await renderReady();

    await user.selectOptions(screen.getByLabelText("Work"), "work-2");

    expect(
      await screen.findByText("Could not load this work's content. Please try again.")
    ).toBeDefined();
  });
});
