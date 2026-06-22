# Product brief

## Vision

whetstone is a simple personal reading app for turning source materials into contextual notes.

## v0 scope

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases in the reader to create notes linked to the source text.

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
- Markdown files are the source of truth for content. The database stores metadata and indexes.

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

## Future direction protected by v0

- The Entry/link model should support future rich connections between materials, notes, concepts, and review items.
- Language-learning durability and memorization algorithms are expected future features, but not v0 behavior.

## v0 non-goals

- No spaced repetition.
- No memorization scheduling algorithm.
- No AI grading.
- No daily routine.
- No voice features.
- No sync or cloud hosting.
- No complicated settings.
- No EPUB/PDF/ebook file parsing.

## Current open questions

- What app stack should v0 use?

## Glossary

- **Source material**: text entered through admin pages and read in the app.
- **Reader**: the page that displays a source material for reading and note capture.
- **Linked note**: a user note attached to selected source text and its material location.
