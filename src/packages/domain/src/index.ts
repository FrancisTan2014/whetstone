export { toAuthorId } from "./author.js";
export type { AuthorId } from "./author.js";
export { blockTypes } from "./block.js";
export type { BlockType } from "./block.js";
export { blockSimilarity, diffBlocks } from "./blockDiff.js";
export type { BlockDiff, DiffNewBlock, DiffOldBlock } from "./blockDiff.js";
export { diffBlockSequences, isEmptyBlockChangeSet } from "./blockChangeSet.js";
export type { BlockChangeSet, BlockSequenceEntry } from "./blockChangeSet.js";
export { buildDiaryTidyPrompt, diaryTidyInstructions, isFaithfulTidy } from "./diaryTidy.js";
export {
  entryTypeForTimelineKind,
  groupTimelineEntriesByDay,
  isTimelineEntryKind,
  orderTimelineEntries,
  timelineDays,
  timelineEntryKinds,
  timelineKindsAreRealEntries
} from "./timeline.js";
export type { TimelineChronology, TimelineDay, TimelineEntryKind } from "./timeline.js";
export { isDayKey } from "./diaryTimeline.js";
export { isTimeZone, localDayBoundary, localDayKey } from "./localDay.js";
export type { LocalDayBoundary } from "./localDay.js";
export {
  formatNextReviewLabel,
  isShortTermReviewState,
  SHORT_TERM_REVIEW_PREFIX
} from "./nextReview.js";
export type { NextReviewLabelInput } from "./nextReview.js";
export { composeTodayBoard } from "./todayBoard.js";
export type {
  ComposeTodayBoardInput,
  TodayBoard,
  TodayContinueReading,
  TodayContinueWriting,
  TodayInvitationSource,
  TodayRoutineComposition,
  TodayRoutineKind,
  TodayRoutineSource,
  TodayRoutineSummary
} from "./todayBoard.js";
export { blocksToMarkdown, blockToMarkdown } from "./blockMarkdown.js";
export {
  addEntryLink,
  createEntry,
  entryTypes,
  isEntryType,
  replaceEntryLinks,
  toEntryId
} from "./entry.js";
export type { CreateEntryInput, Entry, EntryId, EntryType } from "./entry.js";
export { normalizeEpubMetadata } from "./epubMetadata.js";
export type { NormalizedEpubMetadata, RawEpubCreator, RawEpubMetadata } from "./epubMetadata.js";
export { decomposeHtmlChapter } from "./htmlBlocks.js";
export {
  buildHeadingOutline,
  HEADING_OUTLINE_PREFACE_LABEL,
  HEADING_OUTLINE_UNTITLED_LABEL
} from "./headingOutline.js";
export type { HeadingOutlineEntry, HeadingOutlineUnit } from "./headingOutline.js";
export {
  classifyLexicalRelation,
  classifyWordNetPointer,
  LEXICAL_RELATION_PRIORITY,
  lexicalPosCode,
  lexicalPosFromCode,
  lexicalRelationFacet,
  MAX_NOTES_PER_RELATION,
  normalizeLemmaKey,
  normalizeLexicalSurface,
  parsePointerWordIndices
} from "./lexicalRelations.js";
export type {
  LexicalPartOfSpeech,
  LexicalRelationDirection,
  LexicalRelationFacet,
  LexicalRelationSource,
  LexicalRelationType,
  PointerWordIndices,
  WordNetPointerRelation
} from "./lexicalRelations.js";
export { createEntryLink, isLinkType, linkTypes } from "./links.js";
export type { EntryLink, LinkType } from "./links.js";
export {
  buildMemoryPrompt,
  captureSources,
  isCaptureSource,
  isReadyPrompt,
  memoryPromptFaces,
  memoryPromptOwner,
  promptLifecycles,
  reconcilePromptEdit,
  resolvePromptLifecycle
} from "./memory.js";
export type {
  BuildMemoryPromptInput,
  CaptureSource,
  MemoryNote,
  MemoryPrompt,
  MemoryPromptFaces,
  PromptEditOutcome,
  PromptEditReviewAction,
  PromptLifecycle
} from "./memory.js";
export {
  mergeNotebookDrafts,
  notebookSeparators,
  parseNotebookList,
  splitNotebookDraftContext,
  undoNotebookSplit
} from "./notebookImport.js";
export type { NotebookSeparator, ParsedNotebookDraft } from "./notebookImport.js";
export { blockFromMdastNode, decomposeMarkdown, mdastReadableText } from "./markdownBlocks.js";
export type {
  DecomposedBlock,
  DecomposedFigureImage,
  DecomposedReadingUnit,
  MdastNodeLike
} from "./markdownBlocks.js";
export { createNoteAnchor } from "./noteAnchor.js";
export type { CreateNoteAnchorInput, NoteAnchor } from "./noteAnchor.js";
export { splitSpanIntoBlockRanges } from "./spanMarks.js";
export type { BlockSpanRange, NoteSpan } from "./spanMarks.js";
export { formatProductHeading, productIdentity } from "./productIdentity.js";
export type { ProductIdentity } from "./productIdentity.js";
export {
  applyRating,
  assertRequestedRetention,
  cardStates,
  isDue,
  newReviewState,
  RECALL_REQUEST_RETENTION,
  RECITATION_REQUEST_RETENTION,
  retrievability
} from "./fsrs.js";
export type { CardState, ReviewRating, ReviewState, SchedulerOptions } from "./fsrs.js";
export { createEndpointer, forceEndUtterance, pushFrame } from "./endpointing.js";
export type { EndpointConfig, EndpointEvent, EndpointStep } from "./endpointing.js";
export { sanitizeSvg } from "./svgSanitizer.js";
export { isWorkType, workTypes } from "./work.js";
export { isRecitationPhase, recitationPhases, recitationRatingChoices } from "./recitation.js";
export type { RecitationPhase, RecitationRatingChoice } from "./recitation.js";
export { compareRecitationObligations, selectRecitationWork } from "./recitationSession.js";
export type {
  RecitationAggregateDue,
  RecitationPlanObligation,
  RecitationWorkSelection
} from "./recitationSession.js";
export {
  isWorkLanguage,
  normalizeWorkLanguage,
  resolveWorkLanguage,
  workLanguageLabels,
  workLanguages
} from "./work.js";
export type { WorkLanguage, WorkType } from "./work.js";
export {
  isLibraryCreateOrigin,
  isWorkOrigin,
  libraryCreateOrigins,
  workOrigins
} from "./workOrigin.js";
export type { LibraryCreateOrigin, WorkOrigin } from "./workOrigin.js";
export {
  isAwaitingReviewAttemptState,
  isNonTerminalAttemptState,
  isRetryableAttemptState,
  isTerminalAttemptState,
  mayApplyRunOutput,
  nextRangeIndex,
  pdfImportAttemptStates,
  pdfImportPhases
} from "./pdfImportAttempt.js";
export type { PdfImportAttemptState, PdfImportPhase } from "./pdfImportAttempt.js";
export {
  classifyExtractionConfidence,
  isUnmappedBlockType,
  PDF_EXTRACTION_CONFIDENCE_THRESHOLD,
  suggestsExtractionReview,
  UNMAPPED_BLOCK_TYPE
} from "./pdfExtractionReview.js";
export type { ExtractionConfidenceBand } from "./pdfExtractionReview.js";
export {
  MAX_PDF_HEADING_LEVEL,
  matchOutlineHeading,
  normalizeOutlineTitle,
  stripHeadingNumbering
} from "./pdfOutlineHeadings.js";
export type {
  PdfHeadingCandidate,
  PdfOutlineEntry as PdfOutlineHeadingEntry,
  PdfOutlineHeadingMatch
} from "./pdfOutlineHeadings.js";
export {
  decidePageFurniture,
  isPageFurnitureCandidate,
  normalizePageFurnitureText
} from "./pdfPageFurniture.js";
export type {
  PageFurnitureDecision,
  PageFurnitureExclusionRule,
  PageFurnitureItem
} from "./pdfPageFurniture.js";
export { decidePdfReadingUnits } from "./pdfReadingUnits.js";
export type { PdfReadingUnitHeading, PdfReadingUnitStart } from "./pdfReadingUnits.js";
export {
  assessCorpusEligibility,
  classifyPdfUsability,
  evaluateCorpusCase,
  MAX_AUTOMATIC_LOW_CONFIDENCE_RATIO,
  MAX_AUTOMATIC_UNKNOWN_BLOCK_RATIO,
  PDF_USABILITY_GATE_RATIO,
  summarizeCorpus
} from "./pdfUsability.js";
export type {
  ClassifiableObservation,
  CorpusBounds,
  CorpusCaseInput,
  CorpusCaseResult,
  CorpusEligibility,
  CorpusExclusionReason,
  CorpusReport,
  LatencySummary,
  MappedWorkSummary,
  PdfCaseMetrics,
  PdfCorpusFileFacts,
  PdfImportObservation,
  PdfUsabilityClass,
  PdfUsabilityReason,
  PdfUsabilityVerdict
} from "./pdfUsability.js";
export { buildSearchSnippet, SEARCH_SNIPPET_MAX_CODE_POINTS } from "./searchSnippet.js";
export type { BuildSearchSnippetInput, SearchSnippet } from "./searchSnippet.js";
export {
  classifyOcrRouting,
  OCR_GEOMETRY_TOLERANCE_PT,
  ocrPassRequired,
  ocrTesseractLanguage,
  requiredTesseractTraineddata,
  resolveOcrLanguage,
  validateNativeTextPreserved,
  validateOcrGeometry
} from "./pdfOcr.js";
export type {
  NativeTextValidation,
  OcrGeometryValidation,
  OcrPageClassification,
  OcrPageGeometry,
  OcrRoutingDecision,
  OcrRoutingKind
} from "./pdfOcr.js";
export {
  canBeginFinalize,
  canCancelWorkCreationAttempt,
  canCompleteFinalize,
  canTransferStage,
  fingerprintReviewedCandidates,
  isActiveWorkCreationAttemptState,
  isTerminalWorkCreationAttemptState,
  ownsOrdinaryUploadStage,
  workCreationAttemptStates,
  workCreationSourceKinds
} from "./workCreationAttempt.js";
export type {
  ReviewedCandidateSnapshot,
  ReviewedCandidateSnapshotEntry,
  WorkCreationAttemptState,
  WorkCreationSourceKind
} from "./workCreationAttempt.js";
export { planSectionRepartition, planWorkContentReplacement } from "./workRepartition.js";
export type {
  PlannedUnit,
  RepartitionBlock,
  RepartitionInput,
  RepartitionPlan,
  RepartitionUnit,
  WorkContentReplacementInput
} from "./workRepartition.js";
export {
  candidateTitleKeyLengthBounds,
  DIFFERENT_AUTHOR_TITLE_SIMILARITY_THRESHOLD,
  MAX_WORK_DUPLICATE_CANDIDATES,
  SAME_AUTHOR_TITLE_SIMILARITY_THRESHOLD,
  selectWorkDuplicateCandidates,
  titleKeySimilarity
} from "./workDuplicateCandidates.js";
export type {
  DuplicateCandidateEvidence,
  ExistingWorkCandidate,
  ProposedWorkMetadata,
  WorkDuplicateCandidate,
  WorkDuplicateCandidateResult,
  WorkDuplicateMatchTier
} from "./workDuplicateCandidates.js";
