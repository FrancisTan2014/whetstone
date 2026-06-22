# Product brief

## Vision

whetstone is a simple personal reading app for turning source materials into contextual notes.

## v0 scope

1. Admin pages input source reading materials.
2. Reader pages display materials.
3. Users click or tap words/phrases in the reader to create notes linked to the source text.

## v0 material input

- Source materials are entered as clean text units through admin pages.
- For ebooks, v0 does not parse EPUB/PDF files. The admin pastes cleaned chapter or section text into the app.

## v0 reader

- The reader presents material as one continuous vertical scroll.
- Backend storage may organize material into records/chunks/sections, but the frontend should not feel like a file manager.
- Section or chapter boundaries appear as subtle headings inside the scroll.

## v0 note capture

- Users can select any text range in the reader, including a single word or a phrase.
- A note is linked to the selected source text and its material location.

## v0 non-goals

- No spaced repetition.
- No AI grading.
- No daily routine.
- No voice features.
- No sync or cloud hosting.
- No complicated settings.
- No EPUB/PDF/ebook file parsing.

## Current open questions

- What fields define a source material in v0?
- What app stack should v0 use?

## Glossary

- **Source material**: text entered through admin pages and read in the app.
- **Reader**: the page that displays a source material for reading and note capture.
- **Linked note**: a user note attached to selected source text and its material location.
