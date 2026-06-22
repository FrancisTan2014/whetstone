# Product brief

## Vision

whetstone is a simple personal reading app for turning source materials into contextual notes.

## v0 scope

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases in the reader to create notes linked to the source text.

## v0 stack direction

- Use a web-core TypeScript stack to maximize OSS leverage for text rendering, selection, annotation, Markdown editing, and future rich connections.
- Browser target: PWA.
- Mobile target: Capacitor wrapper around the web app for iOS and Android.
- Desktop target: Tauri wrapper around the web app.
- v0 is server-centered: thin clients talk to one server/data center.
- The server is the source of truth for Markdown files, metadata, indexes, templates, notes, and future memorization state.
- Client storage is not the v0 source of truth. IndexedDB may be used later as a cache, not as primary storage.
- Backend stack: Node.js TypeScript + Fastify + PostgreSQL.
- Markdown source files live on the server filesystem under a data directory. PostgreSQL stores metadata, paths, indexes, templates, notes, and links.

## v0 content model

- The durable domain object is `Entry`.
- Materials, reading units, and notes are all entries.
- Relationships between entries are represented by typed links.
- v0 link types are `contains`, `annotates`, `references`, and `related_to`.
- Source content is organized as `Author/Source -> Work -> ReadingUnit`.
- `Author/Source` is a relational entity selected from an existing list or created inline if not found.
- `Work` represents a readable work such as a book, essay, blog post, or classical text.
- `Work` has a v0 type: `book`, `essay`, `blog_post`, or `classical_text`.
- `Work` has a language field inherited by its reading units.
- `ReadingUnit` is an ordered unit within a work. Each reading unit is backed by one Markdown file.
- For single-piece works such as an essay or blog post, the work may have one reading unit.
- For books or classics, the work has many ordered reading units such as chapters, sections, or passages.
- For ebooks, v0 does not parse EPUB/PDF files. The admin pastes cleaned chapter or section text into reading units.
- Server-side Markdown files are the source of truth for content. The server database stores metadata and indexes.

Examples:

- Charles Dickens -> A Tale of Two Cities -> chapters.
- George Orwell -> Politics and the English Language -> one essay unit.
- Paul Graham -> one blog post work -> one blog-post unit.
- 司马迁 -> 史记 -> ordered chapters/passages.

## v0 reader

- The reader presents material as one continuous vertical scroll.
- Backend storage may organize material into records/chunks/sections, but the frontend should not feel like a file manager.
- Section or chapter boundaries appear as subtle headings inside the scroll.

## v0 note capture

- Users can select any text range in the reader, including a single word or a phrase.
- A note is an entry linked to the selected source entry and source location.
- Selecting text opens the note editor as a side panel on desktop-width screens and as a bottom sheet on narrow screens.
- A v0 note entry contains the selected text snapshot, selected template, and user-authored Markdown note body.
- A note anchor stores the reading-unit entry id, start/end offsets, selected text snapshot, and containing paragraph/context snapshot.
- Vocabulary notes are manual in v0; users write definitions, translations, or memory hints in the Markdown note body.

## v0 note templates

The note editor uses structured templates. After text selection, the editor shows a template selector. It may preselect a likely template, but the user can switch before saving.

Templates are database-backed from v0. Built-in templates are seeded into the database; v0 does not include an admin template editor.

Template storage:

- Template rows store ordered `fields_json`.
- Note entries store structured `answers_json` keyed by template field id.
- Markdown note body is rendered from the template and answers for display/export.
- The template JSON uses a small controlled shape, not arbitrary UI code, so future admin editing can add/remove fields safely.
- v0 template field types are only `short_text` and `long_text`.

Initial templates:

1. **Vocabulary**
   - Meaning in this context.
   - My explanation or translation.
   - Memory hook.
   - Example I might use.
2. **Expression / phrase**
   - What the phrase is doing.
   - Why it sounds useful.
   - My imitation sentence.
3. **Thought / question**
   - What I noticed.
   - Why it matters.
   - Question or connection.

Preselection rule:

- Single word -> Vocabulary.
- Short phrase -> Expression / phrase.
- Longer selection -> Thought / question.

## Future direction protected by v0

- The Entry/link model should support future rich connections between materials, notes, concepts, and review items.
- Language-learning durability and memorization algorithms are expected future features, but not v0 behavior.
- LLM-assisted vocabulary note drafting may use selected text plus context snapshot later, but is not v0 behavior.

## v0 non-goals

- No spaced repetition.
- No memorization scheduling algorithm.
- No AI grading.
- No LLM vocabulary note drafting.
- No daily routine.
- No voice features.
- No complicated settings.
- No EPUB/PDF/ebook file parsing.

## Glossary

- **Source material**: text entered through admin pages and read in the app.
- **Reader**: the page that displays a source material for reading and note capture.
- **Linked note**: a user note attached to selected source text and its material location.
