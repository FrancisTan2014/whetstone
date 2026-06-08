# v1 scope — locked 2026-06-08

The minimum that runs the full loop end-to-end on Windows. Ships before any other feature.

## In v1

1. **Today screen** — shows the day's routine: recall cards (capped at 15), new-input slots per active subject, the 《笠翁对韵》 ritual checkbox.
2. **Grade a recall card** — three buttons (Again / Good / Easy), updates SM-2 state, advances `next_review`.
3. **Create a new note** — form: id, topic/subject, body (plain markdown textarea). Saved with SRS defaults (`interval=1, ease=2.5, next_review=tomorrow`).
4. **View / edit a note** — open from Today screen, see body, edit body, save.
5. **Export everything** — Settings → "Download all notes as `.zip`". Files are real `.md` with frontmatter, one file per note.
6. **Local SQLite storage** behind an `INoteStore` interface. No auth. Single user.

## Out of v1

| Feature | Deferred to | Why out |
|---|---|---|
| Cloud sync / Azure VM | v2 | Export = manual sync for now; eliminates provisioning as a v1 blocker |
| Auth / multi-user | maybe never | Personal app, single device |
| Rich markdown editor | v2 if needed | Plain textarea works |
| Native iOS/Android build | v2 | Windows + WebAssembly proves the stack first |
| Tags / search | v2 | Subject grouping is enough at <100 notes |
| Backlinks / `[[wikilinks]]` | v2 | "Connect" step is a manual "Related" section in the note body |
| Voice memo recording | v3 | Feynman written explanation is the speak step in v1 |
| Statistics / progress charts | never unless asked | Vanity feature; the routine is the feedback |
| Push notifications | v2 (with native build) | Open the app daily; that's the discipline |
| Themes / dark mode | v2 | MAUI Blazor defaults are fine |
| Multiple decks / per-subject SRS settings | never | One global cap, one SM-2 algorithm |

## Discipline rule for building

If during construction an idea arrives — *"oh, I should also add X"* — it goes in [`BACKLOG.md`](../BACKLOG.md), not into v1. **Nothing** gets added to v1 after this lock.

The point of v1 is to **run the loop daily** so we discover what actually matters by using it, not by guessing.
