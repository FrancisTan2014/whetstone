# v1 scope — locked 2026-06-08, methodology pivot 2026-06-08, pause added 2026-06-08

The minimum that runs the full loop end-to-end on Windows. Ships before any other feature.

> **Updates:** scope amended after [ADR 0003](./decisions/0003-learning-methodology.md) (categories + per-category algorithms + LLM grading) and [ADR 0004](./decisions/0004-pause-mechanism.md) (pause mechanism).

## In v1

1. **Today screen** — shows the day's routine: recall items (capped at 15, interleaved across categories), new-encounter slots per active category, the daily ritual checkbox.
2. **Recall an item** — app shows the template prompts; user writes a free-form recalled answer; LLM grades against original (Forgot / Partial / Solid / Stronger); category's algorithm advances the item's next-surface date. Self-grade fallback when budget exhausted.
3. **Create a new encounter** — pick category, pick template (default per category), fill template, save. Note enters its category's recall queue.
4. **View / edit a note** — open from Today screen, see body, edit body, save.
5. **Five default categories shipped**: literary narrative, recitation, vocabulary, concept/mechanism, reflection. Defined in code; admin UI for user-authored categories deferred.
6. **`AnthropicGrader` + `SelfGrader`** implementations of `IGrader`. Anthropic API key configured in settings.
7. **Cost controls**: daily budget cap (default $0.25), per-request token cap (2,000 input), visible spend log in settings.
8. **Pause** — category-level and app-level pause, with date-shifting on resume. See [ADR 0004](./decisions/0004-pause-mechanism.md).
9. **Export everything** — Settings → "Download all notes as `.zip`". Files are real `.md` with frontmatter, one file per note. Spend log exported as CSV.
10. **Local SQLite storage** behind an `INoteStore` interface. No auth. Single user.

## Out of v1

| Feature | Deferred to | Why out |
|---|---|---|
| Cloud sync / Azure VM | v2 | Export = manual sync for now; eliminates provisioning as a v1 blocker |
| Local LLM (Ollama) grading | v1.5/v2 | `IGrader` abstraction present; `OllamaGrader` implementation deferred |
| User-authored categories (admin UI) | v2 | Five defaults cover all stated subjects |
| Auth / multi-user | maybe never | Personal app, single device |
| Rich markdown editor | v2 if needed | Plain textarea works |
| Native iOS/Android build | v2 | Windows + WebAssembly proves the stack first |
| Tags / search | v2 | Category grouping is enough at <100 notes |
| Backlinks / `[[wikilinks]]` | v2 | "Connect" step is a manual "Related" section in the note body |
| Voice memo recording | v3 | Written recall is the speak step in v1 |
| Statistics / progress charts | never unless asked | Vanity feature; the routine is the feedback (spend log is functional, not vanity) |
| Push notifications | v2 (with native build) | Open the app daily; that's the discipline |
| Themes / dark mode | v2 | MAUI Blazor defaults are fine |

## Discipline rule for building

If during construction an idea arrives — *"oh, I should also add X"* — it goes in [`../BACKLOG.md`](../BACKLOG.md), not into v1. **Nothing** gets added to v1 after this lock.

The point of v1 is to **run the loop daily** so we discover what actually matters by using it, not by guessing.
