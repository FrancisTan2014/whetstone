import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { PdfExtractionEvidenceItemDto } from "@whetstone/contracts";

import { extractionEvidenceCueClass } from "./extractionEvidence.tokens.js";

// The extraction-evidence cue (#763). A pure decoration extension shared by every mount of the editor:
// it holds the current Work's per-block evidence, keyed by the stable node id, and paints a node
// decoration — carrying the semantic-warning inset class — over exactly the top-level blocks the extractor
// was least sure about AND that have not yet been corrected. It never edits the document, so it costs
// nothing at rest and leaves the reader untouched (the reader mounts the shared document extensions without
// this editing-only one). It is inert until a consumer sets a non-empty evidence map, so the manual editor,
// notes, and any non-PDF surface that mounts it show nothing.

// The per-block evidence the editor decorates by node id. A block absent from the map has no evidence.
export type ExtractionEvidenceMap = ReadonlyMap<string, PdfExtractionEvidenceItemDto>;

interface EvidenceState {
  readonly evidence: ExtractionEvidenceMap;
}

export const extractionEvidenceKey = new PluginKey<EvidenceState>("extractionEvidence");

// Meta payload dispatched to replace the evidence map wholesale (the consumer refetches after a save).
interface EvidenceMeta {
  readonly evidence: ExtractionEvidenceMap;
}

function readMeta(value: unknown): EvidenceMeta | undefined {
  if (value !== null && typeof value === "object" && "evidence" in value) {
    const { evidence } = value as { evidence: unknown };
    if (evidence instanceof Map) {
      return { evidence: evidence as ExtractionEvidenceMap };
    }
  }

  return undefined;
}

// A block is cued when its evidence suggests review AND it has not been corrected. A corrected block keeps
// its evidence (and its disclosure) but loses the cue, so the warning marks only outstanding work.
function isCued(evidence: PdfExtractionEvidenceItemDto | undefined): boolean {
  return evidence !== undefined && evidence.reviewSuggested && !evidence.corrected;
}

export const ExtractionEvidenceDecoration = Extension.create({
  addProseMirrorPlugins() {
    return [
      new Plugin<EvidenceState>({
        key: extractionEvidenceKey,
        props: {
          decorations: (state) => {
            // state.init always seeds an empty map, so getState is defined whenever decorations runs; the
            // fallback only guards a getState-before-init that ProseMirror never triggers.
            /* v8 ignore next */
            const { evidence } = extractionEvidenceKey.getState(state) ?? { evidence: new Map() };

            if (evidence.size === 0) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id: unknown = node.attrs.id;
              if (typeof id === "string" && isCued(evidence.get(id))) {
                decorations.push(
                  Decoration.node(offset, offset + node.nodeSize, {
                    class: extractionEvidenceCueClass
                  })
                );
              }
            });

            return DecorationSet.create(state.doc, decorations);
          }
        },
        state: {
          apply: (tr, current) => {
            const meta = readMeta(tr.getMeta(extractionEvidenceKey));
            return meta === undefined ? current : { evidence: meta.evidence };
          },
          init: () => ({ evidence: new Map() })
        }
      })
    ];
  },
  name: "extractionEvidence"
});

// Replace the editor's extraction evidence. A no-op transaction that only carries plugin meta, so it never
// enters the undo history or emits a document change; the decorations recompute from the new map.
export function setExtractionEvidence(editor: Editor, evidence: ExtractionEvidenceMap): void {
  const { tr } = editor.state;
  editor.view.dispatch(tr.setMeta(extractionEvidenceKey, { evidence }));
}
