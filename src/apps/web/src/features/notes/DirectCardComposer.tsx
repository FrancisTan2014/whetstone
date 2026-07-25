import { useEffect, useRef, useState } from "react";

import type {
  DirectCardResultDto,
  DirectCardSaveResultDto,
  MaterialReviewDto
} from "@whetstone/contracts";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { normalizeLexicalSurface } from "@whetstone/domain";

import { MaterialReviewPanel } from "./MaterialReviewPanel";
import { RelatedMaterialDisclosure } from "./RelatedMaterialDisclosure";
import {
  RetrievalContractEditor,
  gradingTargetFor,
  isDocumentBlank,
  type SuccessCheckState
} from "./RetrievalContractEditor";
import {
  CreateDirectCardError,
  createDirectCard,
  fetchMaterialMatches,
  keepSeparateMaterial,
  MaterialDecisionError,
  reuseExistingMaterial,
  type CreateDirectCardErrorKind,
  type MaterialDecisionErrorKind,
  type MaterialMatchesResult
} from "../notesReview/notesReviewApi";
import { RichContentEditor } from "../../shared/editor/index.js";
import { createEmptyDocument } from "../../shared/editor/editorDocument.js";
import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";

// How long the Answer must sit idle before the advisory exact-material hint fires. Long enough that ordinary
// typing never triggers a request, short enough that a paused learner sees the warning before they save.
const MATERIAL_HINT_DEBOUNCE_MS = 350;

type DirectCardComposerProps = Readonly<{
  onClose: () => void;
  // A resolved card. `outcome` distinguishes a freshly minted note (`created`) from the drafted contract
  // being added to an existing note via Use existing material (`reused`) so the parent announces which
  // happened in its live region.
  onCreated: (result: DirectCardResultDto, outcome: "created" | "reused") => void;
}>;

// The failure copy for each recoverable SAVE outcome. Every case keeps the learner's drafts on screen; the
// message only tells them whether to retry as-is (`network`) or that the drafts must change (`conflict`,
// `gone`, `invalid`). Kept exhaustive so a new error kind is a type error, not a silent blank.
const failureMessages: Readonly<Record<CreateDirectCardErrorKind, string>> = {
  conflict: "This card was already started with different wording. Edit a field and try again.",
  gone: "That draft can no longer be used. Edit a field to start a fresh card.",
  invalid: "Whetstone could not accept this card. Check the question and answer, then try again.",
  network: "Could not create the card. Please try again."
};

// The direct-card composer (#690, reviewed by #712): the primary Notes-home action opens this wide sheet to
// mint one recurring review card straight from an authored Question/Answer pair — no saved note required
// first. It owns every draft (Answer, Question, Success check) plus a `submissionId`, minted when the sheet
// opens and kept across a lost-response (`network`) retry so it is idempotent and never double-creates, but
// refreshed after a `conflict`/`gone` outcome whose server receipt is already burned so the edited card is a
// new one. As the Answer settles it debounces an advisory hint — "This material is already in Notes" — but
// the authority is the save: when the saved Answer already exists in Notes the server returns
// `needs_material_review` and this parks the material-review panel over the still-intact draft, where the
// learner adds the card to an existing note (Use existing material) or mints a distinct one (Keep separate).
// A blank required field blocks creation inline; a failed create keeps everything on screen; a pending
// create prevents dismissal and a repeat submit. On success the parent closes, refreshes, and announces
// whether the card was created or reused.
export function DirectCardComposer({
  onClose,
  onCreated
}: DirectCardComposerProps): React.JSX.Element {
  // The retry identity: minted when the sheet opens and kept across a `network` failure so a lost-response
  // retry replays one creation, never two. A `conflict` (the server recorded a receipt for this id with
  // different wording) or `gone` (the receipt was tombstoned) burns the id — reusing it would loop forever
  // against the same rejection — so those outcomes mint a fresh id for the next attempt.
  const [submissionId, setSubmissionId] = useState(() => crypto.randomUUID());
  const [answerDoc, setAnswerDoc] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [questionDoc, setQuestionDoc] = useState<DocumentNodeJSON>(() => createEmptyDocument());
  const [successCheck, setSuccessCheck] = useState<SuccessCheckState>({ open: false });
  const [answerInvalid, setAnswerInvalid] = useState(false);
  const [questionInvalid, setQuestionInvalid] = useState(false);
  const [successCheckInvalid, setSuccessCheckInvalid] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateDirectCardErrorKind | null>(null);
  // A free-form notice shown in the composer after a review decision could not be applied and control
  // returned here (the review was spent, or its receipt was burned). It tells the learner to save again.
  const [notice, setNotice] = useState<string | null>(null);
  // The parked material review, or null when the composer is the active surface. When set, the review panel
  // renders over the composer; the composer's drafts and `submissionId` stay mounted so Back restores them.
  const [review, setReview] = useState<MaterialReviewDto | null>(null);
  // A retryable error shown INSIDE the panel after a decision failed transiently (`network`/`invalid`) or
  // the reviewed evidence changed, so the learner can decide again without losing the panel.
  const [reviewError, setReviewError] = useState<string | null>(null);
  // The advisory material-matches result for the current Answer draft, or null before the first result. It
  // carries both the exact and near candidate groups, or an error so the composer offers Retry. Purely
  // informational: the save always reprojects and rechecks, so a stale, missing, or failed hint is harmless.
  const [hint, setHint] = useState<MaterialMatchesResult | null>(null);
  // A monotonic sequence so only the most recently scheduled hint request is applied: every Answer change
  // bumps it, so any earlier in-flight response is stale and ignored (cancellation + out-of-order safety).
  const hintSeq = useRef(0);
  // Bumped when the learner retries a failed hint, so the effect re-runs its request without an Answer edit.
  const [hintRetry, setHintRetry] = useState(0);

  const answerBlank = isDocumentBlank(answerDoc);
  // The eligible single-word surface of the Answer, or null when it is blank, multi-word, or not one ASCII
  // English word — the same rule the lexical service applies (#715). Non-null gates the opt-in "Find related
  // material" disclosure; the parent keys it by this surface so it remounts and resets when the word changes.
  const relatedSurface = normalizeLexicalSurface(documentReadableText(answerDoc));

  useEffect(() => {
    // Every Answer change (or the panel opening, or a Retry) bumps the sequence so an in-flight response from
    // a prior draft is stale and ignored. While the Answer is blank or the review panel owns the surface there
    // is no advisory: return without scheduling — the render gate already hides any prior hint, and no
    // synchronous setState runs in the effect body, so there is no cascading render.
    const seq = (hintSeq.current += 1);
    if (answerBlank || review !== null) {
      return;
    }
    const handle = setTimeout(() => {
      void fetchMaterialMatches(answerDoc).then((result) => {
        // Ignore a response the Answer has since moved past: only the latest scheduled request wins.
        if (seq === hintSeq.current) {
          setHint(result);
        }
      });
    }, MATERIAL_HINT_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [answerBlank, answerDoc, hintRetry, review]);

  function requestClose(): void {
    // A create or decision in flight owns the sheet: dismissing mid-request could strand a card the
    // retry-safe id would otherwise recover, so the close is ignored until it settles.
    if (pending) {
      return;
    }
    onClose();
  }

  // Land a resolved save/decision outcome. `created`/`reused` hand the card to the parent to announce and
  // close; `needs_material_review` parks (or refreshes) the review panel over the intact draft. When the
  // refresh arrives from a DECISION the reviewed evidence changed underneath the learner, so surface that in
  // the panel; entering review straight from a save is the normal first stop and carries no error.
  function landOutcome(outcome: DirectCardSaveResultDto, fromDecision: boolean): void {
    switch (outcome.status) {
      case "created":
        onCreated(outcome.result, "created");
        return;
      case "reused":
        onCreated(outcome.result, "reused");
        return;
      case "needs_material_review":
        setReview(outcome.review);
        setReviewError(
          fromDecision ? "The existing material changed — please review it again." : null
        );
        return;
    }
  }

  async function create(): Promise<void> {
    const questionBlank = isDocumentBlank(questionDoc);
    const successCheckBlank = successCheck.open ? isDocumentBlank(successCheck.doc) : false;
    // Validate every required field at once so all inline messages surface together, then stop before a
    // request that the server would only reject.
    setAnswerInvalid(answerBlank);
    setQuestionInvalid(questionBlank);
    setSuccessCheckInvalid(successCheckBlank);
    if (answerBlank || questionBlank || successCheckBlank) {
      return;
    }

    setFailure(null);
    setNotice(null);
    setPending(true);
    let outcome: DirectCardSaveResultDto;
    try {
      outcome = await createDirectCard({
        answerDoc,
        questionDoc,
        submissionId,
        target: gradingTargetFor(successCheck)
      });
    } catch (error) {
      // Keep every draft on screen; only surface why so the learner can retry as-is or edit. A `network`
      // failure is retry-safe with the same id; a `conflict`/`gone` receipt is already burned server-side, so
      // mint a fresh id or the suggested edit-and-retry would loop forever against the same rejected receipt.
      const kind = error instanceof CreateDirectCardError ? error.kind : "network";
      if (kind === "conflict" || kind === "gone") {
        setSubmissionId(crypto.randomUUID());
      }
      setFailure(kind);
      return;
    } finally {
      setPending(false);
    }
    landOutcome(outcome, false);
  }

  // Route a decision failure. `network`/`invalid` are retryable in place, so keep the panel and show the
  // reason. `attempt_not_found`/`expired`/`superseded`/`changed_payload` mean the parked review no longer
  // applies but the submission receipt is intact, so return to the composer to save again with the same id.
  // `conflict`/`gone` burned the receipt, so mint a fresh id before returning.
  function handleDecisionError(kind: MaterialDecisionErrorKind): void {
    if (kind === "network" || kind === "invalid") {
      setReviewError("Could not complete that just now. Please try again.");
      return;
    }
    if (kind === "conflict" || kind === "gone") {
      setSubmissionId(crypto.randomUUID());
      setNotice("That draft can no longer be used. Edit a field to start a fresh card.");
    } else {
      setNotice("This review is no longer available. Save again to re-check your Notes.");
    }
    setReview(null);
    setReviewError(null);
  }

  async function runDecision(run: () => Promise<DirectCardSaveResultDto>): Promise<void> {
    setReviewError(null);
    setPending(true);
    let outcome: DirectCardSaveResultDto;
    try {
      outcome = await run();
    } catch (error) {
      handleDecisionError(error instanceof MaterialDecisionError ? error.kind : "network");
      return;
    } finally {
      setPending(false);
    }
    landOutcome(outcome, true);
  }

  function decideUseExisting(noteId: string): void {
    // The panel only mounts with a non-null review, so this null guard is a type-narrowing invariant that is
    // never taken at runtime; it exists purely to narrow `review` for the request below.
    /* v8 ignore next 3 */
    if (review === null) {
      return;
    }
    const current = review;
    void runDecision(() =>
      reuseExistingMaterial({
        answerDoc,
        attemptId: current.attemptId,
        noteEntryId: noteId,
        questionDoc,
        revision: current.revision,
        submissionId,
        target: gradingTargetFor(successCheck)
      })
    );
  }

  function decideKeepSeparate(): void {
    // Same type-narrowing invariant as decideUseExisting: the panel only mounts with a non-null review, so
    // this guard is never taken at runtime.
    /* v8 ignore next 3 */
    if (review === null) {
      return;
    }
    const current = review;
    void runDecision(() =>
      keepSeparateMaterial({
        answerDoc,
        attemptId: current.attemptId,
        questionDoc,
        revision: current.revision,
        submissionId,
        target: gradingTargetFor(successCheck)
      })
    );
  }

  // Back from the review: drop the panel and reveal the composer beneath with every draft and the
  // `submissionId` intact (they were never cleared). Radix returns focus to the Create card button that
  // opened the review. Nothing was created, so the learner can edit and save again.
  function backFromReview(): void {
    setReview(null);
    setReviewError(null);
  }

  return (
    <>
      <Sheet onOpenChange={requestClose} open size="wide" title="New card">
        <RetrievalContractEditor
          actions={
            <>
              <Button onClick={() => void create()} pending={pending} type="button">
                Create card
              </Button>
              <Button disabled={pending} onClick={requestClose} type="button" variant="secondary">
                Cancel
              </Button>
            </>
          }
          answerLabel="What do you want to be able to recall or do?"
          onQuestionChange={(doc) => {
            setQuestionDoc(doc);
            setQuestionInvalid(false);
          }}
          onSuccessCheckChange={(next) => {
            setSuccessCheck(next);
            setSuccessCheckInvalid(false);
          }}
          questionDoc={questionDoc}
          questionInvalid={questionInvalid}
          referenceLabel="Reference"
          successCheck={successCheck}
          successCheckInvalid={successCheckInvalid}
          workspace={
            <>
              <RichContentEditor
                ariaLabel="Answer"
                document={answerDoc}
                onChange={(doc) => {
                  setAnswerDoc(doc);
                  setAnswerInvalid(false);
                }}
                presentation="workspace"
              />
              {answerInvalid ? (
                <p className="text-danger" role="alert">
                  Write what you want to be able to recall or do.
                </p>
              ) : null}
              {review === null && !answerBlank && hint !== null ? (
                hint.status === "error" ? (
                  <p className="text-text-muted" role="status">
                    Whetstone could not check whether this material is already in Notes.{" "}
                    <Button
                      onClick={() => setHintRetry((count) => count + 1)}
                      type="button"
                      variant="ghost"
                    >
                      Retry
                    </Button>
                  </p>
                ) : hint.exact.length > 0 ? (
                  <p className="text-text-muted" role="status">
                    This material is already in Notes. You can still create this card.
                  </p>
                ) : hint.near.length > 0 ? (
                  <p className="text-text-muted" role="status">
                    Similar material may already be in Notes. You can still create this card.
                  </p>
                ) : null
              ) : null}
              {review === null && relatedSurface !== null ? (
                <RelatedMaterialDisclosure answerDoc={answerDoc} key={relatedSurface} />
              ) : null}
            </>
          }
          workspaceBlank={answerBlank}
          workspaceDoc={answerDoc}
        />

        <p className="directCardGuidance text-text-muted">Adds one recurring review.</p>

        {failure !== null ? (
          <p className="text-danger" role="alert">
            {failureMessages[failure]}
          </p>
        ) : null}

        {notice !== null ? (
          <p className="text-danger" role="alert">
            {notice}
          </p>
        ) : null}
      </Sheet>

      {review !== null ? (
        <MaterialReviewPanel
          error={reviewError}
          onBack={backFromReview}
          onKeepSeparate={decideKeepSeparate}
          onUseExisting={decideUseExisting}
          pending={pending}
          review={review}
        />
      ) : null}
    </>
  );
}
