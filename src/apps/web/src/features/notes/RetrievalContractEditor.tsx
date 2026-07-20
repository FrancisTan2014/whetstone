import { useState } from "react";

import type { NoteGradingTarget } from "@whetstone/contracts";
import { documentText, type DocumentNodeJSON } from "@whetstone/document";

import { PmDocument } from "../reader/PmDocument.js";
import { RichContentEditor } from "../../shared/editor/index.js";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";

// The grading-target disclosure state, owned by the parent so the derived `NoteGradingTarget` and the
// authored Success check survive a preview round-trip and a failed submit. Closed grades against the whole
// workspace (the note itself); open grades against the authored Success check.
export type SuccessCheckState =
  | Readonly<{ open: false }>
  | Readonly<{ open: true; doc: DocumentNodeJSON }>;

// The grading target this disclosure describes: a closed disclosure grades against the current note; an
// open one grades against the authored Success check. Kept pure so a caller can build a request without
// reaching into the editor.
export function gradingTargetFor(successCheck: SuccessCheckState): NoteGradingTarget {
  return successCheck.open
    ? { kind: "expected_response", successCheckDoc: successCheck.doc }
    : { kind: "current_note" };
}

// Whether a rich document carries no reviewable content: its derived readable text is only whitespace. The
// same blank rule the server enforces, applied client-side to gate the actions before a doomed request.
export function isDocumentBlank(document: DocumentNodeJSON): boolean {
  return documentText(document).trim().length === 0;
}

type RetrievalContractEditorProps = Readonly<{
  // The workspace control the parent owns: an editable Answer (the direct-card composer) or, later, a
  // read-only Reference for a saved note (#687). The editor only frames and labels it.
  workspace: React.ReactNode;
  // The workspace document, rendered read-only inside the Try preview's reveal so the learner sees exactly
  // what the card will show. Never mutated here.
  workspaceDoc: DocumentNodeJSON;
  // Whether the workspace document is blank, computed by the parent that owns it. Gates the Try preview.
  workspaceBlank: boolean;
  // The workspace heading while grading against the note itself; relabels to `referenceLabel` once a
  // Success check is open, because the workspace then plays the broader Reference the check judges against.
  answerLabel?: string;
  referenceLabel?: string;
  questionDoc: DocumentNodeJSON;
  onQuestionChange: (document: DocumentNodeJSON) => void;
  questionInvalid?: boolean;
  successCheck: SuccessCheckState;
  onSuccessCheckChange: (next: SuccessCheckState) => void;
  successCheckInvalid?: boolean;
  // The parent's primary actions (e.g. Create card + Cancel), shown only while editing and hidden during
  // the Try preview so the learner rehearses the card without a stray commit control.
  actions: React.ReactNode;
}>;

// The reusable Notes-owned retrieval-contract editor (#690): it authors the retrieval prompt (Question) and
// the grading target (grade against the whole note, or a specific Success check) around a parent-owned
// workspace, and offers a local Try preview that rehearses the exact review sequence without minting a
// prompt, card, or event. The direct-card composer supplies an editable Answer as the workspace; the saved
// note workspace (#687) will supply a read-only Reference. All business state is lifted to the parent so it
// survives preview and failed submits; the editor owns only the ephemeral preview and discard-confirm UI.
export function RetrievalContractEditor({
  actions,
  answerLabel = "Answer",
  onQuestionChange,
  onSuccessCheckChange,
  questionDoc,
  questionInvalid = false,
  referenceLabel = "Reference",
  successCheck,
  successCheckInvalid = false,
  workspace,
  workspaceBlank,
  workspaceDoc
}: RetrievalContractEditorProps): React.JSX.Element {
  const [previewing, setPreviewing] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const questionBlank = isDocumentBlank(questionDoc);
  const successCheckBlank = successCheck.open ? isDocumentBlank(successCheck.doc) : false;
  // The card can only be rehearsed once every part it will show is present: the Question, the workspace it
  // reveals, and — when grading against a Success check — a non-blank check.
  const previewReady = !questionBlank && !workspaceBlank && !successCheckBlank;

  if (previewing) {
    return (
      <RetrievalPreview
        onBack={() => setPreviewing(false)}
        questionDoc={questionDoc}
        successCheck={successCheck}
        workspaceDoc={workspaceDoc}
      />
    );
  }

  function toggleSuccessCheck(): void {
    if (!successCheck.open) {
      onSuccessCheckChange({ doc: createEmptyDocument(), open: true });
      return;
    }
    // Closing discards the authored Success check, so confirm first when it carries content; a blank check
    // closes silently because there is nothing to lose.
    if (successCheck.open && !isDocumentBlank(successCheck.doc)) {
      setConfirmingDiscard(true);
      return;
    }
    onSuccessCheckChange({ open: false });
  }

  function discardSuccessCheck(): void {
    setConfirmingDiscard(false);
    onSuccessCheckChange({ open: false });
  }

  return (
    <div className="retrievalContract">
      <section aria-label="Workspace" className="retrievalContractSection">
        <h3 className="retrievalContractLabel">
          {successCheck.open ? referenceLabel : answerLabel}
        </h3>
        {successCheck.open ? (
          <p className="retrievalContractHelp text-text-muted">
            Use this when the whole reference is broader than what you intend to retrieve.
          </p>
        ) : null}
        {workspace}
      </section>

      <section aria-label="Retrieval prompt" className="retrievalContractSection">
        <h3 className="retrievalContractLabel">What should bring it to mind?</h3>
        <RichContentEditor
          ariaLabel="Question"
          document={questionDoc}
          onChange={onQuestionChange}
          presentation="compact"
        />
        {questionInvalid ? (
          <p className="text-danger" role="alert">
            Write what should bring it to mind.
          </p>
        ) : null}
      </section>

      <p className="retrievalContractGuidance text-text-muted">
        One target · clear trigger · enough to judge.
      </p>

      <section aria-label="Grading target" className="retrievalContractSection">
        <Button
          aria-expanded={successCheck.open}
          onClick={toggleSuccessCheck}
          type="button"
          variant="ghost"
        >
          {successCheck.open ? "Remove success check" : "Add a specific success check"}
        </Button>
        {successCheck.open ? (
          <div className="retrievalContractSuccessCheck">
            <p className="retrievalContractHelp text-text-muted">
              What must their answer contain to count as recalled?
            </p>
            <RichContentEditor
              ariaLabel="Success check"
              document={successCheck.doc}
              onChange={(doc) => onSuccessCheckChange({ doc, open: true })}
              presentation="compact"
            />
            {successCheckInvalid ? (
              <p className="text-danger" role="alert">
                Write the success check, or remove it.
              </p>
            ) : null}
          </div>
        ) : null}
        {confirmingDiscard ? (
          <div className="retrievalContractConfirm">
            <p>Remove the success check you wrote? This cannot be undone.</p>
            <div className="retrievalContractConfirmActions">
              <Button onClick={discardSuccessCheck} type="button" variant="primary">
                Remove it
              </Button>
              <Button onClick={() => setConfirmingDiscard(false)} type="button" variant="secondary">
                Keep it
              </Button>
            </div>
          </div>
        ) : null}
      </section>

      <div className="retrievalContractActions">
        <Button
          disabled={!previewReady}
          onClick={() => setPreviewing(true)}
          type="button"
          variant="secondary"
        >
          Try card
        </Button>
        {actions}
      </div>
    </div>
  );
}

// The local Try preview: it rehearses the exact Notes review sequence — Question, then a single Reveal —
// against the current drafts, minting nothing (no prompt, card, or event). Reveal mirrors the live review:
// a Success-check target shows the check plus the Reference; a note target shows the whole note. "Back to
// editing" returns to the form with every draft intact.
function RetrievalPreview({
  onBack,
  questionDoc,
  successCheck,
  workspaceDoc
}: Readonly<{
  onBack: () => void;
  questionDoc: DocumentNodeJSON;
  successCheck: SuccessCheckState;
  workspaceDoc: DocumentNodeJSON;
}>): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="retrievalPreview" aria-label="Card preview">
      <p className="retrievalPreviewBadge text-text-muted">Preview · nothing is saved</p>
      <div className="text-lg text-text">
        <PmDocument document={questionDoc} />
      </div>
      {revealed ? (
        successCheck.open ? (
          <>
            <div aria-label="Success check" className="retrievalPreviewReveal">
              <PmDocument document={successCheck.doc} />
            </div>
            <div aria-label="Reference" className="retrievalPreviewReveal text-text-muted">
              <PmDocument document={workspaceDoc} />
            </div>
          </>
        ) : (
          <div aria-label="Note" className="retrievalPreviewReveal">
            <PmDocument document={workspaceDoc} />
          </div>
        )
      ) : null}
      <div className="retrievalPreviewActions">
        {revealed ? null : (
          <Button onClick={() => setRevealed(true)} type="button" variant="primary">
            Reveal
          </Button>
        )}
        <Button onClick={onBack} type="button" variant="secondary">
          Back to editing
        </Button>
      </div>
    </div>
  );
}
