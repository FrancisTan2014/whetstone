import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

import {
  depositRecallItemToolInputSchema,
  enrollRecallItemRequestSchema,
  getRecallItemToolInputSchema,
  listDueItemsToolInputSchema,
  recallCategories,
  recallKinds,
  recordReviewToolInputSchema,
  searchRecallItemsToolInputSchema
} from "@whetstone/contracts";
import {
  enrollRecallItem,
  recordRecallReview,
  type RecallDependencies
} from "../features/recall/recallCommands.js";
import {
  getRecallItemForUser,
  listDueRecallItems,
  searchRecallItems
} from "../features/recall/recallQueries.js";
import type { CurrentUserProvider } from "../identity/currentUser.js";

// Everything the recall tools need to act, injected so the MCP layer stays a thin adapter: the #189
// store operations (db + id generation), the current-user seam, an injectable clock, and the default
// due-list cap. No persistence or scheduling logic lives here.
export type RecallMcpContext = Readonly<{
  currentUser: CurrentUserProvider;
  dueLimit: number;
  now: () => Date;
  recall: RecallDependencies;
}>;

type ZodLikeError = Readonly<{
  issues: ReadonlyArray<Readonly<{ message: string; path: ReadonlyArray<PropertyKey> }>>;
}>;

type RecallTool = Readonly<{
  description: string;
  inputSchema: Tool["inputSchema"];
  name: string;
  run: (context: RecallMcpContext, args: unknown) => Promise<unknown>;
}>;

function userId(context: RecallMcpContext): string {
  return context.currentUser.getCurrentUserId();
}

type Validator<T> = Readonly<{
  safeParse: (
    value: unknown
  ) => { data: T; success: true } | { error: ZodLikeError; success: false };
}>;

// Validate tool input with the shared contract schema, throwing a readable error (mapped to an
// isError result, never a crash) on failure. One place to validate keeps the surface uniform.
function parseArguments<T>(schema: Validator<T>, args: unknown): T {
  const result = schema.safeParse(args);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid arguments: ${detail}`);
  }
  return result.data;
}

// Each tool maps 1:1 to a #189 operation: it validates its input with the shared contract schema,
// resolves the current user, and calls the store operation — nothing more.
const tools: ReadonlyArray<RecallTool> = [
  {
    description:
      "Enroll a recall item (a pattern/idiom/proverb/chunk/word/phrase to remember). Returns the created item, including its id.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        chunkId: {
          description: "Optional id of the practice chunk (#205) this item recalls.",
          type: "string"
        },
        gloss: { description: "Optional short gloss or note.", type: "string" },
        kind: { description: "What sort of item this is.", enum: [...recallKinds], type: "string" },
        text: { description: "The text to remember.", type: "string" }
      },
      required: ["text", "kind"],
      type: "object"
    },
    name: "save_recall_item",
    run: async (context, args) => {
      const input = parseArguments(enrollRecallItemRequestSchema, args);
      return enrollRecallItem(context.recall, input, userId(context), context.now());
    }
  },
  {
    description:
      "Deliberately save ONE production-style recall item for the current user — e.g. from an observed " +
      "English-learning mistake. Requires target/cue/useContext/category; tags, gloss, and provenanceEntryId " +
      "are optional. Uses the standard recall enrollment and FSRS seeding; it does NOT create a Make Durable " +
      "proposal/Today card, scan files, or import a corpus. Returns the created item, including its id.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        category: {
          description: "The one broad category to file the item under.",
          enum: [...recallCategories],
          type: "string"
        },
        cue: { description: "A retrieval prompt for the item.", type: "string" },
        gloss: { description: "Optional short gloss or explanation.", type: "string" },
        kind: { description: "What sort of item this is.", enum: [...recallKinds], type: "string" },
        provenanceEntryId: {
          description: "Optional id of the source/provenance entry this item came from.",
          type: "string"
        },
        tags: {
          description: "Optional narrow tags refining the category.",
          items: { type: "string" },
          type: "array"
        },
        target: {
          description: "The phrase/pattern to remember (the recall item's text).",
          type: "string"
        },
        useContext: { description: "When or where to use it.", type: "string" }
      },
      required: ["kind", "target", "cue", "useContext", "category"],
      type: "object"
    },
    name: "deposit_recall_item",
    run: async (context, args) => {
      const input = parseArguments(depositRecallItemToolInputSchema, args);
      return enrollRecallItem(
        context.recall,
        {
          kind: input.kind,
          text: input.target,
          cue: input.cue,
          useContext: input.useContext,
          category: input.category,
          tags: input.tags,
          provenanceEntryId: input.provenanceEntryId,
          gloss: input.gloss
        },
        userId(context),
        context.now()
      );
    }
  },
  {
    description: "List the current user's recall items that are due for review now, soonest first.",
    inputSchema: {
      additionalProperties: false,
      properties: { limit: { description: "Max items to return.", minimum: 1, type: "integer" } },
      type: "object"
    },
    name: "list_due_items",
    run: async (context, args) => {
      const input = parseArguments(listDueItemsToolInputSchema, args);
      const items = await listDueRecallItems(
        context.recall.db,
        userId(context),
        context.now(),
        input.limit ?? context.dueLimit
      );
      return { items };
    }
  },
  {
    description:
      "Record a review of a recall item with an FSRS rating (again/hard/good/easy). Applies the scheduler and returns the updated item, including its next due date.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        rating: {
          description: "The FSRS rating: again (forgot), hard, good, or easy.",
          enum: ["again", "hard", "good", "easy"],
          type: "string"
        },
        itemId: { description: "The recall item's id.", type: "string" }
      },
      required: ["itemId", "rating"],
      type: "object"
    },
    name: "record_review",
    run: async (context, args) => {
      const input = parseArguments(recordReviewToolInputSchema, args);
      const result = await recordRecallReview(
        context.recall,
        input.itemId,
        input.rating,
        userId(context),
        context.now()
      );
      if (result.status === "not_found") {
        throw new Error(`No recall item with id ${input.itemId}.`);
      }
      return result.item;
    }
  },
  {
    description: "Search the current user's recall set by text or gloss.",
    inputSchema: {
      additionalProperties: false,
      properties: { query: { description: "Text to search for.", type: "string" } },
      required: ["query"],
      type: "object"
    },
    name: "search_recall_items",
    run: async (context, args) => {
      const input = parseArguments(searchRecallItemsToolInputSchema, args);
      const items = await searchRecallItems(context.recall.db, userId(context), input.query);
      return { items };
    }
  },
  {
    description: "Fetch one of the current user's recall items by id.",
    inputSchema: {
      additionalProperties: false,
      properties: { id: { description: "The recall item's id.", type: "string" } },
      required: ["id"],
      type: "object"
    },
    name: "get_recall_item",
    run: async (context, args) => {
      const input = parseArguments(getRecallItemToolInputSchema, args);
      const item = await getRecallItemForUser(context.recall.db, input.id, userId(context));
      if (item === undefined) {
        throw new Error(`No recall item with id ${input.id}.`);
      }
      return item;
    }
  }
];

function errorResult(message: string): CallToolResult {
  return { content: [{ text: message, type: "text" }], isError: true };
}

// The tool descriptors advertised by tools/list.
function recallToolDescriptors(): Tool[] {
  return tools.map((tool) => ({
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name
  }));
}

// Dispatch a tools/call: validate + run the named tool, shaping the result. An unknown tool, invalid
// input, or a not-found item all return a clean isError result rather than throwing out of the server.
export async function callRecallTool(
  context: RecallMcpContext,
  name: string,
  args: unknown
): Promise<CallToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return errorResult(`Unknown tool: ${name}`);
  }

  try {
    const value = await tool.run(context, args);
    return { content: [{ text: JSON.stringify(value), type: "text" }] };
  } catch (error) {
    // Every thrown error here is an Error (invalid input / not-found); String() yields its message
    // with an "Error:" prefix without a coverage-uncoverable instanceof branch.
    return errorResult(String(error));
  }
}

// Assemble the MCP server over the recall tools. Transport is chosen by the caller (stdio in
// production, an in-memory pair in tests), keeping this model-agnostic.
export function createRecallMcpServer(context: RecallMcpContext): Server {
  const server = new Server(
    { name: "whetstone-recall", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: recallToolDescriptors()
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callRecallTool(context, request.params.name, request.params.arguments)
  );

  return server;
}
