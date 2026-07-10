import type { AutosaveStatus } from "./useAutosave.js";

// Presentational maps for the authored-Work editor's autosave indicator (#576): pure enum->label/class
// lookups with no logic, kept out of coverage per the *.tokens.ts convention.
export const autosaveStatusLabels: Readonly<Record<AutosaveStatus, string>> = {
  error: "Save failed — your edits are kept and will retry",
  idle: "Saved",
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes…"
};

// The status line stays visually quiet except when a save has failed, which is surfaced in an alert tone.
export const autosaveStatusClassNames: Readonly<Record<AutosaveStatus, string>> = {
  error: "text-danger",
  idle: "text-text-muted",
  saved: "text-text-muted",
  saving: "text-text-muted",
  unsaved: "text-text-muted"
};
