import type { ExtractionConfidenceBand } from "@whetstone/domain";

// Presentational tokens and fixed copy for the extraction-evidence cue and disclosure (#763). Kept out of
// the decoration/component so their tests assert behavior (which block is cued, the disclosure's semantics
// and keyboard operation) rather than styling or exact wording, and the visual treatment lives in
// theme.css. Excluded from coverage.

// The class the cue decoration carries: a 2px semantic-warning inset on an uncorrected suggested block.
export const extractionEvidenceCueClass = "is-extraction-review";

export const extractionEvidenceClassNames = {
  panel: "richContentEditorEvidencePanel",
  root: "richContentEditorEvidence",
  term: "richContentEditorEvidenceTerm",
  trigger: "richContentEditorEvidenceTrigger"
} as const;

// The confidence band each classified value reads as in the disclosure. Never a raw percentage: a null
// confidence is honestly "Not reported" rather than a fabricated number.
export const extractionConfidenceBandLabels: Record<ExtractionConfidenceBand, string> = {
  high: "High",
  "not-reported": "Not reported",
  "review-suggested": "Review suggested"
};

export const extractionEvidenceCopy = {
  confidenceTerm: "Confidence",
  correctedHeading: "Corrected — original extraction evidence",
  heading: "Extraction evidence",
  labelTerm: "Structure label",
  ocrEngineTerm: "OCR engine",
  ocrLanguageTerm: "OCR language",
  pageTerm: "Page",
  triggerLabel: "Review extraction"
} as const;
