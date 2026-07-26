# Local MCP: card preview

Whetstone exposes a single, trusted **local** [Model Context Protocol](https://modelcontextprotocol.io)
server so a local agent (e.g. an editor assistant) can **preview** a corpus-grounded flashcard before a
human commits it. It is a thin transport into the same shared card validation/matching used by the HTTP
**New card** flow — not a new content boundary.

## What it does — and does not do

- Exposes **exactly one** tool: `preview_card_creation`. There is no commit, save, schedule, edit, delete,
  search, bulk, or file-scan tool, and none of the retired Memory/Recall tools.
- **Writes no learning state.** A preview creates no Note, prompt, card, review event, link, or receipt. It
  only stages one opaque, **30-minute** expiring `card_creation_attempt` (source `mcp`) so a later commit
  surface can approve the exact previewed draft. Nothing is scheduled and nothing becomes due.
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

## Logging and privacy

Operational logs contain only ids, the outcome status, and candidate counts — never card text, corpus
content, prompts, credentials, file paths, or surrounding records.

## Where the code lives

- Server: `src/apps/server/src/mcp/mcpServer.ts` (tool registration) and `src/apps/server/src/mcp/main.ts`
  (process bootstrap).
- Shared command: `src/apps/server/src/features/notesReview/previewCardCreation.ts`.
- Wire contracts: `src/packages/contracts/src/mcpPreviewContracts.ts`.

See `docs/MAP.md` for how this fits the wider Notes/Review map.
