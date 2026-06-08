# ADR 0001 — Stack, storage, and sequencing

**Date:** 2026-06-08
**Status:** Accepted

## Context

A personal learning app needs to run on phone and desktop, store notes durably, support a spaced-repetition recall loop, and eventually sync to the user's own cloud VM. The dominant risk is that building the tool becomes procrastination for the actual learning. The user has an existing successful pattern (10-min daily reading ritual that produced fluent recitation of three classical texts) — the app must extend that pattern, not interrupt it.

## Decision

1. **Framework: .NET MAUI Blazor Hybrid.** One codebase compiles to PWA and to native iOS/Android/Windows/Mac shells. Slower dev velocity than Next.js, accepted in exchange for never needing a native rewrite.
2. **Storage (v1): SQLite via EF Core, accessed only through an `INoteStore` interface.** A `RemoteApiNoteStore` will implement the same interface later when cloud sync ships in v2.
3. **Note format: markdown body + YAML frontmatter.** Notes round-trip to single `.md` files on export — this is the data interchange format with future cloud, with other tools, and with any future agent reading the data.
4. **Export-from-day-one.** A "download all notes as .zip" button ships in v1. This guarantees backup, makes migration to cloud routine, and tests the export code path before v2 needs it.
5. **App-first, no transitional script.** Despite the risk of delayed first-recall-session, the user prefers a single codebase from day one.
6. **Local-first storage chosen over cloud-from-day-one.** Eliminates Azure VM provisioning as a v1 blocker — first recall session happens weeks earlier.
7. **Recall: SM-2 with hard daily cap (15 items).** Overflow defers by one day, sorted by `(days_overdue desc, ease asc)`. This is the anti-guilt-list mechanism.

## Alternatives considered

- **Next.js PWA**: faster, larger ecosystem, but native path requires React Native rewrite.
- **Plain Python script first, then app**: would get the loop running this week, but user explicitly prefers single codebase.
- **Cloud-first storage from v1**: eliminates "where's my data" anxiety but blocks v1 on Azure provisioning.
- **No daily cap**: SRS purist position. Rejected because user has identified guilt-list growth as a top risk.

## Consequences

**Positive:**
- One codebase carries from PWA to native.
- Data format is portable forever (markdown is unlikely to become obsolete).
- Storage swap to cloud is a one-line change in DI bootstrap.
- Daily cap means the app cannot become a guilt-list.

**Negative / accepted risk:**
- First usable build is 2–4 weekends out. Learning loop is on pause during this time.
- Blazor WebAssembly initial load is 2–5 MB.
- Slightly less Claude leverage than in React stacks.

## Open questions

- Schema versioning strategy (deferred to Task #2)
- ID scheme for notes (deferred to Task #2)
- New-input slot sizing per subject (deferred to Task #5)
