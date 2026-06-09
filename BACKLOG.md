# Backlog

The parking lot. Anything that arrives during v1 build and isn't on the [v1 scope list](./STABLE.md#scope-v1) goes here. **No additions to v1 — only to this file.**

Reviewed after v1 ships and is in daily use for ≥ 2 weeks.

## Likely v2

- Cloud sync to user's Azure VM (provisioning, REST API, conflict resolution)
- `OllamaGrader` implementation for desktop-local LLM grading (zero-cost path)
- User-authored categories and materials (admin UI for creating/editing category templates, algorithm bindings, and curated material lists)
- Authentication (only if multi-device sync demands it)
- Native iOS/Android build via MAUI (the architecture supports it from day one; v1 ships desktop)
- **Pronunciation-quality scoring** for English (wav2vec2 + Montreal Forced Aligner OSS stack; per-phoneme confidence + stress detection). Tied to ADR 0006.
- **TTS** for recitation reference (Coqui TTS or similar OSS; user can hear the original alongside their own recording).
- **Chinese pronunciation feedback** for recitation (research-thin area; may stay character-match-only for several versions).
- Tags and full-text search
- Backlinks / `[[wikilink]]` parsing
- Push notifications (depends on native build)
- Themes / dark mode
- Rich markdown editor (preview pane, syntax highlighting)
- 6th category if real material doesn't fit existing five (likely "technical reading" — papers, RFCs, man pages, distinct from concept/mechanism)
- Streaming / real-time audio transcription
- TTS-assisted prose-modeling (hear the Orwell sentence in a natural English voice before modeling it)

## Maybe v3 or never

- Statistics / progress charts (high risk of becoming vanity — spend log doesn't count, it's functional)
- Sharing notes publicly
- Import from Anki / Obsidian
- Mobile-local LLM (iOS/Android native LLM grading — fragmented platform story; Whisper is the only model bundled in v1)
- Deep-review grading with Opus (opt-in per item) — drafted in methodology but may not survive contact with reality
- Literary-quality recitation feedback in Chinese (节奏, 情感, breath) — likely never via OSS; requires either commercial APIs or fine-tuned models that don't exist yet
- Real-time conversation practice in English (speak-and-respond loop) — different product

## Ideas in flight (not committed)

_Add things here as they come up during v1 build. Date-prefix each one._
