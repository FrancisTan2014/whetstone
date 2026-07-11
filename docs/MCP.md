# whetstone memory MCP server

whetstone exposes an **MCP server** (#190) whose tools let any MCP client — a local or cloud LLM
"coach" — drive the deposit-and-recall loop over the Memory store (#595). It is a **thin adapter**: every
tool validates its input with the shared `@whetstone/contracts` schemas and calls the same store
operations the rest of the app uses. No coaching logic, model calls, or scheduling math live here —
FSRS scheduling (v6, via `ts-fsrs`) is `@whetstone/domain` (#188), persistence is the Memory store (#595),
which stores a durable **Memory note** and its **Memory prompts** as owned Entries.

## Tools

Each tool maps 1:1 to a Memory-store operation and is scoped to the current user (the v0
default-identity seam).

| Tool                | Input                                                                                                                     | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deposit_memory`    | `{ captureSource, noteText, derivedFromEntryId?, prompts: [{ cueText, answerText?, chunkId?, glossTerm? }] }` (≥1 prompt) | Deposits a Memory: one **note** (the durable thing to remember, `noteText` non-blank; `captureSource` ∈ manual \| reader \| import \| practice \| tool; optional `derivedFromEntryId` provenance) plus one or more retrieval **prompts** (`cueText` → `answerText`). A prompt with both a cue and an answer is **scheduled** for review; a prompt with no answer (a `glossTerm` may still suggest one from the offline dictionary, else) is saved as an unscheduled **draft**. Returns the created note and prompts, incl. their ids. |
| `list_due_prompts`  | `{ limit? }`                                                                                                              | Lists the user's scheduled prompts due now, soonest first (default cap 20).                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `record_review`     | `{ promptId, rating }`                                                                                                    | Applies FSRS to the prompt for the rating (`again` \| `hard` \| `good` \| `easy`), persists the new state, appends a history row. Returns the updated prompt incl. its next `review.due`.                                                                                                                                                                                                                                                                                                                                             |
| `search_memory`     | `{ query }`                                                                                                               | Searches the user's prompts by cue or answer text (case-insensitive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `get_memory_prompt` | `{ promptId }`                                                                                                            | Fetches one of the user's prompts by id.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Invalid input, an unknown tool, or a missing prompt return a clean MCP **error result** (`isError`),
never a crash.

## Transport / wiring

The server is transport-agnostic (`createRecallMcpServer(context)` in
`src/apps/server/src/mcp/recallTools.ts`); production uses **stdio**.

- Entry point: `src/apps/server/src/mcp/main.ts` → built to `dist/mcp/main.js`.
- Run it: `pnpm --filter @whetstone/server mcp` (after `pnpm build`).
- It opens PGlite at `DATABASE_DIR` — **point it at the same `DATABASE_DIR` as the HTTP server** so
  the coach and the reader share one Memory store (notes/reading position live there too).

Wire it into an MCP client (e.g. Claude Desktop) as a stdio server:

```json
{
  "mcpServers": {
    "whetstone-memory": {
      "command": "node",
      "args": ["/abs/path/to/whetstone/src/apps/server/dist/mcp/main.js"],
      "env": { "DATABASE_DIR": "/abs/path/to/whetstone/data/db" }
    }
  }
}
```

Any MCP-capable client (local or cloud model) can use it — it advertises the tools above via
`tools/list` and serves them via `tools/call`.
