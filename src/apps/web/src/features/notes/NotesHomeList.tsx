import { forwardRef } from "react";

import { isAnchoredNoteOverview, type NoteOverviewDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button";
import { reviewSummaryLabel } from "./noteReviewSummaryLabel";

type NotesHomeListProps = Readonly<{
  notes: ReadonlyArray<NoteOverviewDto>;
  onOpen: (note: NoteOverviewDto) => void;
  openRef?: React.Ref<HTMLButtonElement>;
  openTargetEntryId?: string | undefined;
  timeZone: string;
}>;

// A short, single-line plaintext preview of a note's body, so a long note never blows out the row. The
// server already derived `bodyText`; we only trim and clamp its length for the row.
function bodyPreview(bodyText: string | null): string {
  const normalized = (bodyText ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 140 ? `${normalized.slice(0, 139)}…` : normalized;
}

// The single continuous Notes-home list (#659): every owned note once, in the server's recency order (no
// grouping by work). Each row shows what its kind warrants — an anchored note shows its source quote, its
// Work title, and an "Open in Reader" deep-link; an unanchored note shows its body only (no fabricated
// source); a Mark shows its quote and the "Mark" label with no body and no review action. A reviewable
// note also shows its one projected Review state and a single "Open" target into the editor. The list holds
// no state: the parent owns opening. `openRef`/`openTargetEntryId` let the parent restore focus to the row
// it just closed.
export function NotesHomeList({
  notes,
  onOpen,
  openRef,
  openTargetEntryId,
  timeZone
}: NotesHomeListProps): React.JSX.Element {
  // One `now` for the whole render so every row's next-review label resolves against the same instant.
  const now = new Date();
  return (
    <ul aria-label="Your notes" className="flex flex-col gap-3">
      {notes.map((note) => (
        <NotesHomeRow
          key={note.entryId}
          note={note}
          now={now}
          onOpen={onOpen}
          openRef={note.entryId === openTargetEntryId ? openRef : undefined}
          timeZone={timeZone}
        />
      ))}
    </ul>
  );
}

type NotesHomeRowProps = Readonly<{
  note: NoteOverviewDto;
  now: Date;
  onOpen: (note: NoteOverviewDto) => void;
  openRef?: React.Ref<HTMLButtonElement> | undefined;
  timeZone: string;
}>;

function NotesHomeRow({
  note,
  now,
  onOpen,
  openRef,
  timeZone
}: NotesHomeRowProps): React.JSX.Element {
  const anchored = isAnchoredNoteOverview(note);
  const isMark = note.kind === "mark";

  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
      {anchored ? (
        <p className="text-sm text-text-muted">“{note.anchor.selectedTextSnapshot}”</p>
      ) : null}

      {isMark ? (
        <span className="inline-flex w-fit rounded bg-surface-muted px-2 py-0.5 text-xs font-medium text-text-muted">
          Mark
        </span>
      ) : (
        <p className="whitespace-pre-wrap text-text">{bodyPreview(note.bodyText)}</p>
      )}

      {anchored ? <p className="text-xs text-text-muted">{note.workTitle}</p> : null}

      <div className="mt-1 flex flex-wrap items-center gap-3">
        {isMark ? null : <OpenNoteButton note={note} onOpen={onOpen} ref={openRef} />}
        {isMark ? null : (
          <span className="text-xs text-text-muted">
            {reviewSummaryLabel(note.review, now, timeZone)}
          </span>
        )}
        {anchored ? (
          <a
            className={buttonVariants({ size: "sm", variant: "ghost" })}
            href={`#/reader?work=${encodeURIComponent(note.workEntryId)}&block=${encodeURIComponent(
              note.blockEntryId
            )}`}
          >
            Open in Reader
          </a>
        ) : null}
      </div>
    </li>
  );
}

type OpenNoteButtonProps = Readonly<{
  note: NoteOverviewDto;
  onOpen: (note: NoteOverviewDto) => void;
}>;

// The row's single, always-visible open target (never hover-only), labeled by the note so the accessible
// name is unique. It forwards a ref so the page can return focus here after the editor closes.
const OpenNoteButton = forwardRef<HTMLButtonElement, OpenNoteButtonProps>(function OpenNoteButton(
  { note, onOpen },
  ref
): React.JSX.Element {
  const label =
    note.anchor === null ? bodyPreview(note.bodyText) : note.anchor.selectedTextSnapshot;

  return (
    <button
      aria-label={`Open note: ${label}`}
      className={buttonVariants({ size: "sm", variant: "secondary" })}
      onClick={() => onOpen(note)}
      ref={ref}
      type="button"
    >
      Open
    </button>
  );
});
