# Local MCP: card preview and commit

Whetstone exposes a single, trusted **local** [Model Context Protocol](https://modelcontextprotocol.io)
server so a local agent (e.g. an editor assistant) can **preview** a corpus-grounded flashcard and, after a
human approves it, **commit** exactly that preview. Both tools are thin transports into the same shared card
validation/matching/writer boundaries used by the HTTP **New card** flow — not a new content boundary.

## What it does — and does not do

- Exposes **exactly two** tools: `preview_card_creation` and `commit_card_creation`. There is no save-with-
  changed-content, schedule, edit, delete, search, bulk, or file-scan tool, and none of the retired
  Memory/Recall tools.
- **Preview writes no learning state.** A preview creates no Note, prompt, card, review event, link, or
  receipt. It only stages one opaque, **30-minute** expiring `card_creation_attempt` (source `mcp`) so a later
  commit can approve the exact previewed draft. Nothing is scheduled and nothing becomes due.
- **Commit writes only the canonical card**, by composing the same direct-card / existing-Note writers as the
  HTTP path — it never introduces a second content writer and accepts no changed content.
- Renders the **same** Question / Answer / Success check plus exact/near candidate evidence (and optional
  sense-selected related material) as the HTTP path, by reusing the shared draft, matcher, and candidate
  boundaries.
- Is **local only**: stdio transport, no HTTP/public transport, and it runs as the app's single current
  user. Untrusted or remote clients remain blocked (they would require authentication plus a first-party
  approval UI, which this foundation does not add).

## Running the server

Build the server, then run the stdio entry point:

```
pnpm --filter @whetstone/server build
pnpm --filter @whetstone/server mcp
```

The process reads the same server config as the API (database directory, etc.), opens the local database,
runs migrations, sweeps expired attempts on startup, and speaks JSON-RPC over **stdio**. `stdout` carries
only protocol frames; diagnostics go to `stderr`. Point your MCP client at this command.

## The `preview_card_creation` tool

### Input

| Field          | Required | Notes                                                                                 |
| -------------- | -------- | ------------------------------------------------------------------------------------- |
| `requestId`    | yes      | Caller-stable id. Same id + same payload replays the same live attempt (idempotent).  |
| `question`     | yes      | Non-blank **plain text**. Wrapped into a document server-side.                        |
| `answer`       | yes      | Non-blank **plain text**.                                                             |
| `successCheck` | no       | Non-blank plain text. When present the card grades against this expected response.    |
| `sense`        | no       | A WordNet sense reference `{ offset, partOfSpeech }` returned by a prior preview.      |

The input is validated **once** at the boundary by a strict schema. Batch/array payloads, a user id, any
Note override, FSRS/due/event fields, file paths, SQL, model config, or unknown keys are rejected as
invalid params **before** anything is staged.

### Result

A discriminated result:

- `previewed` — carries `attemptId`, `expiresAt` (ISO), `approvalRequired: true`, a safe `nextAction`, the
  `renderedCard` (`question` / `answer` / `successCheck`), the exact `candidates` and `nearCandidates`
  groups, `candidateFingerprint` / `revision`, and `relatedMaterial` (either offered `senses` to choose
  from, or the `relations` for the selected sense).
- `invalid_question` / `invalid_answer` / `invalid_success_check` — the drafted text failed card
  validation (e.g. empty after normalization).
- `changed_payload` — a live attempt already exists for this `requestId` with a **different** payload; the
  earlier preview must be resolved first.

The client must present the **exact** rendered card to the learner and obtain explicit approval before any
future commit. The preview is an inspection aid, never an autonomous writer.

### Idempotency and expiry

Same `requestId` + same payload returns the same live attempt (candidate evidence is refreshed if the
corpus moved). A changed payload conflicts. Expired or consumed attempts never resurrect. Cleanup runs on
startup and on attempt operations only — there is no scheduler.

## The `commit_card_creation` tool

Commits **exactly one previously approved preview**. The learner must approve the previewed card in the
trusted agent conversation first; the tool description states this precondition, and the local trusted-client
boundary cannot cryptographically prove a human message (any untrusted/remote client stays out of scope until
a first-party approval UI enforces it).

### Input

| Field       | Required | Notes                                                                                        |
| ----------- | -------- | -------------------------------------------------------------------------------------------- |
| `attemptId` | yes      | The opaque id returned by `preview_card_creation`. Identifies the owned, staged attempt.     |
| `decision`  | yes      | Exactly one of: `{ kind: "create" }`, `{ kind: "reuse", noteEntryId }`, `{ kind: "keep_separate" }`. |

The input is validated **once** by a strict schema. It accepts **no changed content** — no question/answer/
success-check, user id, Note override, FSRS/due/event fields, or unknown keys. To change the card, run a new
preview. `create` is for when no candidate Note exists; `reuse` adds the card to a reviewed existing Note by
id; `keep_separate` deliberately creates a new Note despite near-duplicate candidates.

### What it does

Under the exact-fingerprint advisory lock it reloads the owned attempt, **reruns authoritative matching**, and
either composes the canonical writer or asks for re-approval:

- `create` / `keep_separate` → the #689 direct-card writer (a new Note + prompt + card).
- `reuse` → the #688 existing-Note writer (adds the prompt/card to the chosen Note; that Note's origin is
  unchanged).

Every commit produces an unchanged Question/Answer/Success-check, a `0.90` retention card **due now**, a
zero-event transaction, and a `card_creation_receipts` row carrying an immutable audit `channel` of `mcp`
(the HTTP path records `ui`) plus the originating `attempt_id`. This is audit metadata, not a new card type —
Notes/Today/Review own and can remove the card exactly like a UI-created card.

### Result

A discriminated result:

- `created` / `reused` / `kept_separate` — success. Carries a `card` object with the created/reused
  `noteId`, the created `promptId`, and the seeded FSRS `review` state (its `state`, next `due`, and the
  other FSRS fields) — no rendered card or private body beyond the already-approved preview.
- `needs_approval` — matching moved (new/changed/deleted candidate or evidence version): the tool returns a
  **refreshed preview** and requires a fresh approval before it will commit.
- `not_found` — no such owned `mcp` attempt (forged, foreign, or never staged).
- `expired` — the attempt's 30-minute window elapsed; preview again.
- `candidates_exist` / `not_a_candidate` / `no_material` — the decision disagrees with the live candidate set
  (`create` despite candidates, `reuse` of a Note that is not a candidate, or `keep_separate` with no
  candidates).
- `decision_conflict` — the attempt was already consumed with a **different** decision kind (or `reuse`
  targeting a different Note); the first commit stands.
- `conflict` — a concurrent/prior commit already produced the card for this submission under a different
  fingerprint.
- `gone` — the attempt succeeded earlier but the resulting Note was since deleted; it does not resurrect.

### Idempotency and concurrency

A retry after success **replays the original result** through the receipt (no second card). Concurrent commits
of the same attempt collapse to one winner; the loser observes the consumed/`decision_conflict`/`conflict`
outcome. Expired, forged, foreign, or changed-evidence attempts fail by name with **zero writes**.

## Logging and privacy

Operational logs contain only ids, the outcome status, and candidate counts — never card text, corpus
content, prompts, credentials, file paths, or surrounding records.

## Where the code lives

- Server: `src/apps/server/src/mcp/mcpServer.ts` (both tools' registration) and
  `src/apps/server/src/mcp/main.ts` (process bootstrap).
- Shared commands: `src/apps/server/src/features/notesReview/previewCardCreation.ts` (preview) and
  `src/apps/server/src/features/notesReview/commitCardCreation.ts` (commit, composing the #689 direct-card and
  #688 existing-Note writers).
- Wire contracts: `src/packages/contracts/src/mcpPreviewContracts.ts` and
  `src/packages/contracts/src/mcpCommitContracts.ts`.

See `docs/MAP.md` for how this fits the wider Notes/Review map.
