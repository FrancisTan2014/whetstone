import {
  COMMIT_CARD_CREATION_TOOL,
  PREVIEW_CARD_CREATION_TOOL,
  mcpCommitCardInputSchema,
  mcpPreviewCardInputSchema,
  type McpCommitCardResult,
  type McpPreviewCardResult,
  type NoteGradingTarget
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { CurrentUserProvider } from "../identity/currentUser.js";
import {
  commitCardCreation,
  type CommitCardCreationDependencies
} from "../features/notesReview/commitCardCreation.js";
import {
  previewCardCreation,
  type PreviewCardCreationDependencies
} from "../features/notesReview/previewCardCreation.js";

// The local stdio MCP surface (#717 preview, #718 commit). It exposes EXACTLY TWO tools —
// `preview_card_creation` and `commit_card_creation` — as thin transports into the shared preview/commit
// commands. It creates no other tool, no resource, and no prompt. A trusted local agent PREVIEWS a
// corpus-grounded card, presents it verbatim for explicit learner approval, and only then COMMITS the exact
// staged draft (never a resubmitted payload). Preview writes no learning state; commit writes through the SAME
// canonical direct-card / existing-Note writers the in-app flow uses, receipt-idempotently. Both are the
// single place their behavior lives; this module holds the wiring the tests drive over an in-memory transport,
// and the process bootstrap lives in `main.ts`.

// The safe description the agent reads: it states the tool's single purpose and its hard limits, so the model
// treats it as an inspection aid gated on human approval, never an autonomous writer.
const PREVIEW_CARD_CREATION_DESCRIPTION =
  "Preview a single corpus-grounded flashcard from plain-text question/answer (and an optional success " +
  "check). Returns the exact rendered card plus matching saved material and optional related material, with " +
  "a short-lived attempt id. It WRITES NOTHING and creates no card — it only previews. The rendered card " +
  "must be presented verbatim and explicitly approved by the learner before any later commit; this tool " +
  "never commits, schedules, edits, or deletes.";

// The commit tool's description states the approval precondition explicitly: it commits ONLY a draft the
// learner has already seen (from a prior preview) and explicitly approved, using the opaque attempt id — it
// carries no card content, so it can never enroll a changed payload. It creates exactly one card and is
// idempotent per attempt.
const COMMIT_CARD_CREATION_DESCRIPTION =
  "Commit a flashcard that was already previewed by `preview_card_creation` AND explicitly approved by the " +
  "learner. Pass the opaque attempt id from that preview plus the learner's decision (create a new card, " +
  "reuse a surfaced saved note, or keep separate). It carries NO card text — it commits exactly the previewed " +
  "draft, never a resubmitted one. Never call it without the learner's explicit approval of the previewed " +
  "card. If the saved material changed since the preview it returns a refreshed preview to approve again. " +
  "Creating one card is idempotent per attempt.";

// What the MCP surface needs: the shared preview and commit commands' dependencies, the current-user provider
// (the single local learner in v0), and a sink for safe operational logs. The log sink receives ONLY ids, the
// outcome status, and candidate counts — never card text, corpus content, prompts, or related-material bodies.
export type McpCardServerDependencies = Readonly<{
  preview: PreviewCardCreationDependencies;
  commit: CommitCardCreationDependencies;
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

// A one-line, content-free summary of a completed commit: the attempt id, the outcome status, and — for a
// written card — the created note/prompt ids, or — for a re-approval — the refreshed candidate counts. It
// never includes the rendered card or any candidate excerpt, so the local log cannot leak corpus content.
function describeCommitOutcome(attemptId: string, result: McpCommitCardResult): string {
  if (result.status === "created" || result.status === "reused" || result.status === "kept_separate") {
    return (
      `commit attemptId=${attemptId} status=${result.status} ` +
      `noteId=${result.card.noteId} promptId=${result.card.promptId}`
    );
  }
  if (result.status === "needs_approval") {
    return (
      `commit attemptId=${attemptId} status=needs_approval ` +
      `exact=${result.preview.candidates.length} near=${result.preview.nearCandidates.length}`
    );
  }
  return `commit attemptId=${attemptId} status=${result.status}`;
}

// Build the local card MCP server with its two tools registered. Each tool's input is validated by the shared
// strict schema (`.strict()` rejects any batch, user id, Note override, FSRS/due/event field, file path, or
// unknown key as an invalid-params error before the handler runs). The preview tool wraps its plain-text
// fields into documents here — the wire never carries a rich document, an id to overwrite, or a commit
// instruction; the commit tool carries only the opaque attempt id and the approved decision. Each handler
// translates the command's typed result into a tool result carrying both the JSON text and the structured
// content; an unexpected infrastructure failure is reported as an error result without leaking internals.
export function createMcpCardServer(dependencies: McpCardServerDependencies): McpServer {
  const server = new McpServer({ name: "whetstone-card", version: "0.1.0" });

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

  server.registerTool(
    COMMIT_CARD_CREATION_TOOL,
    {
      title: "Commit an approved corpus-grounded card",
      description: COMMIT_CARD_CREATION_DESCRIPTION,
      inputSchema: mcpCommitCardInputSchema,
      annotations: {
        title: "Commit an approved corpus-grounded card",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (args): Promise<CallToolResult> => {
      const userId = dependencies.currentUser.getCurrentUserId();

      let result: McpCommitCardResult;
      try {
        result = await commitCardCreation(dependencies.commit, userId, {
          attemptId: args.attemptId,
          decision: args.decision
        });
      } catch {
        // A genuine infrastructure failure: report a tool error without echoing internals. The commit runs in
        // one transaction, so a failed commit rolled back and wrote nothing.
        dependencies.log(`commit attemptId=${args.attemptId} status=error`);
        return {
          content: [{ type: "text", text: "Card commit is temporarily unavailable." }],
          isError: true
        };
      }

      dependencies.log(describeCommitOutcome(args.attemptId, result));
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result
      };
    }
  );

  return server;
}
