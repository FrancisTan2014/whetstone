import { useState } from "react";

import { type NoteWorkspaceSource, readerLinkFor } from "./noteWorkspaceModel";
import { Button, buttonVariants } from "../../shared/ui/Button";

type NoteSourceDisclosureProps = Readonly<{ source: NoteWorkspaceSource }>;

// The immutable source an anchored note was captured from, shown as read-only provenance above the note
// body (#700). It stays compact — the exact selected text collapses to three lines behind an explicit
// show/hide control so a long selection never pushes the editor off-screen — and offers "Open in Reader"
// only when the anchored block resolves to a location. It is never editable and never copied into the note.
export function NoteSourceDisclosure({ source }: NoteSourceDisclosureProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const readerLink = readerLinkFor(source);

  return (
    <section aria-label="Source" className="noteWorkspaceSource">
      <p
        className={
          expanded
            ? "noteWorkspaceSourceText"
            : "noteWorkspaceSourceText noteWorkspaceSourceText--clamped"
        }
      >
        Source: “{source.snapshot}”
      </p>
      <div className="noteWorkspaceSourceActions">
        <Button
          aria-expanded={expanded}
          className="min-h-11"
          onClick={() => setExpanded((open) => !open)}
          size="sm"
          type="button"
          variant="ghost"
        >
          {expanded ? "Hide source" : "Show full source"}
        </Button>
        {readerLink !== null ? (
          <a className={buttonVariants({ size: "sm", variant: "ghost" })} href={readerLink}>
            Open in Reader
          </a>
        ) : null}
      </div>
    </section>
  );
}
