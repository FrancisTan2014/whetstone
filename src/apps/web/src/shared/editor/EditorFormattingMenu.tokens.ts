// Presentational class names for the contextual formatting toolbar and its link form, isolated from
// behavior so the component tests assert semantics (roles, pressed/disabled state, link validation)
// rather than styling. Excluded from coverage.
export const formattingMenuClassNames = {
  action: "min-w-11",
  linkActions: "editorLinkFormActions",
  linkError: "editorLinkFormError",
  linkField: "editorLinkFormField",
  linkForm: "editorLinkForm",
  linkInput: "editorLinkFormInput min-h-11",
  toolbar: "editorFormattingMenu"
} as const;
