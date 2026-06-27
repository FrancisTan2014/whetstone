# whetstone recall MCP server

whetstone exposes an **MCP server** (#190) whose tools let any MCP client — a local or cloud LLM
"coach" — drive the save-and-recall loop over the recall store (#189). It is a **thin adapter**: every
tool validates its input with the shared `@whetstone/contracts` schemas and calls the same store
operations the rest of the app uses. No coaching logic, model calls, or scheduling math live here —
SM-2 scheduling is `@whetstone/domain` (#188), persistence is the recall store (#189).

## Tools

Each tool maps 1:1 to a recall-store operation and is scoped to the current user (the v0
default-identity seam).

| Tool | Input | Does |
| --- | --- | --- |
| `save_recall_item` | `{ text, kind, gloss? }` | Enrolls a recall item (kind ∈ pattern \| idiom \| proverb \| chunk \| word \| phrase), seeding its SM-2 schedule. Returns the created item (incl. `id`). |
| `list_due_items` | `{ limit? }` | Lists the user's items due now, soonest first (default cap 20). |
| `record_review` | `{ itemId, grade }` | Applies SM-2 to the item for the grade (0–5), persists the new state, appends a history row. Returns the updated item incl. its next `review.dueAt`. |
| `search_recall_items` | `{ query }` | Searches the user's set by text or gloss (case-insensitive). |
| `get_recall_item` | `{ id }` | Fetches one of the user's items by id. |

Invalid input, an unknown tool, or a missing item return a clean MCP **error result** (`isError`),
never a crash.

## Transport / wiring

The server is transport-agnostic (`createRecallMcpServer(context)` in
`src/apps/server/src/mcp/recallTools.ts`); production uses **stdio**.

- Entry point: `src/apps/server/src/mcp/main.ts` → built to `dist/mcp/main.js`.
- Run it: `pnpm --filter @whetstone/server mcp` (after `pnpm build`).
- It opens PGlite at `DATABASE_DIR` — **point it at the same `DATABASE_DIR` as the HTTP server** so
  the coach and the reader share one recall set (notes/reading position live there too).

Wire it into an MCP client (e.g. Claude Desktop) as a stdio server:

```json
{
  "mcpServers": {
    "whetstone-recall": {
      "command": "node",
      "args": ["/abs/path/to/whetstone/src/apps/server/dist/mcp/main.js"],
      "env": { "DATABASE_DIR": "/abs/path/to/whetstone/data/db" }
    }
  }
}
```

Any MCP-capable client (local or cloud model) can use it — it advertises the tools above via
`tools/list` and serves them via `tools/call`.
