import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useMemo, useRef, useState } from "react";

import { documentText, type DocumentNodeJSON } from "@whetstone/document";

import { RichContentEditor } from "../../shared/editor/index.js";
import {
  createEmptyDocument,
  editorDocumentsEqual,
  validateEditorDocument
} from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";
import { CardsView } from "./CardsView";
import { NoteSourceDisclosure } from "./NoteSourceDisclosure";
import { NoteWorkspaceTabs, type WorkspaceTab } from "./NoteWorkspaceTabs";
import { noteWorkspaceClassNames as cx } from "./noteWorkspace.tokens";
import {
  type NoteWorkspaceHandle,
  type NoteWorkspaceOps,
  type NoteWorkspaceSource,
  type NoteWorkspaceTarget
} from "./noteWorkspaceModel";

type NoteWorkspaceProps = Readonly<{
  onClose: () => void;
  onDeleted?: (entryId: string) => void;
  onReviewChanged?: () => void;
  onSaved?: (handle: NoteWorkspaceHandle) => void;
  ops: NoteWorkspaceOps;
  target: NoteWorkspaceTarget;
}>;

const NOTE_TAB: WorkspaceTab = { controls: "note-panel", id: "note", label: "Note" };
const CARDS_TAB: WorkspaceTab = { controls: "cards-panel", id: "cards", label: "Cards" };

function initialBodyFor(target: NoteWorkspaceTarget): DocumentNodeJSON {
  // A brand-new capture starts empty; an existing note always carries a canonical body (Marks, which have
  // none, never open this workspace).
  return target.kind === "create" ? createEmptyDocument() : target.note.bodyDoc;
}

// The shared Note/Cards workspace (#700): the single focused surface that replaces the two divergent,
// stacked note editors (Reader `NoteEditor` and Notes-home `OwnedNoteEditor`). It hosts, in one wide
// `Sheet`, a Note|Cards mode tablist over two bodies — the same `RichContentEditor` (Note) and the
// list→detail→history Cards hierarchy — plus a header overflow whose only entry is the irreversible Delete.
// It is origin-agnostic: Reader (work-scoped commands over an anchored note) and Notes-home (owner-scoped
// commands over a standalone note) inject persistence through `ops`, and both drive Cards through the same
// owner-scoped, prompt-id API, so an anchored and a standalone note behave identically here.
//
// Two rules keep the surface honest. (1) Cards is unavailable until the note is persisted: a fresh capture
// opens in Note only, and the Cards tab appears after the first save (the create→edit transition is owned
// here, not by the origin). (2) A dirty Note blocks Cards: activating Cards with unsaved body changes keeps
// the learner in Note, announces why, and focuses Save, so cards are never managed against an unsaved note.
export function NoteWorkspace({
  onClose,
  onDeleted,
  onReviewChanged,
  onSaved,
  ops,
  target
}: NoteWorkspaceProps): React.JSX.Element {
  // Keep the editor's document identity stable for this workspace's lifetime: `RichContentEditor` treats
  // `document` as authoritative and resets on identity change, and create-mode `initialBodyFor` mints a
  // fresh empty doc each render. The parent keys this component per target, so a new target remounts fresh.
  const normalizedInitial = useMemo(() => validateEditorDocument(initialBodyFor(target)), [target]);
  const [persisted, setPersisted] = useState<NoteWorkspaceHandle | null>(
    target.kind === "edit" ? target.note : null
  );
  const [draft, setDraft] = useState<DocumentNodeJSON>(normalizedInitial);
  // The body the note was last persisted with, normalized like the editor's own emissions so the dirty
  // comparison is apples-to-apples: not dirty on mount, dirty after a real edit, not dirty right after a save.
  const [savedBody, setSavedBody] = useState<DocumentNodeJSON>(normalizedInitial);
  const [mode, setMode] = useState<"note" | "cards">("note");
  // Cards fetches the note's prompts on mount, so it stays unmounted until the learner first opens the tab
  // (a fresh capture never fetches) and then stays mounted — hidden when Note is active — so its list/detail/
  // history position survives tab round-trips and the delete-confirm overlay.
  const [cardsEverOpened, setCardsEverOpened] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [gateMessage, setGateMessage] = useState<string | null>(null);
  const [deleteView, setDeleteView] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);
  const saveRef = useRef<HTMLButtonElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);

  const heading = persisted === null ? "New note" : "Edit note";
  const blank = documentText(draft).trim().length === 0;
  const dirty = !editorDocumentsEqual(savedBody, draft);
  // The source shown as read-only provenance: a persisted note's own source, or a not-yet-saved capture's.
  // `captureSource` is derived unconditionally so both arms are exercised (an `edit` target evaluates the
  // `null` arm even though `activeSource` then prefers `persisted.source`), leaving no dead branch.
  const captureSource: NoteWorkspaceSource | null = target.kind === "create" ? target.source : null;
  const activeSource: NoteWorkspaceSource | null =
    persisted !== null ? persisted.source : captureSource;
  const tabs: ReadonlyArray<WorkspaceTab> = persisted === null ? [NOTE_TAB] : [NOTE_TAB, CARDS_TAB];

  function activateMode(next: string): void {
    if (next === mode) {
      return;
    }
    if (next === "cards") {
      if (dirty) {
        // Refuse the switch: cards are never managed against an unsaved note body. (The Cards tab only
        // exists once the note is persisted, so `next === "cards"` already implies a persisted note.)
        setGateMessage("Save note changes before managing cards.");
        saveRef.current?.focus();
        return;
      }
    }
    setGateMessage(null);
    setMode(next === "cards" ? "cards" : "note");
    if (next === "cards") {
      setCardsEverOpened(true);
    }
  }

  async function onSave(): Promise<void> {
    if (blank) {
      setError("Write something before saving the note.");
      return;
    }

    setError(undefined);
    setSaving(true);

    let handle: NoteWorkspaceHandle;
    try {
      handle = await ops.save(draft, persisted);
    } catch {
      setError("Could not save the note. Please try again.");
      setSaving(false);
      return;
    }

    setSaving(false);
    setPersisted(handle);
    // The editor still shows exactly `draft`, which we just persisted, so the new baseline is `draft`
    // (already normalized by the editor's emit): the note is clean immediately after a save.
    setSavedBody(draft);
    setGateMessage(null);
    onSaved?.(handle);
  }

  function openDelete(): void {
    setDeleteError(undefined);
    setDeleteView(true);
  }

  function cancelDelete(): void {
    setDeleteView(false);
    // The prior mode/view is untouched (only the body was hidden), so restore focus to the overflow trigger.
    overflowTriggerRef.current?.focus();
  }

  function confirmDelete(): void {
    /* c8 ignore next 3 -- unreachable: the Delete affordance (header overflow + confirm view) only
       renders when persisted !== null, so confirmDelete never runs on a not-yet-saved note. */
    if (persisted === null) {
      return;
    }
    const { entryId } = persisted;
    setDeleteError(undefined);
    setRemoving(true);
    ops.remove(entryId).then(
      () => {
        setRemoving(false);
        onDeleted?.(entryId);
      },
      () => {
        setRemoving(false);
        setDeleteError("Could not delete the note. Please try again.");
      }
    );
  }

  function handleOpenChange(open: boolean): void {
    /* c8 ignore next 3 -- unreachable: the Sheet's open prop is fixed true (the parent unmounts to
       close), so Radix only ever invokes onOpenChange for dismissal (open === false). */
    if (open) {
      return;
    }
    // Escape/outside dismissal closes the whole Sheet rather than acting as Back — but an in-flight save or
    // delete still blocks dismissal so a mutation is never abandoned mid-write.
    if (saving || removing) {
      return;
    }
    onClose();
  }

  const headerAction =
    persisted === null ? undefined : (
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label="Note actions"
            className="min-h-11 min-w-11 px-2"
            ref={overflowTriggerRef}
            variant="ghost"
          >
            <span aria-hidden="true">⋯</span>
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" className={cx.overflowContent} sideOffset={4}>
          <DropdownMenu.Item className={cx.overflowDestructiveItem} onSelect={openDelete}>
            Delete note
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    );

  return (
    <Sheet
      headerAction={headerAction}
      onOpenChange={handleOpenChange}
      open
      size="wide"
      title={heading}
    >
      {deleteView ? (
        <section aria-label="Delete note" className="noteWorkspaceDanger">
          <p>
            Delete this note
            {activeSource !== null ? <> “{activeSource.snapshot}”</> : null}? This cannot be undone.
          </p>
          {deleteError !== undefined ? <p role="alert">{deleteError}</p> : null}
          <div className="noteWorkspaceActions">
            <Button onClick={confirmDelete} pending={removing} type="button" variant="primary">
              Delete note
            </Button>
            <Button disabled={removing} onClick={cancelDelete} type="button" variant="secondary">
              Keep note
            </Button>
          </div>
        </section>
      ) : (
        <div className="noteWorkspace">
          <NoteWorkspaceTabs
            activeId={mode}
            label="Note workspace"
            onActivate={activateMode}
            tabs={tabs}
          />

          <div
            aria-labelledby="note-tab"
            className="noteWorkspacePanel"
            hidden={mode !== "note"}
            id="note-panel"
            role="tabpanel"
          >
            {activeSource !== null ? <NoteSourceDisclosure source={activeSource} /> : null}

            <RichContentEditor
              ariaLabel="Note body"
              document={normalizedInitial}
              onChange={setDraft}
              onSave={() => void onSave()}
              presentation="workspace"
            />

            {error !== undefined ? <p role="alert">{error}</p> : null}

            <div className="noteWorkspaceActions">
              <Button
                disabled={blank}
                onClick={() => void onSave()}
                pending={saving}
                ref={saveRef}
                type="button"
              >
                Save note
              </Button>
              <Button onClick={onClose} type="button" variant="secondary">
                Cancel
              </Button>
            </div>
          </div>

          {persisted !== null ? (
            <div
              aria-labelledby="cards-tab"
              className="noteWorkspacePanel"
              hidden={mode !== "cards"}
              id="cards-panel"
              role="tabpanel"
            >
              {cardsEverOpened ? (
                <CardsView
                  noteBodyDoc={savedBody}
                  noteEntryId={persisted.entryId}
                  onReviewChanged={() => onReviewChanged?.()}
                  sourceSnapshot={activeSource?.snapshot ?? null}
                />
              ) : null}
            </div>
          ) : null}

          <p aria-live="polite" className="noteWorkspaceAnnounce">
            {gateMessage}
          </p>
        </div>
      )}
    </Sheet>
  );
}
