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
export { judgementToGrade, productionCategories } from "./coachGrade.js";
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
export { buildDiaryTidyPrompt, diaryTidyInstructions } from "./diaryTidy.js";
export {
  groupByDayDesc,
  isDayKey,
  monthBounds,
  monthGrid,
  shiftMonth,
  toDayKey,
  toMonthKey
} from "./diaryTimeline.js";
export type { DatedEntry, DayGroup } from "./diaryTimeline.js";
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
export { blockFromMdastNode, decomposeMarkdown } from "./markdownBlocks.js";
export type {
  DecomposedBlock,
  DecomposedFigureImage,
  DecomposedReadingUnit
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
export { gradeFromRating, newReviewState, scheduleReview } from "./sm2.js";
export type { ReviewGrade, ReviewRating, ReviewState } from "./sm2.js";
export { sanitizeSvg } from "./svgSanitizer.js";
export { isWorkType, workTypes } from "./work.js";
export {
  isWorkLanguage,
  normalizeWorkLanguage,
  workLanguageLabels,
  workLanguages
} from "./work.js";
export type { WorkLanguage, WorkType } from "./work.js";
