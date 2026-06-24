import { motion } from "framer-motion";

import type { NoteTemplateDto } from "@whetstone/contracts";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion.js";
import { templateSwatchClass } from "./templateHue.js";

export type SelectionToolbarProps = Readonly<{
  anchorRect?: DOMRect | undefined;
  onClose: () => void;
  onConfirm: () => void;
  onLookup: () => void;
  onSelectTemplate: (templateId: string) => void;
  prefersReducedMotion: boolean;
  selectedTemplateId: string;
  templates: ReadonlyArray<NoteTemplateDto>;
}>;

// A floating toolbar anchored to the current selection. It surfaces the size-preselected
// template and a quick switch among the hued templates, a "Look up" action that opens the
// view-only definition panel, then a confirm that opens the note editor. Positioned from a
// rect captured off the selection Range; springs in and honors reduced motion.
export function SelectionToolbar({
  anchorRect,
  onClose,
  onConfirm,
  onLookup,
  onSelectTemplate,
  prefersReducedMotion,
  selectedTemplateId,
  templates
}: SelectionToolbarProps): React.JSX.Element {
  const positioned =
    anchorRect === undefined ? {} : { style: { left: anchorRect.left, top: anchorRect.bottom } };

  return (
    <motion.div
      animate={{ opacity: 1, scale: 1 }}
      aria-label="Annotate selection"
      className="selectionToolbar"
      initial={{ opacity: 0, scale: 0.96 }}
      role="toolbar"
      transition={withReducedMotion(motionSprings.snappy, prefersReducedMotion)}
      {...positioned}
    >
      <div aria-label="Template" className="selectionToolbarTemplates" role="group">
        {templates.map((template) => (
          <button
            aria-label={template.name}
            aria-pressed={template.id === selectedTemplateId}
            className={`selectionToolbarTemplate ${templateSwatchClass(template.id)}`}
            key={template.id}
            onClick={() => onSelectTemplate(template.id)}
            type="button"
          >
            {template.name}
          </button>
        ))}
      </div>
      <button className="selectionToolbarConfirm" onClick={onConfirm} type="button">
        Add note
      </button>
      <button className="selectionToolbarLookup" onClick={onLookup} type="button">
        Look up
      </button>
      <button
        aria-label="Dismiss"
        className="selectionToolbarDismiss"
        onClick={onClose}
        type="button"
      >
        ✕
      </button>
    </motion.div>
  );
}
