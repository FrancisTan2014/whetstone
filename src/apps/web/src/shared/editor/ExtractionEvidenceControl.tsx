import { ScanSearch } from "lucide-react";
import { useId, useState } from "react";

import { classifyExtractionConfidence } from "@whetstone/domain";
import type { PdfExtractionEvidenceItemDto } from "@whetstone/contracts";

import { Button } from "../ui/Button.js";
import {
  extractionConfidenceBandLabels,
  extractionEvidenceClassNames,
  extractionEvidenceCopy
} from "./extractionEvidence.tokens.js";

// The "Review extraction" disclosure (#763). A keyboard-operable control the shared editor renders when the
// caret sits inside a block that carries a review-suggested extraction evidence row. It is guidance, never
// content: expanding it reveals the SAFE source facts — page, original structure label, confidence band,
// and OCR provenance when present — so an administrator can judge a low-confidence or unmapped block
// without a PDF viewer. It never renders coordinates, a page image, editable fields, or a raw confidence
// percentage. A corrected block keeps this disclosure (reframed) but its cue is gone. The button inherits
// the shared Button's 44px target and visible focus ring, so it is reachable by keyboard and touch.

function EvidenceRow({
  term,
  value
}: Readonly<{ term: string; value: string }>): React.JSX.Element {
  return (
    <div>
      <dt className={extractionEvidenceClassNames.term}>{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ExtractionEvidenceControl({
  evidence
}: Readonly<{ evidence: PdfExtractionEvidenceItemDto }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const band = classifyExtractionConfidence(evidence.confidence);

  return (
    <div className={extractionEvidenceClassNames.root}>
      <Button
        aria-controls={panelId}
        aria-expanded={open}
        className={extractionEvidenceClassNames.trigger}
        onClick={() => setOpen((previous) => !previous)}
        size="sm"
        variant="secondary"
      >
        <ScanSearch aria-hidden height={18} strokeWidth={1.75} width={18} />
        {extractionEvidenceCopy.triggerLabel}
      </Button>
      {open ? (
        <div className={extractionEvidenceClassNames.panel} id={panelId} role="group">
          <p>
            {evidence.corrected
              ? extractionEvidenceCopy.correctedHeading
              : extractionEvidenceCopy.heading}
          </p>
          <dl>
            <EvidenceRow
              term={extractionEvidenceCopy.pageTerm}
              value={String(evidence.page)}
            />
            <EvidenceRow term={extractionEvidenceCopy.labelTerm} value={evidence.label} />
            <EvidenceRow
              term={extractionEvidenceCopy.confidenceTerm}
              value={extractionConfidenceBandLabels[band]}
            />
            {evidence.ocrEngine !== null ? (
              <EvidenceRow
                term={extractionEvidenceCopy.ocrEngineTerm}
                value={evidence.ocrEngine}
              />
            ) : null}
            {evidence.ocrLanguage !== null ? (
              <EvidenceRow
                term={extractionEvidenceCopy.ocrLanguageTerm}
                value={evidence.ocrLanguage}
              />
            ) : null}
          </dl>
        </div>
      ) : null}
    </div>
  );
}
