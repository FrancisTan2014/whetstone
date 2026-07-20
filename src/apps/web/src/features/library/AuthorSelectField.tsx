import type { AuthorDto, WorkAuthorSelection } from "@whetstone/contracts";
import { useCombobox } from "downshift";
import { useEffect, useId, useRef, useState } from "react";

import { searchAuthors } from "./libraryApi";

// The one create-or-select author/source field (#694). It searches the canonical author list and offers
// an explicit "Add" only for a genuinely new name, so reuse is the default and duplicates cannot be
// created by accident. All identity policy (cleaning, matching, exact-match detection) lives on the
// server; this field is purely presentational over the `searchAuthors` boundary.

export type AuthorSelectFieldProps = Readonly<{
  // Reports the effective selection (or `undefined` when nothing is committed) so the form can block a
  // submit that would implicitly create from unselected free text.
  onSelectionChange: (selection: WorkAuthorSelection | undefined) => void;
}>;

type AuthorItem = Readonly<{ kind: "author"; author: AuthorDto }>;
type AddItem = Readonly<{ kind: "add"; name: string }>;
type ComboItem = AuthorItem | AddItem;

type SearchStatus = "loading" | "ready" | "error";

const debounceMs = 150;

function itemToString(item: ComboItem | null): string {
  /* v8 ignore next 3 -- downshift's itemToString type accepts null, but it guards null itself and never
     stringifies a null selection at runtime, so this empty-string path is unreachable in practice. */
  if (item === null) {
    return "";
  }

  return item.kind === "author" ? item.author.name : item.name;
}

export function AuthorSelectField({
  onSelectionChange
}: AuthorSelectFieldProps): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<AuthorDto>>([]);
  const [exactMatchId, setExactMatchId] = useState<string | null>(null);
  // The raw query the current results/exactMatchId belong to. It gates the effective selection so a
  // stale exact match from a previous query can never resolve after the input is edited but before the
  // debounced search for the new text completes.
  const [searchedQuery, setSearchedQuery] = useState("");
  const [cleanedQuery, setCleanedQuery] = useState("");
  const [status, setStatus] = useState<SearchStatus>("loading");
  // A monotonic request id so a slow earlier search can never overwrite a newer result.
  const requestSeq = useRef(0);
  // Bumped to force a re-search after a transient failure without changing the query text.
  const [retryTick, setRetryTick] = useState(0);
  const errorId = useId();

  useEffect(() => {
    // A monotonic request id: bumping it on cleanup supersedes any pending/in-flight search, so an
    // unmount or a newer query can never let a stale response overwrite the current results.
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const timer = setTimeout(() => {
      // Flip to loading only once the debounced request actually starts (never synchronously in the
      // effect body), so rapid typing keeps the prior results visible until a search is really in flight.
      setStatus("loading");
      searchAuthors(query)
        .then((response) => {
          if (requestSeq.current !== seq) {
            return;
          }
          setResults(response.authors);
          setExactMatchId(response.exactMatchId);
          setCleanedQuery(response.cleanedQuery);
          setSearchedQuery(query);
          setStatus("ready");
        })
        .catch(() => {
          if (requestSeq.current !== seq) {
            return;
          }
          setStatus("error");
        });
    }, debounceMs);

    return () => {
      requestSeq.current += 1;
      clearTimeout(timer);
    };
  }, [query, retryTick]);

  // "Add" is authoritative-suppression: it appears only when the search SUCCEEDED, the query is nonblank,
  // and there is no exact canonical match — so `Martin Kleppmann` never blocks adding `Martin Fowler`,
  // while a case/width/whitespace variant of an existing name resolves to it instead of creating.
  const showAdd = status === "ready" && cleanedQuery !== "" && exactMatchId === null;
  const items: ReadonlyArray<ComboItem> = [
    ...results.map((author): ComboItem => ({ kind: "author", author })),
    ...(showAdd ? [{ kind: "add", name: cleanedQuery } as ComboItem] : [])
  ];

  const {
    getInputProps,
    getItemProps,
    getLabelProps,
    getMenuProps,
    highlightedIndex,
    isOpen,
    selectedItem
  } = useCombobox<ComboItem>({
    items: items as ComboItem[],
    itemToString,
    stateReducer(state, { type, changes }) {
      switch (type) {
        // Typing after a selection clears it and returns to pure search (effective selection recomputes).
        case useCombobox.stateChangeTypes.InputChange:
          return { ...changes, selectedItem: null };
        // Tab/blur must never create or commit the highlighted item; leave text and selection intact.
        case useCombobox.stateChangeTypes.InputBlur:
          return { ...changes, inputValue: state.inputValue, selectedItem: state.selectedItem };
        // Escape closes the list without clearing the query or the current selection.
        case useCombobox.stateChangeTypes.InputKeyDownEscape:
          return {
            ...changes,
            inputValue: state.inputValue,
            isOpen: false,
            selectedItem: state.selectedItem
          };
        default:
          return changes;
      }
    },
    onInputValueChange({ inputValue }) {
      setQuery(inputValue);
    }
  });

  // The effective selection: an explicit pick wins; otherwise an exact canonical match resolves as the
  // existing selection (on submit as well as on blur), but only while it belongs to the current input —
  // `searchedQuery === query` gates it so a stale exact match from a prior query can never resolve after
  // the text is edited but before the debounced search for the new text completes. Unselected non-exact
  // free text stays `undefined`, so the form's explicit-creation rule blocks an accidental duplicate.
  useEffect(() => {
    let selection: WorkAuthorSelection | undefined;
    if (selectedItem !== null) {
      selection =
        selectedItem.kind === "author"
          ? { authorId: selectedItem.author.id, mode: "existing" }
          : { mode: "new", name: selectedItem.name };
    } else if (exactMatchId !== null && searchedQuery === query) {
      selection = { authorId: exactMatchId as AuthorDto["id"], mode: "existing" };
    }
    onSelectionChange(selection);
  }, [selectedItem, exactMatchId, searchedQuery, query, onSelectionChange]);

  const showEmptyHint = status === "ready" && items.length === 0;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-text" {...getLabelProps()}>
        Author or source
      </label>
      <div className="relative">
        <input
          className="min-h-11 w-full rounded border border-border bg-surface px-3 py-2"
          placeholder="Search or add an author or source"
          {...getInputProps({ "aria-describedby": status === "error" ? errorId : undefined })}
        />
        <ul
          className={`absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-auto rounded border border-border bg-surface shadow-lg ${
            isOpen ? "" : "hidden"
          }`}
          {...getMenuProps()}
        >
          {isOpen ? (
            <>
              {items.map((item, index) => (
                <li
                  className={`flex min-h-11 cursor-pointer flex-col justify-center px-3 py-2 ${
                    highlightedIndex === index ? "bg-surface-muted" : ""
                  }`}
                  key={item.kind === "author" ? item.author.id : `add:${item.name}`}
                  {...getItemProps({ index, item })}
                >
                  {item.kind === "author" ? (
                    <span className="text-text">{item.author.name}</span>
                  ) : (
                    <>
                      <span className="text-text">Add “{item.name}”</span>
                      <span className="text-sm text-text-muted">New author or source</span>
                    </>
                  )}
                </li>
              ))}
              {showEmptyHint ? (
                <li className="px-3 py-2 text-sm text-text-muted">
                  Type a name to add your first author or source.
                </li>
              ) : null}
            </>
          ) : null}
        </ul>
      </div>
      {status === "error" ? (
        <p className="flex items-center gap-2 text-sm text-danger" id={errorId} role="alert">
          Couldn’t search authors and sources.
          <button
            className="min-h-11 rounded px-2 underline"
            onClick={() => setRetryTick((tick) => tick + 1)}
            type="button"
          >
            Retry
          </button>
        </p>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {status === "loading"
          ? "Searching authors and sources."
          : status === "error"
            ? "Author search failed."
            : `${items.length} result${items.length === 1 ? "" : "s"} available.`}
      </span>
    </div>
  );
}
