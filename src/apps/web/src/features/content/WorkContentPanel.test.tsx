// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./contentApi", () => ({
  fetchWorkContent: vi.fn(),
  fetchWorks: vi.fn()
}));

import { fetchWorkContent, fetchWorks } from "./contentApi";
import { WorkContentPanel } from "./WorkContentPanel";
import type { WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { toAuthorId, toEntryId } from "@whetstone/domain";

const mockedFetchWorks = vi.mocked(fetchWorks);
const mockedFetchWorkContent = vi.mocked(fetchWorkContent);

const author = { id: toAuthorId("author-1"), name: "George Orwell" };

const workA: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-1"),
    language: "en",
    origin: "imported",
    title: "Work A",
    workType: "essay"
  }
};

const workB: WorkListItemDto = {
  author,
  work: {
    authorId: author.id,
    entryId: toEntryId("work-2"),
    language: "zh-CN",
    origin: "imported",
    title: "Work B",
    workType: "classical_text"
  }
};

function emptyContent(workEntryId: string): WorkContentDto {
  return { readingUnits: [], workEntryId: toEntryId(workEntryId) };
}

// work-1 content: an untitled single-block unit and a titled two-block unit, so the
// overview exercises both the title fallback and the singular/plural block labels.
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
        },
        {
          blockType: "paragraph",
          entryId: toEntryId("b-3"),
          mdast: { type: "paragraph" },
          orderIndex: 1,
          plaintext: "More text."
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

// A Markdown-pipeline work whose units carry heading levels: a leading preface unit (no heading), an
// H1 chapter, and an H2 section — so the derived table-of-contents preview exercises "Start", a
// chapter, and a nested section.
const contentWithHeadings: WorkContentDto = {
  readingUnits: [
    {
      blocks: [
        {
          blockType: "paragraph",
          entryId: toEntryId("h-b0"),
          mdast: { type: "paragraph" },
          orderIndex: 0,
          plaintext: "Preface text."
        }
      ],
      entryId: toEntryId("h-u0"),
      orderIndex: 0
    },
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("h-b1"),
          mdast: { depth: 1, type: "heading" },
          orderIndex: 0,
          plaintext: "Chapter One"
        }
      ],
      entryId: toEntryId("h-u1"),
      headingLevel: 1,
      orderIndex: 1,
      title: "Chapter One"
    },
    {
      blocks: [
        {
          blockType: "heading",
          entryId: toEntryId("h-b2"),
          mdast: { depth: 2, type: "heading" },
          orderIndex: 0,
          plaintext: "Section 1.1"
        }
      ],
      entryId: toEntryId("h-u2"),
      headingLevel: 2,
      orderIndex: 2,
      title: "Section 1.1"
    }
  ],
  workEntryId: toEntryId("work-1")
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchWorks.mockResolvedValue({ works: [workA] });
  mockedFetchWorkContent.mockResolvedValue(emptyContent("work-1"));
});

afterEach(() => {
  cleanup();
});

async function renderReady(
  options?: Parameters<typeof userEvent.setup>[0]
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup(options);
  render(<WorkContentPanel />);
  await screen.findByRole("heading", { level: 3, name: "Work A" });

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

  it("shows a header with the work's metadata, counts, and a reader entry point", async () => {
    mockedFetchWorkContent.mockResolvedValue(contentA);

    await renderReady();

    expect(screen.getByRole("heading", { level: 3, name: "Work A" })).toBeDefined();
    expect(screen.getByText("George Orwell · essay · English")).toBeDefined();
    expect(screen.getByText("2 reading units · 3 blocks")).toBeDefined();

    const readerLink = screen.getByRole("link", { name: "Open in Reader" });
    expect(readerLink.getAttribute("href")).toBe("#/reader?work=work-1");
    // A >=44px hit target (#491); it was a 20px-tall text link before. jsdom has no layout, so assert
    // the sizing utility (min-h-11 = 44px); self-start keeps it from stretching to the panel width.
    expect(readerLink.className).toContain("min-h-11");
  });

  it("summarizes reading units and block counts by default and reveals blocks on demand", async () => {
    mockedFetchWorkContent.mockResolvedValue(contentA);

    const user = await renderReady();

    // Default view: reading-unit summary with block counts, no per-block plaintext/type rows.
    expect(screen.getByText("Untitled section")).toBeDefined();
    expect(screen.getByText("1 block")).toBeDefined();
    expect(screen.getByText("2 blocks")).toBeDefined();
    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(screen.queryByText("More text.")).toBeNull();

    const toggle = screen.getByRole("button", { name: "View blocks" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);

    expect(screen.getByText("Intro paragraph.")).toBeDefined();
    expect(screen.getByText("More text.")).toBeDefined();
    expect(screen.getByText("heading")).toBeDefined();
    expect(screen.getAllByText("paragraph")).toHaveLength(2);

    const hide = screen.getByRole("button", { name: "Hide blocks" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    await user.click(hide);

    expect(screen.queryByText("Intro paragraph.")).toBeNull();
    expect(screen.getByRole("button", { name: "View blocks" })).toBeDefined();
  });

  it("shows a no-content message for an empty work", async () => {
    await renderReady();

    expect(screen.getByText("No content yet.")).toBeDefined();
  });

  it("hides the work switcher when there is only one work", async () => {
    await renderReady();

    expect(screen.queryByRole("navigation", { name: "Works" })).toBeNull();
  });

  it("switches the selected work and loads its content", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    mockedFetchWorkContent.mockImplementation(async (workEntryId: string) =>
      workEntryId === "work-2" ? contentB : emptyContent("work-1")
    );
    const user = await renderReady();

    await user.click(screen.getByRole("button", { name: "Work B" }));

    expect(await screen.findByRole("heading", { level: 3, name: "Work B" })).toBeDefined();
    expect(
      screen.getByText("George Orwell · classical text · 中文（简体） Simplified Chinese")
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Work B" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    await user.click(screen.getByRole("button", { name: "View blocks" }));
    expect(screen.getByText("Work B body.")).toBeDefined();
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

    await user.click(screen.getByRole("button", { name: "Work B" }));

    expect(
      await screen.findByText("Could not load this work's content. Please try again.")
    ).toBeDefined();
  });

  it("refreshes its works and selects a newly focused work without a remount", async () => {
    // The panel first loads with only Work A present (mirrors the works that existed when the
    // Library mounted). After a work is created elsewhere, the parent focuses it: the panel must
    // re-fetch the now-larger works list and select the new work so it can receive content.
    mockedFetchWorks.mockResolvedValue({ works: [workA] });
    mockedFetchWorkContent.mockImplementation(async (workEntryId: string) =>
      workEntryId === "work-2" ? contentB : emptyContent("work-1")
    );
    const { rerender } = render(<WorkContentPanel />);
    await screen.findByRole("heading", { level: 3, name: "Work A" });

    mockedFetchWorks.mockResolvedValue({ works: [workA, workB] });
    rerender(<WorkContentPanel focusWorkEntryId="work-2" />);

    expect(await screen.findByRole("heading", { level: 3, name: "Work B" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Work B" }).getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-2");
  });

  it("falls back to the first work when the focused work is not in the list", async () => {
    mockedFetchWorks.mockResolvedValue({ works: [workA] });

    render(<WorkContentPanel focusWorkEntryId="work-missing" />);

    expect(await screen.findByRole("heading", { level: 3, name: "Work A" })).toBeDefined();
    expect(mockedFetchWorkContent).toHaveBeenCalledWith("work-1");
  });

  it("previews the heading-derived table of contents in reading order", async () => {
    mockedFetchWorkContent.mockResolvedValue(contentWithHeadings);

    await renderReady();

    const toc = screen.getByRole("list", { name: "Table of contents" });
    const labels = within(toc)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(labels).toEqual(["Start", "Chapter One", "Section 1.1"]);
  });

  it("omits the table of contents for a headingless multi-unit work", async () => {
    mockedFetchWorkContent.mockResolvedValue(contentA);

    await renderReady();

    expect(screen.queryByRole("list", { name: "Table of contents" })).toBeNull();
  });
});
