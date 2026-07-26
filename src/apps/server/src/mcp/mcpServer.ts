import {
  PREVIEW_CARD_CREATION_TOOL,
  mcpPreviewCardInputSchema,
  type McpPreviewCardResult,
  type NoteGradingTarget
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CurrentUserProvider } from "../identity/currentUser.js";
import {
  previewCardCreation,
  type PreviewCardCreationDependencies
} from "../features/notesReview/previewCardCreation.js";

// The local stdio MCP surface (#717). It exposes EXACTLY ONE tool — `preview_card_creation` — as a thin
// transport into the shared `previewCardCreation` command. It creates no other tool, no resource, no prompt,
// and no commit/save surface: a trusted local agent can only PREVIEW a corpus-grounded card and must obtain
// learner approval before any future commit. The tool is read-mostly (it stages one opaque, expiring attempt
// and writes no learning state), so a compromised or confused client cannot mutate the learner's corpus
// through it. This module holds the wiring the tests drive over an in-memory transport; the process bootstrap
// lives in `main.ts`.

// The safe description the agent reads: it states the tool's single purpose and its hard limits, so the model
// treats it as an inspection aid gated on human approval, never an autonomous writer.
const PREVIEW_CARD_CREATION_DESCRIPTION =
  "Preview a single corpus-grounded flashcard from plain-text question/answer (and an optional success " +
  "check). Returns the exact rendered card plus matching saved material and optional related material, with " +
  "a short-lived attempt id. It WRITES NOTHING and creates no card — it only previews. The rendered card " +
  "must be presented verbatim and explicitly approved by the learner before any later commit; this tool " +
  "never commits, schedules, edits, or deletes.";

// What the MCP surface needs: the shared preview command's dependencies, the current-user provider (the single
// local learner in v0), and a sink for safe operational logs. The log sink receives ONLY ids, the outcome
// status, and candidate counts — never card text, corpus content, prompts, or related-material bodies.
export type McpPreviewServerDependencies = Readonly<{
  preview: PreviewCardCreationDependencies;
  currentUser: CurrentUserProvider;
  log: (line: string) => void;
}>;

// A one-line, content-free summary of a completed preview: correlation id, outcome status, and — for a staged
// preview — the attempt id, the exact/near candidate counts, and the related-material mode. It deliberately
// never includes the rendered card, any candidate excerpt, or any lexical body, so the local log cannot leak
// corpus content.
function describeOutcome(requestId: string, result: McpPreviewCardResult): string {
  if (result.status === "previewed") {
    return (
      `preview requestId=${requestId} status=previewed attemptId=${result.attemptId} ` +
      `exact=${result.candidates.length} near=${result.nearCandidates.length} ` +
      `related=${result.relatedMaterial.mode}`
    );
  }
  return `preview requestId=${requestId} status=${result.status}`;
}

// Build the local card-preview MCP server with its single tool registered. The tool's input is validated by
// the shared strict schema (`.strict()` rejects any batch, user id, Note override, FSRS/due/event field, file
// path, or unknown key as an invalid-params error before the handler runs), and its plain-text fields are
// wrapped into documents here — the wire never carries a rich document, an id to overwrite, or a commit
// instruction. The handler translates the command's typed result into a tool result carrying both the JSON
// text and the structured content; an unexpected infrastructure failure is reported as an error result
// without leaking internals.
export function createMcpPreviewServer(dependencies: McpPreviewServerDependencies): McpServer {
  const server = new McpServer({ name: "whetstone-card-preview", version: "0.1.0" });

  server.registerTool(
    PREVIEW_CARD_CREATION_TOOL,
    {
      title: "Preview a corpus-grounded card",
      description: PREVIEW_CARD_CREATION_DESCRIPTION,
      inputSchema: mcpPreviewCardInputSchema,
      annotations: {
        title: "Preview a corpus-grounded card",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args): Promise<CallToolResult> => {
      const questionDoc = createTextDocument(args.question);
      const answerDoc = createTextDocument(args.answer);
      const target: NoteGradingTarget =
        args.successCheck === undefined
          ? { kind: "current_note" }
          : { kind: "expected_response", successCheckDoc: createTextDocument(args.successCheck) };
      const userId = dependencies.currentUser.getCurrentUserId();

      let result: McpPreviewCardResult;
      try {
        result = await previewCardCreation(dependencies.preview, userId, {
          submissionId: args.requestId,
          questionDoc,
          answerDoc,
          target,
          sense: args.sense ?? null
        });
      } catch {
        // A genuine infrastructure failure (e.g. the local database is unavailable): report a tool error
        // without echoing internals. No attempt was staged, so there is nothing to clean up.
        dependencies.log(`preview requestId=${args.requestId} status=error`);
        return {
          content: [{ type: "text", text: "Card preview is temporarily unavailable." }],
          isError: true
        };
      }

      dependencies.log(describeOutcome(args.requestId, result));
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );

  return server;
}
