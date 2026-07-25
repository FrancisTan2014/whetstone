export {
  documentExtensions,
  documentMarkNames,
  documentMarks,
  documentNodeNames,
  documentNodes,
  uniqueIdExtension
} from "./nodes.js";
export { isSafeDocumentLinkHref } from "./linkSafety.js";
export { BlankNoteMaterialError, projectNoteMaterial } from "./noteMaterial.js";
export { projectNearMatch, projectNearMatchKey } from "./nearMatch.js";
export type { NearMatchKey, NearMatchProjection, ProtectedEvidence } from "./nearMatch.js";
export {
  codePointLength,
  damerauLevenshteinCodePoints,
  nearMatchLengthBand,
  nearMatchScore
} from "./nearMatchScore.js";
export { NEAR_MATCH_THRESHOLD, selectNearMatches } from "./nearMatchRanking.js";
export type { NearMatchCandidate, NearMatchPoolEntry } from "./nearMatchRanking.js";
export { documentSchema } from "./schema.js";
export {
  assignNodeIds,
  createTextDocument,
  documentBlockHeading,
  documentReadableText,
  documentText,
  DocumentValidationError,
  isValidDocument,
  parseDocument,
  serializeDocument
} from "./document.js";
export type { DocumentBlockHeading, DocumentMarkJSON, DocumentNodeJSON } from "./document.js";
