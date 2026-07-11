export { toAuthorId } from "./author.js";
export type { AuthorId } from "./author.js";
export { blockTypes } from "./block.js";
export type { BlockType } from "./block.js";
export { blockSimilarity, diffBlocks } from "./blockDiff.js";
export type { BlockDiff, DiffNewBlock, DiffOldBlock } from "./blockDiff.js";
export { caseCorpus, getCorpusDomain } from "./caseCorpus.js";
export type { CorpusCase, CorpusChunk, CorpusDomain } from "./caseCorpus.js";
export { chunkMasteryStatus, chunkMasteryStatuses, summarizeCaseMastery } from "./caseMastery.js";
export type { CaseMasterySummary, ChunkMasteryStatus } from "./caseMastery.js";
export { judgementToRating, productionCategories } from "./coachGrade.js";
export type { ProductionCategory } from "./coachGrade.js";
export { coachIntensities, coachPaces, coachRegisters, deriveCoachKnobs } from "./coachKnobs.js";
export type {
  CoachIntensity,
  CoachKnobs,
  CoachPace,
  CoachRegister,
  LearnerSnapshot
} from "./coachKnobs.js";
export { englishShare, l1Languages, MAX_L1_SHARE, targetL1Share } from "./languageMix.js";
export type { L1Language } from "./languageMix.js";
export {
  createEndpointer,
  forceEndUtterance,
  isCapturingUtterance,
  pushFrame
} from "./endpointing.js";
export type {
  EndpointConfig,
  EndpointEvent,
  EndpointerState,
  EndpointStep,
  SpeechAbortedEvent,
  SpeechCandidateEvent,
  UtteranceEndEvent,
  UtteranceStartEvent
} from "./endpointing.js";
export {
  createTurnTaking,
  finishTurn,
  isListening,
  observeFrame,
  setCoachPlaying
} from "./turnTaking.js";
export type { TurnEffect, TurnStep, TurnTakingState } from "./turnTaking.js";
export { deriveSpeechTiming } from "./speechTiming.js";
export type { SpeechTiming, WordBoundary } from "./speechTiming.js";
export {
  chunkGap,
  deriveLevel,
  errorCategories,
  proficiencyLevels,
  rankChunksByGapFrequency
} from "./learnerModel.js";
export type {
  ChunkCandidate,
  ErrorCategory,
  ProficiencyLevel,
  RankedChunk
} from "./learnerModel.js";
export { rankReadingNudges, recencyBoost, topReadingNudge } from "./readingNudge.js";
export type { ReadingNudgeCandidate, RankedReadingNudge } from "./readingNudge.js";
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
export {
  isDayKey,
  monthBounds,
  monthGrid,
  shiftMonth,
  toDayKey,
  toMonthKey
} from "./diaryTimeline.js";
export { caseLightLevel, caseLightLevels } from "./progressMap.js";
export type { CaseLightLevel } from "./progressMap.js";
export { mistakeCategoryFromIssues } from "./mistakeCategory.js";
export type { ProductionIssueLike } from "./mistakeCategory.js";
export { summarizeSessionTurns } from "./sessionSummary.js";
export type { SessionErrorCount, SessionSummary, SessionTurn } from "./sessionSummary.js";
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
export { createEntryLink, isLinkType, linkTypes } from "./links.js";
export type { EntryLink, LinkType } from "./links.js";
export {
  buildMemoryPrompt,
  captureSources,
  isCaptureSource,
  isSchedulablePrompt,
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
export { blockFromMdastNode, decomposeMarkdown, mdastReadableText } from "./markdownBlocks.js";
export type {
  DecomposedBlock,
  DecomposedFigureImage,
  DecomposedReadingUnit,
  MdastNodeLike
} from "./markdownBlocks.js";
export { renderNoteMarkdown, validateNoteAnswers } from "./noteAnswers.js";
export type { NoteAnswers, NoteAnswerValidation } from "./noteAnswers.js";
export { createNoteAnchor } from "./noteAnchor.js";
export type { CreateNoteAnchorInput, NoteAnchor } from "./noteAnchor.js";
export { splitSpanIntoBlockRanges } from "./spanMarks.js";
export type { BlockSpanRange, NoteSpan } from "./spanMarks.js";
export {
  getNoteTemplate,
  isNoteFieldType,
  noteFieldTypes,
  noteTemplates,
  preselectTemplateId
} from "./noteTemplate.js";
export type { NoteFieldType, NoteTemplate, NoteTemplateField } from "./noteTemplate.js";
export { formatProductHeading, productIdentity } from "./productIdentity.js";
export type { ProductIdentity } from "./productIdentity.js";
export {
  applyRating,
  cardStates,
  isDue,
  newReviewState,
  RECALL_REQUEST_RETENTION,
  retrievability
} from "./fsrs.js";
export type { CardState, ReviewRating, ReviewState, SchedulerOptions } from "./fsrs.js";
export { sanitizeSvg } from "./svgSanitizer.js";
export { isWorkType, workTypes } from "./work.js";
export { isRecitationPhase, recitationPhases } from "./recitation.js";
export type { RecitationPhase } from "./recitation.js";
export {
  coveredPassageText,
  isRecitationCueStrength,
  mergePassageRanges,
  OPENING_CUE_CHARS,
  passageAnchorStatuses,
  passageCueText,
  PRECEDING_LINE_MAX_CHARS,
  reanchorPassageRange,
  recitationCueStrengths,
  recitationRatingChoices,
  seedPassageRanges,
  splitPassageRange
} from "./recitationPassage.js";
export type {
  AnchoredPassage,
  MergePassagesResult,
  PassageAnchorStatus,
  PassageBlock,
  PassageRange,
  ReanchorOutcome,
  RecitationCueStrength,
  SplitInvalidReason,
  SplitPassageResult
} from "./recitationPassage.js";
export {
  DEFAULT_RECITATION_SUPPORT_LEVEL,
  isRecitationSupportLevel,
  projectRecitationSupport,
  recitationSupportLevels,
  supportLevelShowsTarget
} from "./recitationFading.js";
export type {
  RecitationSupportLevel,
  RecitationVisibleSupportLevel,
  SupportLine,
  SupportProjection,
  SupportSegment
} from "./recitationFading.js";
export {
  chainEligibility,
  computeOwnedPrefix,
  isOutcomePassageInSession,
  isPassageOwned,
  isWholeWorkOwned,
  MIN_CHAIN_LENGTH,
  OWNERSHIP_MIN_SUCCESSFUL_REVIEWS,
  OWNERSHIP_RETENTION_TARGET,
  passagesToFailFromOutcome,
  recitationTodayActions,
  resolveChainBoundary,
  selectRecitationTodayAction
} from "./recitationChaining.js";
export type {
  ChainBoundaryInvalidReason,
  ChainBoundaryResult,
  ChainEligibility,
  OwnedPrefix,
  PassageMastery,
  RecitationTodayAction,
  SessionRecallOutcome
} from "./recitationChaining.js";
export {
  isWorkLanguage,
  normalizeWorkLanguage,
  workLanguageLabels,
  workLanguages
} from "./work.js";
export type { WorkLanguage, WorkType } from "./work.js";
