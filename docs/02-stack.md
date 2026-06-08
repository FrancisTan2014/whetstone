# Stack

## Locked choices

| Layer | Choice | Why |
|---|---|---|
| Framework | **.NET MAUI Blazor Hybrid** | One codebase → PWA + native iOS/Android/Windows/Mac. Real native shell is a stated future goal. |
| Storage (v1) | **SQLite via EF Core** | Local, zero-config, ships with MAUI. Survives offline. |
| Storage abstraction | **`INoteStore` interface** | `SqliteNoteStore` now, `RemoteApiNoteStore` later. Swap is one line. |
| Note format | **Markdown body + frontmatter** | Plain text, human-readable, export = serialize → `.md` file. |
| Recall algorithm | **SM-2** | Proven, simple to implement, well-documented intervals. |
| Cap mechanism | **Hard daily limit (default 15)** | Overflow sorted by `(days_overdue desc, ease asc)` and deferred. |
| Sync | **None in v1** — export-zip is the migration path | Eliminates Azure as a v1 blocker. |

## Stacks considered and rejected

- **Next.js PWA**: faster dev velocity, larger ecosystem, but no path to true native iOS/Android without a UI rewrite (React Native). Rejected because native is a stated future goal.
- **SvelteKit PWA**: same problem as Next.js plus thinner ecosystem.
- **Native iOS/Android (Swift/Kotlin)**: two codebases. Personal-project scale doesn't justify it.
- **Electron + later mobile**: desktop-first is the wrong starting point — mobile use during commute is likely.
- **Local-only CLI/TUI**: fails the "cross-platform" goal.

## Acknowledged trade-offs

- **Blazor WebAssembly initial load is heavy (2–5 MB)**. For a personal app this is fine — load once, runs fast after.
- **Blazor's reactive model is clunkier than React** (`StateHasChanged()` calls in places). Acceptable for single-user UI complexity.
- **Slower dev velocity than Vite-based JS stacks** — accepted in exchange for native-without-rewrite later.
- **My (Claude's) effectiveness is highest in React/Next**. Slightly thinner support in MAUI Blazor patterns, but adequate.
