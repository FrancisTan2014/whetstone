import type { ManualEditorSaveStatus } from "./ManualWorkEditorPage.js";

// Presentational maps for the manual-Work editor's save indicator (#720): pure enum->label/tone lookups
// with no logic, kept out of coverage per the *.tokens.ts convention. The learner always sees whether
// their edits are saved, in flight, unsaved, conflicted, or failed.
export const manualEditorSaveStatusLabels: Readonly<Record<ManualEditorSaveStatus, string>> = {
  conflict: "This work changed elsewhere — save again to overwrite it",
  error: "Save failed — your edits are kept; try again",
  idle: "Saved",
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  "validation-error": "This content can’t be saved — your edits are kept; adjust and try again"
};

// The status line stays visually quiet except when a save failed, was invalid, or hit a conflict, which
// are surfaced in an alert tone so the learner notices before leaving the page.
export const manualEditorSaveStatusClassNames: Readonly<Record<ManualEditorSaveStatus, string>> = {
  conflict: "text-danger",
  error: "text-danger",
  idle: "text-text-muted",
  saved: "text-text-muted",
  saving: "text-text-muted",
  unsaved: "text-text-muted",
  "validation-error": "text-danger"
};
