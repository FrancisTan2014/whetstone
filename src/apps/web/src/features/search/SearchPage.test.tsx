// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./searchApi", () => ({
  searchLibrary: vi.fn()
}));

import { searchLibrary } from "./searchApi";
import { SearchPage } from "./SearchPage";
import type { SearchResultsDto } from "@whetstone/contracts";

const mockedSearchLibrary = vi.mocked(searchLibrary);

const twoHits: SearchResultsDto = {
  query: "dog",
  results: [
    {
      authorName: "George Orwell",
      blockEntryId: "block-1",
      snippet: {
        text: "The dog barked loudly.",
        matchStart: 4,
        matchEnd: 7,
        hasLeadingEllipsis: false,
        hasTrailingEllipsis: false
      },
      workEntryId: "work-1",
      workTitle: "Animal Farm"
    },
    {
      authorName: "Aesop",
      blockEntryId: "block-2",
      snippet: {
        text: "The Dog and the Bone.",
        matchStart: 4,
        matchEnd: 7,
        hasLeadingEllipsis: false,
        hasTrailingEllipsis: false
      },
      workEntryId: "work-2",
      workTitle: "Fables"
    }
  ]
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe("SearchPage", () => {
  it("renders the heading and query field with no results before searching", () => {
    render(<SearchPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Search" })).toBeDefined();
    expect(screen.getByRole("searchbox", { name: "Search query" })).toBeDefined();
    expect(screen.queryByRole("list", { name: "Search results" })).toBeNull();
  });

  it("does not search when the query is blank", async () => {
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "   ");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(mockedSearchLibrary).not.toHaveBeenCalled();
  });

  it("runs a search and links each hit back to its work and block in the reader", async () => {
    mockedSearchLibrary.mockResolvedValue(twoHits);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const list = await screen.findByRole("list", { name: "Search results" });
    expect(list).toBeDefined();
    // The snippet renders as before/match/after slices; the matched term is highlighted in a <mark>.
    const marks = list.querySelectorAll("mark");
    expect(Array.from(marks).map((mark) => mark.textContent)).toEqual(["dog", "Dog"]);
    expect(screen.getByText("George Orwell · Animal Farm")).toBeDefined();
    expect(mockedSearchLibrary).toHaveBeenCalledWith("dog");

    const links = screen.getAllByRole("link");
    expect(links[0]?.getAttribute("href")).toBe("#/reader?work=work-1&block=block-1");
    expect(links[1]?.getAttribute("href")).toBe("#/reader?work=work-2&block=block-2");
    // The full snippet text is present around the highlight.
    expect(links[0]?.textContent).toContain("The dog barked loudly.");
  });

  it("shows ellipses only on clipped ends and highlights the matched term", async () => {
    mockedSearchLibrary.mockResolvedValue({
      query: "dog",
      results: [
        {
          authorName: "George Orwell",
          blockEntryId: "block-1",
          snippet: {
            text: "context dog trailing",
            matchStart: 8,
            matchEnd: 11,
            hasLeadingEllipsis: true,
            hasTrailingEllipsis: true
          },
          workEntryId: "work-1",
          workTitle: "Animal Farm"
        }
      ]
    });
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const link = await screen.findByRole("link");
    expect(link.querySelector("mark")?.textContent).toBe("dog");
    // Leading and trailing ellipses wrap the clipped snippet, once each.
    const snippetParagraph = link.querySelectorAll("p");
    expect(snippetParagraph[snippetParagraph.length - 1]?.textContent).toBe(
      "…context dog trailing…"
    );
  });

  it("omits ellipses when neither end is clipped", async () => {
    mockedSearchLibrary.mockResolvedValue(twoHits);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    const links = await screen.findAllByRole("link");
    expect(links[0]?.textContent).not.toContain("…");
  });

  it("keeps each result a keyboard-focusable link", async () => {
    mockedSearchLibrary.mockResolvedValue(twoHits);
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    await screen.findByRole("list", { name: "Search results" });
    const links = screen.getAllByRole("link");
    links[0]?.focus();
    expect(document.activeElement).toBe(links[0]);
  });

  it("shows an explicit no-matches state echoing the query", async () => {
    mockedSearchLibrary.mockResolvedValue({ query: "unicorn", results: [] });
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "unicorn");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("No matches for “unicorn”.")).toBeDefined();
  });

  it("shows a loading state while the search is in flight", async () => {
    let resolveSearch: (value: SearchResultsDto) => void = () => {};
    mockedSearchLibrary.mockImplementation(
      () =>
        new Promise<SearchResultsDto>((resolve) => {
          resolveSearch = resolve;
        })
    );
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Searching…")).toBeDefined();

    resolveSearch(twoHits);
    expect(await screen.findByRole("list", { name: "Search results" })).toBeDefined();
  });

  it("shows an error state when the search fails", async () => {
    mockedSearchLibrary.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    render(<SearchPage />);

    await user.type(screen.getByRole("searchbox", { name: "Search query" }), "dog");
    await user.click(screen.getByRole("button", { name: "Search" }));

    expect(await screen.findByText("Could not run the search. Please try again.")).toBeDefined();
  });
});
