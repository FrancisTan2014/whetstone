// The empty-content copy shown when a Markdown source produces no readable blocks (the server's 422
// `empty_content`) — e.g. an image-only file or paste; v0 has no image block, so there is nothing to
// add. Single source of truth so the Manage-content panel and the Library upload flow surface the
// identical message and cannot drift (#673).
export const markdownEmptyContentMessage =
  "This Markdown has no readable text to add. Images on their own aren’t supported yet.";
