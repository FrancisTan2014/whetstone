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
      plaintext: "The dog barked loudly.",
      workEntryId: "work-1",
      workTitle: "Animal Farm"
    },
    {
      authorName: "Aesop",
      blockEntryId: "block-2",
      plaintext: "The Dog and the Bone.",
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
    expect(screen.getByText("The dog barked loudly.")).toBeDefined();
    expect(screen.getByText("George Orwell · Animal Farm")).toBeDefined();
    expect(mockedSearchLibrary).toHaveBeenCalledWith("dog");

    const links = screen.getAllByRole("link");
    expect(links[0]?.getAttribute("href")).toBe("#/reader?work=work-1&block=block-1");
    expect(links[1]?.getAttribute("href")).toBe("#/reader?work=work-2&block=block-2");
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
