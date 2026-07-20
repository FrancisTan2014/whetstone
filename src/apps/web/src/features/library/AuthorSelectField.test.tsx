// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./libraryApi", () => ({
  searchAuthors: vi.fn()
}));

import type { AuthorDto, AuthorSearchDto, WorkAuthorSelection } from "@whetstone/contracts";
import { toAuthorId } from "@whetstone/domain";

import { searchAuthors } from "./libraryApi";
import { AuthorSelectField } from "./AuthorSelectField";

const mockedSearchAuthors = vi.mocked(searchAuthors);

const kleppmann: AuthorDto = { id: toAuthorId("author-kleppmann"), name: "Martin Kleppmann" };
const fowler: AuthorDto = { id: toAuthorId("author-fowler"), name: "Martin Fowler" };

// A faithful stand-in for the server's canonical search: a blank query lists everyone; a nonblank
// query returns case-insensitive substring matches over the canonical key, the cleaned (case-preserving)
// query, and the exact-match id when a name matches the whole key.
function searchLike(query?: string): AuthorSearchDto {
  const cleaned = (query ?? "").trim().replace(/\s+/g, " ");

  if (cleaned === "") {
    return { authors: [kleppmann, fowler], cleanedQuery: "", exactMatchId: null };
  }

  const key = cleaned.toLowerCase();
  const authors = [kleppmann, fowler].filter((author) => author.name.toLowerCase().includes(key));
  const exact = [kleppmann, fowler].find((author) => author.name.toLowerCase() === key) ?? null;

  return { authors, cleanedQuery: cleaned, exactMatchId: exact === null ? null : exact.id };
}

beforeAll(() => {
  // downshift scrolls the highlighted option into view; jsdom has no layout, so stub it.
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {}
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedSearchAuthors.mockImplementation(async (query?: string) => searchLike(query));
});

afterEach(() => {
  cleanup();
});

function renderField(): {
  onSelectionChange: ReturnType<typeof vi.fn>;
  user: ReturnType<typeof userEvent.setup>;
} {
  const onSelectionChange = vi.fn<(selection: WorkAuthorSelection | undefined) => void>();
  const user = userEvent.setup();
  render(<AuthorSelectField onSelectionChange={onSelectionChange} />);

  return { onSelectionChange, user };
}

function lastSelection(
  onSelectionChange: ReturnType<typeof vi.fn>
): WorkAuthorSelection | undefined {
  const calls = onSelectionChange.mock.calls;

  return calls.length === 0 ? undefined : (calls[calls.length - 1]?.[0] as WorkAuthorSelection);
}

describe("AuthorSelectField", () => {
  it("announces the initial loading state before the first search resolves", () => {
    const { onSelectionChange } = renderField();

    expect(screen.getByText("Searching authors and sources.")).toBeDefined();
    // With nothing committed, the field reports no selection so the form blocks an implicit create.
    expect(onSelectionChange).toHaveBeenLastCalledWith(undefined);
  });

  it("lists the full canonical set for a blank query and reports the result count", async () => {
    const { user } = renderField();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{ArrowDown}");

    expect(await screen.findByText("Martin Kleppmann")).toBeDefined();
    expect(screen.getByText("Martin Fowler")).toBeDefined();
    expect(screen.getByText("2 results available.")).toBeDefined();
  });

  it("searches by substring, offers an Add for a new name, and reports an existing pick", async () => {
    const { onSelectionChange, user } = renderField();
    const input = screen.getByRole("combobox");
    await user.type(input, "Kleppmann");

    const option = await screen.findByText("Martin Kleppmann");
    // A non-exact, nonblank query still offers to add the typed name alongside the matches.
    expect(screen.getByText("Add “Kleppmann”")).toBeDefined();
    expect(screen.getByText("2 results available.")).toBeDefined();

    await user.click(option);

    expect(lastSelection(onSelectionChange)).toEqual({
      authorId: kleppmann.id,
      mode: "existing"
    });
  });

  it("highlights the option navigated to with the keyboard", async () => {
    const { user } = renderField();
    const input = screen.getByRole("combobox");
    await user.type(input, "Kleppmann");
    await screen.findByText("Martin Kleppmann");

    await user.keyboard("{ArrowDown}");

    const highlighted = screen.getByRole("option", { name: "Martin Kleppmann" });
    await waitFor(() => {
      expect(highlighted.className).toContain("bg-surface-muted");
    });
  });

  it("resolves an exact canonical match as an existing selection without an Add option", async () => {
    const { onSelectionChange, user } = renderField();
    const input = screen.getByRole("combobox");
    await user.type(input, "Martin Fowler");

    await waitFor(() => {
      expect(lastSelection(onSelectionChange)).toEqual({
        authorId: fowler.id,
        mode: "existing"
      });
    });
    await user.keyboard("{ArrowDown}");
    await screen.findByText("Martin Fowler");
    expect(screen.queryByText(/^Add /)).toBeNull();
    expect(screen.getByText("1 result available.")).toBeDefined();
  });

  it("creates a new author from the Add option using the server-cleaned name", async () => {
    const { onSelectionChange, user } = renderField();
    const input = screen.getByRole("combobox");
    await user.type(input, "Grace Hopper");

    const addOption = await screen.findByText("Add “Grace Hopper”");
    await user.click(addOption);

    expect(lastSelection(onSelectionChange)).toEqual({ mode: "new", name: "Grace Hopper" });
  });

  it("shows a first-run hint when the library has no authors yet", async () => {
    mockedSearchAuthors.mockResolvedValue({ authors: [], cleanedQuery: "", exactMatchId: null });
    const { user } = renderField();
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{ArrowDown}");

    expect(
      await screen.findByText("Type a name to add your first author or source.")
    ).toBeDefined();
    expect(screen.getByText("0 results available.")).toBeDefined();
  });

  it("clears an existing selection once the learner edits the committed name", async () => {
    const { onSelectionChange, user } = renderField();
    const input = screen.getByRole("combobox");
    await user.type(input, "Kleppmann");
    await user.click(await screen.findByText("Martin Kleppmann"));
    expect(lastSelection(onSelectionChange)).toEqual({ authorId: kleppmann.id, mode: "existing" });

    // Editing the committed text returns to pure search; with no exact match nothing is committed.
    await user.type(input, " extra");

    await waitFor(() => {
      expect(lastSelection(onSelectionChange)).toBeUndefined();
    });
  });

  it("keeps the typed text and commits nothing when the field loses focus", async () => {
    const { onSelectionChange, user } = renderField();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "Ada Lovelace");
    await screen.findByText("Add “Ada Lovelace”");

    await user.tab();

    expect(input.value).toBe("Ada Lovelace");
    // Blur never creates: no exact match means the effective selection is still undefined.
    expect(lastSelection(onSelectionChange)).toBeUndefined();
    expect(onSelectionChange).not.toHaveBeenCalledWith({ mode: "new", name: "Ada Lovelace" });
  });

  it("closes the list on Escape while preserving the query", async () => {
    const { user } = renderField();
    const input = screen.getByRole("combobox") as HTMLInputElement;
    await user.type(input, "Kleppmann");
    await screen.findByText("Martin Kleppmann");

    await user.keyboard("{Escape}");

    expect(input.value).toBe("Kleppmann");
    await waitFor(() => {
      expect(screen.queryByText("Martin Kleppmann")).toBeNull();
    });
  });

  it("surfaces a retryable error when the search fails, then recovers", async () => {
    mockedSearchAuthors.mockRejectedValueOnce(new Error("network"));
    const { user } = renderField();
    const input = screen.getByRole("combobox");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/Couldn’t search authors and sources\./)).toBeDefined();
    expect(screen.getByText("Author search failed.")).toBeDefined();
    expect(input.getAttribute("aria-describedby")).toBe(alert.getAttribute("id"));

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("ignores a stale in-flight response so a slow earlier search never wins", async () => {
    const deferred: Array<(value: AuthorSearchDto) => void> = [];
    mockedSearchAuthors.mockImplementation(
      () =>
        new Promise<AuthorSearchDto>((resolve) => {
          deferred.push(resolve);
        })
    );
    const { user } = renderField();
    const input = screen.getByRole("combobox");

    // Let the first (blank) search go in-flight, then supersede it with a typed query.
    await waitFor(() => {
      expect(deferred.length).toBe(1);
    });
    await user.type(input, "Fowler");
    await waitFor(() => {
      expect(deferred.length).toBe(2);
    });

    // Resolve the superseded search last: its result must be discarded.
    await act(async () => {
      deferred[1]?.({ authors: [fowler], cleanedQuery: "Fowler", exactMatchId: fowler.id });
    });
    await act(async () => {
      deferred[0]?.({ authors: [kleppmann, fowler], cleanedQuery: "", exactMatchId: null });
    });

    await user.keyboard("{ArrowDown}");
    expect(await screen.findByText("Martin Fowler")).toBeDefined();
    expect(screen.queryByText("Martin Kleppmann")).toBeNull();
  });

  it("ignores a stale failure so a superseded rejection never shows an error", async () => {
    const deferred: Array<{
      resolve: (value: AuthorSearchDto) => void;
      reject: (reason: unknown) => void;
    }> = [];
    mockedSearchAuthors.mockImplementation(
      () =>
        new Promise<AuthorSearchDto>((resolve, reject) => {
          deferred.push({ reject, resolve });
        })
    );
    const { user } = renderField();
    const input = screen.getByRole("combobox");

    await waitFor(() => {
      expect(deferred.length).toBe(1);
    });
    await user.type(input, "Fowler");
    await waitFor(() => {
      expect(deferred.length).toBe(2);
    });

    // The superseded search rejects; because it is stale, no error surfaces.
    await act(async () => {
      deferred[0]?.reject(new Error("network"));
    });
    await act(async () => {
      deferred[1]?.resolve({ authors: [fowler], cleanedQuery: "Fowler", exactMatchId: fowler.id });
    });

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
