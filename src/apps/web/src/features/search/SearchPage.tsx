import { useState, type FormEvent } from "react";

import type { SearchResultDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { searchLibrary } from "./searchApi";

type SearchState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "searching" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ query: string; results: ReadonlyArray<SearchResultDto>; status: "results" }>;

// Block-level library search (PRODUCT.md "v0 search"): a query field plus results that link back
// to the exact work/block in the reader. Empty/blank queries do nothing; the result list shows an
// explicit no-matches state so an empty response is never ambiguous.
export function SearchPage(): React.JSX.Element {
  const [term, setTerm] = useState("");
  const [state, setState] = useState<SearchState>({ status: "idle" });

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = term.trim();

    if (trimmed.length === 0) {
      return;
    }

    setState({ status: "searching" });

    try {
      const response = await searchLibrary(trimmed);
      setState({ query: response.query, results: response.results, status: "results" });
    } catch {
      setState({ status: "error" });
    }
  }

  return (
    <section aria-labelledby="search-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="search-heading">
        Search
      </h1>
      <p className="mt-2 text-text-muted">
        Find words and phrases across every work in your library.
      </p>

      <form className="mt-4 flex gap-2" onSubmit={(event) => void onSubmit(event)} role="search">
        <label className="sr-only" htmlFor="search-query">
          Search query
        </label>
        <input
          autoComplete="off"
          className="flex-1 rounded border border-border bg-surface px-3 py-2 text-text"
          id="search-query"
          onChange={(event) => setTerm(event.currentTarget.value)}
          placeholder="Search the library…"
          type="search"
          value={term}
        />
        <Button type="submit">Search</Button>
      </form>

      <div className="mt-6">{renderState(state)}</div>
    </section>
  );
}

function renderState(state: SearchState): React.JSX.Element | null {
  if (state.status === "idle") {
    return null;
  }

  if (state.status === "searching") {
    return <LoadingIndicator label="Searching…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not run the search. Please try again.
      </p>
    );
  }

  if (state.results.length === 0) {
    return <p className="text-text-muted">No matches for “{state.query}”.</p>;
  }

  return (
    <ol aria-label="Search results" className="flex flex-col gap-3">
      {state.results.map((result) => (
        <li key={result.blockEntryId}>
          <a
            className="block rounded border border-border bg-surface p-4 hover:border-accent"
            href={`#/reader?work=${encodeURIComponent(result.workEntryId)}&block=${encodeURIComponent(
              result.blockEntryId
            )}`}
          >
            <span className="text-sm text-text-muted">
              {result.authorName} · {result.workTitle}
            </span>
            <p className="mt-1 text-text">{result.plaintext}</p>
          </a>
        </li>
      ))}
    </ol>
  );
}
