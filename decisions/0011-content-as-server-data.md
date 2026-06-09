# ADR 0011 — Content and configuration as server-resident runtime data

**Date:** 2026-06-09
**Status:** Accepted
**Amends:** [ADR 0008](./0008-system-architecture.md) — Postgres now also holds content, prompts, categories, and default-settings tables; the sync protocol extends.

## Context

After [ADR 0008](./0008-system-architecture.md) locked the system architecture (client + server, sync, Postgres on the server, audio blobs behind `IAudioBlobStore`), an unanswered question surfaced:

*Where does the content the user reads actually come from? And where do the prompt templates, category definitions, and default settings live as the human iterates on them?*

The default assumption in earlier ADRs (0003, 0005) was that curated materials are *"shipped in code with curated v1 material"* — i.e., constants in source files, edited by Developer in a PR. Prompt templates were similarly assumed to be in-source strings. Category definitions and default settings were treated the same way.

This is the wrong shape for three reasons:

1. **Prompt-tuning is a continuous activity, not a one-time author-and-ship.** Every prompt that grades a recitation, generates a mirror response, proposes an encounter, or generates a vocabulary card will need iteration based on observed quality. Locking these as source constants means every prompt tweak is a Developer PR, an Architect review, a code-review cycle, a release build, and a re-install on every client. That cadence kills the iteration loop. Worse, it pushes prompt-tuning into agent-edit territory — which is exactly the worst place for it (see ADR 0012 on why agents must not tune the prompts that judge user content).

2. **Materials are content, not code.** When the human admin adds a new 史记 chapter, fixes a transcription error in a recitation passage, or tweaks the Orwell selection order, that is content curation — the same act as adding a row to a CMS. Forcing it through a build-and-release cycle is wrong by category. (The user explicitly named platform-switching pain as the reason whetstone exists in [ADR 0006](./0006-voice-first-class.md#context); shipping a new build to edit a chapter heading recreates that pain inside whetstone.)

3. **Category definitions and default settings sit between the two.** A category's template ("what's the story / what's the author's view / what do you think / gems") is a piece of content shown to the user; the daily budget default ($0.25) is a setting the human will want to revise from real use. Both want the live-edit cadence of content, not the build-ship cadence of code.

[ADR 0008](./0008-system-architecture.md) already added a Postgres database on the server. Putting content + configuration into that same Postgres is a small structural change; the iteration-loop unlock is large. The sync protocol naturally extends — clients fetch content the same way they fetch note updates.

Four user decisions were locked in [DRAFT.md](../DRAFT.md) (the "Confirmed by user" subsection) before this ADR was drafted:

1. Content, prompt templates, category definitions, and default settings live as server-resident data, edited via an admin surface, cached on clients.
2. Per-category material delivery is hybrid: 史记 / recitation / Orwell are server-held text; CS:APP is reference-only (whetstone never holds the book's text); diary is user-authored.
3. Admin role is human-only ([ADR 0012](./0012-admin-role.md) covers the role).
4. Admin UI lives inside the whetstone client behind an admin-scoped bearer token ([ADR 0012](./0012-admin-role.md) covers the UI).

This ADR addresses the storage, schema, sync, and lifecycle decisions. [ADR 0012](./0012-admin-role.md), paired in the same commit, addresses the admin role and the admin UI.

## Decision

### 1. The four kinds of server-resident data

Four new logical concerns join Notes in the server's Postgres:

| Concern | What it holds | Editable by | Read by |
|---|---|---|---|
| **Curated materials** | Works → chapters → sections → encounter units. Per-subject. Hierarchical. For server-held categories (史记, recitation, Orwell), each encounter unit carries its text; for reference-only (CS:APP), each unit carries only a citation and acceptance criteria. | Admin (human) via admin UI | Client on sync; LLM proposal via `EncounterProposer`; UI when rendering an encounter |
| **Prompt templates** | One template per LLM-touching moment (grade-recitation, grade-concept, mirror-narrative, mirror-reflection, mirror-prose, propose-encounter, generate-vocab-card, generate-card-etymology). Versioned. | Admin (human) via admin UI | Client on sync; `AnthropicGrader` and `EncounterProposer` when composing requests |
| **Category definitions** | Category id, name, template (the writing scaffold shown to the user), default weight, revisit-method binding, slot-sizing defaults. | Admin (human) via admin UI | Client on sync; `RoutineGenerator` and UI |
| **Default settings** | Daily budget, cap size (currently 15), ritual list, FSRS initial parameters, Echo cadence, anything else that today reads as "the default for a fresh install." | Admin (human) via admin UI | Client on sync; UI when a setting hasn't been overridden per-client |

These are **read-mostly** from the client's perspective: the admin writes them rarely; clients read them every sync. Treat them as a separate cache concern from the user's notes.

### 2. Postgres schema (server side)

New tables in the server's existing `WhetstoneDbContext` (renamed from `NoteDbContext` in [ADR 0008](./0008-system-architecture.md) §5 to reflect the broader scope):

```
materials                       (one row per encounter unit)
├── id              UUID PK
├── subject_id      FK → subjects
├── parent_id       FK → materials (self-ref; null for top-level work)
├── kind            enum: work | chapter | section | unit
├── ordinal         int                            (ordering within parent)
├── title           text
├── body            text                           (null for reference-only CS:APP)
├── citation        text                           (filled for reference-only)
├── acceptance      text                           (what counts as engaged with this unit; null for held)
├── created_at      timestamptz
├── updated_at      timestamptz
└── deleted_at      timestamptz   (soft delete)

prompt_templates                (one row per template version)
├── id              UUID PK
├── template_key    text                           (e.g. "grade.recitation", "mirror.narrative")
├── version         int                            (monotonically increases per key)
├── body            jsonb                          (see §4 for structure)
├── created_at      timestamptz
├── created_by      text                           (admin identifier, single value in v1)
└── notes           text                           (admin's free-text reason for the version)

prompt_template_active          (one row per template_key; points at the live version)
├── template_key    text PK
├── active_version  int                            (FK indirection to (template_key, version))
└── activated_at    timestamptz

categories
├── id              text PK                        (slug: "literary-narrative", "recitation", ...)
├── name            text
├── template        text                           (writing scaffold shown to user)
├── default_weight  int
├── revisit_method  enum: fsrs | diminishing | linked-surfacing
├── slot_sizing     jsonb                          (per-category time-budget defaults)
├── updated_at      timestamptz
└── deleted_at      timestamptz

default_settings
├── key             text PK                        (slug: "daily-budget", "cap-size", ...)
├── value           jsonb
└── updated_at      timestamptz
```

**Versioning model**: every save of a prompt template inserts a new row in `prompt_templates` with `version = max(version)+1`. The `prompt_template_active` table holds a single pointer per `template_key` to the currently-live version. Rollback is `UPDATE prompt_template_active SET active_version = N` — instant, no data loss.

**Soft delete** on `materials` and `categories` because: (a) historical notes reference them via FK, (b) the admin may want to un-delete after the fact. Hard delete is an admin-UI action that is a separate operation (and triggers a cascade-check).

**No versioning on `categories` or `default_settings`** in v1. Categories rarely change after launch; default settings are settings, not content. If versioning becomes needed it is a v1.5 amendment.

### 3. Sync protocol extension

The sync protocol from [ADR 0008](./0008-system-architecture.md) §11 grows three operations. The shape of each follows the existing `GET /v1/sync/changes?since={ISO8601}` pattern — clients pass their last-known-modified watermark, server returns everything newer.

| Endpoint | Purpose |
|---|---|
| `GET /v1/sync/content?since={ISO8601}` | Returns materials (the body field if held; citation + acceptance only for reference-only), categories, default_settings with `updated_at > since`. Server-side soft-deletes appear as tombstones (`deleted_at` populated). |
| `GET /v1/sync/prompts?since={ISO8601}` | Returns prompt template rows whose `prompt_template_active.activated_at > since` (i.e., new active versions since last sync) plus the linked `prompt_templates` body. The client only ever sees active versions; archived versions stay server-side for rollback. |
| `POST /v1/admin/...` | Admin write endpoints. Documented in detail in [ADR 0012](./0012-admin-role.md). Gated by admin-scoped bearer token. Not consumed by regular clients. |

**Why three separate sync endpoints rather than one `GET /v1/sync/everything`**: different cadences, different sizes, different polling needs. Content changes are bursty (admin adds a chapter, then nothing for a week); prompt changes are surgical (admin tunes one template, others untouched); note changes are continuous. Three endpoints let each set its own polling interval and lets the server return small payloads. The same `SyncEngine` on the client orchestrates all three concurrently.

**Sync triggers** (client side):
- On app launch: `sync/changes` + `sync/content` + `sync/prompts` all fire (in parallel).
- After every save (note save → `sync/changes` only; admin save → all three).
- Foreground poll every 5 minutes (all three).
- On reconnect after offline.

**Cache freshness vs availability trade-off**: clients cache aggressively. The local cache is authoritative for the routine — if the server is unreachable but the client cache has the materials it needs, the user keeps working. The client's prompt cache means even grading works through Anthropic with cached prompts when the server is down. Only newly-admin-edited content / prompts won't appear until the next successful sync.

### 4. Prompt template structure

Templates are stored as `jsonb` with this shape:

```json
{
  "system": "string with {placeholders}",
  "user": "string with {placeholders}",
  "model": "haiku-4-5",
  "max_tokens": 800,
  "temperature": 0.4,
  "placeholders": ["original_answer", "current_answer", "subject_direction"]
}
```

**Why structured, not pure string**: real prompts need model selection per template (recitation grading might want Haiku; deep mirror response might want Opus), max-token caps per template (vocabulary card is small; mirror is medium), temperature per template (grading wants low; mirror wants slightly higher). Storing only a string forces these as constants in code, which recreates the iteration-loop problem this ADR exists to solve.

**The `placeholders` array** is the contract between admin and code. The grading code calling the template knows which placeholders to fill; the admin editing the template sees the list of available placeholders in the admin UI. Mismatch (admin uses `{foo}` not in the list, or code passes `{bar}` the template doesn't reference) is detectable at admin-save time (admin UI validates) and at runtime (grading code refuses to send a template with unfilled placeholders, falls back to self-grade, surfaces a banner).

**v1 prompt-template keys** (the LLM-touching moments enumerated):

- `grade.recitation` — score a recitation attempt against the original passage.
- `grade.concept` — score a concept re-derivation against the original explanation.
- `grade.vocabulary` — score a vocabulary recall.
- `mirror.narrative` — compose a mirror paragraph for a literary-narrative revisit.
- `mirror.reflection` — same for diary.
- `mirror.prose` — same for prose-modeling.
- `propose.encounter` — propose the next encounter within a subject, anchored on the Direction.
- `generate.vocabulary_card` — turn a captured word + sentence into a vocabulary card.

That is the v1 catalog. New keys are added by ADR (just like a new LLM-touching moment would be a methodology change).

### 5. Client cache strategy

- **Pull-on-launch + interval poll** in v1. No push-on-change. The admin's expected edit cadence (a few changes per week at most) does not justify push infrastructure.
- **Local cache lives in the client SQLite** alongside notes, in separate tables (`cached_materials`, `cached_prompts`, `cached_categories`, `cached_default_settings`). Same `LocalNoteStore` owns access (no new client seam — the existing seam is broad enough; see [§9 Anti-rule check](#9-anti-rule-check)).
- **The admin's edits show up next time the client syncs**, which is at most 5 minutes later (foreground poll) or on the next app open. For prompt rollbacks (which the admin reaches for when a prompt is producing bad output), this latency is acceptable.
- **Cache invalidation = the sync watermark**. No explicit invalidation logic. The server's `updated_at` is authoritative.

### 6. Material delivery per category (the hybrid model)

| Category | Material on server? | Material on client cache? | User reads? |
|---|---|---|---|
| Literary narrative (史记) | Held in `materials.body` | Cached on first encounter, retained | Inside whetstone |
| Recitation (滕王阁序, 洛神赋, 笠翁对韵) | Held in `materials.body` | Cached on first encounter, retained | Inside whetstone (essential for recitation comparison) |
| Prose-modeling (Orwell essays) | Held in `materials.body` | Cached on first encounter, retained | Inside whetstone |
| Concept/mechanism (CS:APP) | `materials.citation` and `materials.acceptance` only — no body | Cached on first encounter | **Outside whetstone** (user reads their own copy of the book); whetstone shows the citation and holds the engagement note |
| Reflection (diary) | No material rows | n/a | User authors freely |

**Why CS:APP is reference-only**: whetstone never holds the book's text. The user already owns the book; making whetstone re-host it adds storage and licensing complexity for zero user benefit. The acceptance text in each unit is the admin's note for what "engaged with this section" looks like — surfaced to the LLM when grading concept re-derivation.

### 7. Content lifecycle

- **First server install**: content tables ship empty. The very first app run pushes the user (acting as admin) into the admin UI to populate at least one subject's first material. The bootstrap problem is solved by the admin flow, not by seed data shipped in source — keeps source clean, gives the admin agency from day one.
- **Adding a new chapter / section / unit**: admin creates rows in `materials`; on next client sync, the LLM proposal pool grows; subsequent `EncounterProposer.ProposeAsync` calls can surface the new content.
- **Editing existing material** (e.g., fixing a transcription error in 滕王阁序): admin edits the row; `updated_at` bumps; clients re-fetch on next sync; cached copies are replaced.
- **Removing material**: soft-delete via `deleted_at`. Existing notes that reference the material remain valid (they hold their own original-answer copy per the methodology); they simply do not appear as "due for revisit" if the material is gone. A future admin UI surface could surface "notes pointing at deleted materials" for cleanup; not required in v1.
- **Prompt tuning**: admin saves a new version → admin clicks "activate" → `prompt_template_active.active_version` flips → next client sync receives the new template → next LLM call uses it. Rollback is the same operation pointing back at an older version.

### 8. Sync protocol idempotency (extends [ADR 0008](./0008-system-architecture.md) §11)

The `GET` endpoints are naturally idempotent (read-only). The `POST /v1/admin/...` endpoints follow the same client-generated `change_id` contract as `POST /v1/sync/changes` — admin saves carry a UUID v4 the server dedupes against. This matters because the admin UI is itself a sync-aware client (offline edits → server when reconnected); retries after partial failures must not double-apply.

### 9. Anti-rule check

- **No new seam.** Server-side, content tables sit inside the existing `WhetstoneDbContext` alongside notes — the server has no `INoteStore`-style interface (per [ADR 0008](./0008-system-architecture.md) §5; server-side, `IAudioBlobStore` is the only interface). Client-side, the cached content/prompts/categories tables live behind the same `INoteStore` boundary that already owns subjects, pause state, and the spend log; the interface is broader than its name suggests and that breadth has been load-bearing since [ADR 0001](./0001-stack-and-storage.md). Adding more cached read-mostly tables behind the same boundary is the right shape; coining `IContentStore` / `IPromptStore` would be the seam proliferation the four-seam rule forbids.
- **No `*Manager` / `*Helper`.** Sync logic extends `SyncEngine` (already justified per [ADR 0008](./0008-system-architecture.md) §9 anti-rule discussion). Admin write logic lives in a small set of admin-only controllers, not a `ContentManager`.
- **No background workers, no message queues.** The new sync endpoints follow the existing `SyncEngine.SyncAsync()` triggers — on launch, on save, on poll, on reconnect. Same shape, more endpoints.
- **Class is default; interface is exception.** Holds. Four seams: `INoteStore`, `IGrader`, `IAudioProcessor` (client), `IAudioBlobStore` (server).

## Alternatives considered

- **Content + prompts + categories + settings as source-code constants** (the pre-ADR status quo). Rejected for the reasons in Context: forces prompt tuning into a build-ship cycle, makes content edits a Developer PR, blurs the line between code and content. The "curated v1 material" framing in earlier ADRs is now explicitly rewritten — material is *admin-curated*, not source-resident.
- **Static-file content (Markdown files in a `content/` folder, served by the server)**. Considered. Rejected because: (a) versioning prompts wants real database semantics, not file-version files, (b) admin edits via UI wants atomic transactional writes, not file IO with race risk, (c) reference-only content (CS:APP) needs structured fields (citation, acceptance), not just text, (d) once the server has Postgres for notes, adding a few content tables is trivial — adding a separate static-file pipeline is added surface.
- **Separate "config service" as a second container alongside the main server**. Rejected as ceremony. One server, one DB, more tables. The architectural cost of a second service exceeds the benefit (which is mostly imaginary "separation of concerns" without a real differentiator).
- **Pure-string prompts (no model / max_tokens / temperature in the template)**. Rejected. Real prompt iteration needs to tune those knobs per template. Storing them as global constants in code recreates the iteration-loop problem.
- **CRDT for prompt template edits** (concurrent admin edits). Rejected; single human admin, no concurrent editing scenario in v1. Last-write-wins via `updated_at` plus the explicit `prompt_template_active` activation step is enough.
- **Push-on-change sync** (server notifies clients when content changes). Rejected for v1; admin edit cadence does not justify the infrastructure. Pull-on-launch + interval is sufficient. Revisit if admin reports waiting too long after an edit before the new prompt is live.
- **Versioning categories or default settings.** Rejected for v1. Categories rarely change after launch; settings are settings. If real use surfaces a need (e.g., the admin reverts a default-budget change), add later via ADR amendment.
- **Hard delete on materials**. Rejected. Notes reference materials; FK cascade or orphan-fix code is complexity for an event that fires rarely. Soft delete + admin-triggered cascade-aware hard delete is the cleaner path.
- **Reference-only model also for 史记 / Orwell / recitation** (whetstone holds nothing, just citations). Rejected. Recitation requires character-match against the source; the source must be in whetstone for the loop to work. Literary narrative and prose-modeling benefit from in-app reading (one-tap vocabulary capture works while reading; the loop stays inside whetstone, per Conviction #2). CS:APP is the exception because: the book exists in a form the user already owns, the engagement is mostly the user's own derivation work (not re-reading text), and re-hosting the book is licensing-fragile.
- **Hold all content client-side from a bundled seed** (no server fetch for content; admin updates ship as new app versions). Rejected. Recreates the build-ship cadence problem this ADR is solving. Defeats the in-app admin UI.
- **Admin edits committed to git as the source of truth** (server is a git checkout). Considered briefly. Rejected because: (a) the human admin should not need to use git to add a chapter, (b) the admin UI is the right abstraction, (c) the git-as-source pattern works for code, not for content that is itself in many languages and rendered as user-facing material.
- **Encrypt prompt templates at rest** (in case the server is compromised, the prompts leak). Rejected. The threat model is "user-owned MBP behind Cloudflare Tunnel with full-disk encryption (FileVault)"; encrypting again is ceremony. Revisit at v2 cloud migration when the threat model changes.

## Consequences

**Positive:**

- **Prompt-tuning becomes a daily-iterable activity, not a release event.** The admin tweaks a template, clicks activate, the next sync delivers it. The convictions can be defended at the prompt layer continuously.
- **Content edits become a CMS activity, not a code change.** New 史记 chapter → admin adds row → users see it on next sync. No PR, no build, no review cycle for content.
- **The line between code and content is structural, not cultural.** The hard stop in [AGENTS.md](../AGENTS.md) ("Do not edit curated materials, prompt templates, category definitions, or default settings") is enforceable by code review against this ADR: hard-coding a curated material is a reject pattern in [REVIEW_SPEC.md](../REVIEW_SPEC.md).
- **Reference-only support for CS:APP** keeps whetstone honest — the app does not pretend to be a re-hosting platform for books the user already owns.
- **The four seams hold.** No new interface needed; the existing client and server boundaries absorb the new tables cleanly. This is also a validation: the seams as named in [ADR 0008](./0008-system-architecture.md) were the right ones, scoped broadly enough to accommodate a significant new responsibility.

**Negative / accepted risk:**

- **Prompt corpus is now operationally critical**. A bad prompt activation can degrade grading silently. Mitigation: the `prompt_template_active` table makes rollback one operation; the admin UI surfaces the diff and the version history. Real risk: the admin notices a bad prompt only after a few revisits got bad grades. Acceptable; the admin is the user, and the user will notice their own grading feeling off.
- **First-install bootstrap is "go to admin UI and populate"**, not "use the app immediately." For the user-who-is-also-admin this is correct (the first thing the admin should do is set up their content). For any future scenario where user and admin diverge, the bootstrap story would need rework. Acceptable for v1.
- **Client cache for content can grow large** if the admin loads many materials. Mitigation: client cache eviction is implementation detail; v1 default is "keep everything," v1.5 can introduce LRU eviction for materials the user has not encountered in N months.
- **A bug in the sync protocol's content fetch can wipe a client's local cache** (if the server returns a tombstone for a material the client still has notes referencing). Mitigation: server-side soft delete + client-side "tombstone removes from proposal pool but does not delete cached body if local notes reference it." Implementation detail caught in code review.
- **The hard stop on agent prompt-editing means** Developer cannot fix a typo in a prompt template via PR. The admin must do it via admin UI. This is the intended cost — it removes the failure mode where an agent quietly retunes the prompt that judges user content. Defended in [ADR 0012](./0012-admin-role.md).
- **`WhetstoneDbContext` (renamed from `NoteDbContext`)** is now broader than notes alone. The name change is a small migration in the server code, acceptable.
- **Schema-version forward compatibility**: introducing these tables in a fresh v1 is free; adding columns later follows EF Core migrations. The `schema_version` frontmatter from earlier ADRs applies to note files in export, not to the server schema; server schema is EF-migration-managed.

## Revisit triggers

- **Admin reports waiting too long** after a prompt edit before seeing the new behavior: revisit push-on-change sync (server → client websocket / SSE).
- **Client cache for materials becomes a real storage problem** (mobile devices, low-storage users): revisit eviction policy; consider lazy-fetch for material body with metadata always cached.
- **A second admin appears** (whetstone opens to a friend, family member, or small team): revisit single-admin assumption; multi-admin needs role-based ACLs on the write endpoints and probably an audit log.
- **Bad-prompt incident** that wasn't caught for days: revisit admin UI's surface for "show me grading quality samples for the live prompt" — telemetry-adjacent but probably the right move when it's needed.
- **CS:APP-reference-only model** proves frustrating because users want quotes from the book in their notes: revisit reference-only stance; partial-text caching for cited passages may be defensible.
- **A new LLM-touching moment** is added by methodology change (e.g., "summarize the week"): add a new prompt-template key by ADR amendment to this ADR.
- **Cloud migration** (v2): the same `WhetstoneDbContext` schema migrates with `pg_dump`/`pg_restore`. Content tables are not host-specific. No anticipated rework.
- **Versioning categories or default settings** becomes needed: amend this ADR to add versioning columns + active-pointer pattern (the same pattern used for prompt templates).
