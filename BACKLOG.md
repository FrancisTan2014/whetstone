# Backlog

The parking lot. Anything that arrives during v1 build and isn't on the [v1 scope list](./docs/01-scope-v1.md) goes here. **No additions to v1 — only to this file.**

Reviewed after v1 ships and is in daily use for ≥ 2 weeks.

## Likely v2

- Cloud sync to user's Azure VM (provisioning, REST API, conflict resolution)
- `OllamaGrader` implementation for desktop-local LLM grading (zero-cost path)
- User-authored categories (admin UI for creating/editing category templates and algorithm bindings)
- Authentication
- Native iOS/Android build via MAUI
- Tags and full-text search
- Backlinks / `[[wikilink]]` parsing
- Push notifications (depends on native build)
- Themes / dark mode
- Rich markdown editor (preview pane, syntax highlighting)
- 6th category if real material doesn't fit existing five (likely "technical reading" — papers, RFCs, man pages)

## Maybe v3 or never

- Voice memo recording for the speak step
- Statistics / progress charts (high risk of becoming vanity — spend log doesn't count, it's functional)
- Sharing notes publicly
- Import from Anki / Obsidian
- Mobile-local LLM (iOS/Android native LLM grading — fragmented platform story)
- Deep-review grading with Opus (opt-in per item) — drafted in methodology but may not survive contact with reality

## Ideas in flight (not committed)

_Add things here as they come up during v1 build. Date-prefix each one._
