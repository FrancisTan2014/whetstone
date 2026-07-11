import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

import {
  depositMemoryRequestSchema,
  getMemoryPromptToolInputSchema,
  listDuePromptsToolInputSchema,
  recordReviewToolInputSchema,
  searchMemoryToolInputSchema
} from "@whetstone/contracts";
import { captureSources } from "@whetstone/domain";

import {
  depositMemory,
  recordPromptReview,
  type MemoryDependencies
} from "../features/memory/memoryCommands.js";
import {
  getMemoryPromptForUser,
  listDuePromptCards,
  searchMemoryPrompts
} from "../features/memory/memoryQueries.js";
import type { CurrentUserProvider } from "../identity/currentUser.js";

// Everything the memory tools need to act, injected so the MCP layer stays a thin adapter: the #595
// store operations (db + id generation + optional offline glosser), the current-user seam, an
// injectable clock, and the default due-list cap. No persistence or scheduling logic lives here.
export type RecallMcpContext = Readonly<{
  currentUser: CurrentUserProvider;
  dueLimit: number;
  now: () => Date;
  memory: MemoryDependencies;
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

// The retrieval-prompt sub-schema advertised inside deposit_memory. A prompt shows `cueText`, optionally
// reveals `answerText`, may ask the offline dictionary to suggest an answer via `glossTerm`, and may link
// to a practice `chunkId` so mastery keeps deriving from FSRS state.
const promptInputSchema: Tool["inputSchema"] = {
  additionalProperties: false,
  properties: {
    cueText: { description: "The retrieval prompt shown first.", type: "string" },
    answerText: {
      description: "What to reveal and check against. Omit if there is no revealable answer.",
      type: "string"
    },
    chunkId: {
      description: "Optional id of the practice chunk (#205) this prompt recalls.",
      type: "string"
    },
    glossTerm: {
      description: "Optional term for the offline dictionary to suggest an answer from.",
      type: "string"
    }
  },
  required: ["cueText"],
  type: "object"
};

// Each tool maps 1:1 to a #595 memory-store operation: it validates its input with the shared contract
// schema, resolves the current user, and calls the store operation — nothing more.
const tools: ReadonlyArray<RecallTool> = [
  {
    description:
      "Deposit a Memory: one note (the durable thing to remember) plus one or more retrieval prompts " +
      "(cue -> answer). A prompt with both a cue and an answer is scheduled for review; a prompt with no " +
      "answer (and no gloss) is saved as an unscheduled draft. Returns the created note and prompts, " +
      "including their ids.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        captureSource: {
          description: "Where this memory was captured from.",
          enum: [...captureSources],
          type: "string"
        },
        noteText: { description: "The note body — the durable thing to remember.", type: "string" },
        derivedFromEntryId: {
          description: "Optional id of the source/provenance entry this memory came from.",
          type: "string"
        },
        prompts: {
          description: "One or more retrieval prompts under the note.",
          items: promptInputSchema,
          minItems: 1,
          type: "array"
        }
      },
      required: ["captureSource", "noteText", "prompts"],
      type: "object"
    },
    name: "deposit_memory",
    run: async (context, args) => {
      const input = parseArguments(depositMemoryRequestSchema, args);
      return depositMemory(context.memory, input, userId(context), context.now());
    }
  },
  {
    description: "List the current user's Memory prompts that are due for review now, soonest first.",
    inputSchema: {
      additionalProperties: false,
      properties: { limit: { description: "Max prompts to return.", minimum: 1, type: "integer" } },
      type: "object"
    },
    name: "list_due_prompts",
    run: async (context, args) => {
      const input = parseArguments(listDuePromptsToolInputSchema, args);
      const items = await listDuePromptCards(
        context.memory.db,
        userId(context),
        context.now(),
        input.limit ?? context.dueLimit
      );
      return { items };
    }
  },
  {
    description:
      "Record a review of a Memory prompt with an FSRS rating (again/hard/good/easy). Applies the " +
      "scheduler and returns the updated prompt, including its next due date.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        rating: {
          description: "The FSRS rating: again (forgot), hard, good, or easy.",
          enum: ["again", "hard", "good", "easy"],
          type: "string"
        },
        promptId: { description: "The Memory prompt's id.", type: "string" }
      },
      required: ["promptId", "rating"],
      type: "object"
    },
    name: "record_review",
    run: async (context, args) => {
      const input = parseArguments(recordReviewToolInputSchema, args);
      const result = await recordPromptReview(
        context.memory,
        input.promptId,
        input.rating,
        userId(context),
        context.now()
      );
      if (result.status !== "recorded") {
        throw new Error(`Cannot review prompt ${input.promptId}: ${result.status}.`);
      }
      return result.prompt;
    }
  },
  {
    description: "Search the current user's Memory prompts by cue or answer text.",
    inputSchema: {
      additionalProperties: false,
      properties: { query: { description: "Text to search for.", type: "string" } },
      required: ["query"],
      type: "object"
    },
    name: "search_memory",
    run: async (context, args) => {
      const input = parseArguments(searchMemoryToolInputSchema, args);
      const items = await searchMemoryPrompts(context.memory.db, userId(context), input.query);
      return { items };
    }
  },
  {
    description: "Fetch one of the current user's Memory prompts by id.",
    inputSchema: {
      additionalProperties: false,
      properties: { promptId: { description: "The Memory prompt's id.", type: "string" } },
      required: ["promptId"],
      type: "object"
    },
    name: "get_memory_prompt",
    run: async (context, args) => {
      const input = parseArguments(getMemoryPromptToolInputSchema, args);
      const prompt = await getMemoryPromptForUser(context.memory.db, input.promptId, userId(context));
      if (prompt === undefined) {
        throw new Error(`No memory prompt with id ${input.promptId}.`);
      }
      return prompt;
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
// input, or a not-found prompt all return a clean isError result rather than throwing out of the server.
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

// Assemble the MCP server over the memory tools. Transport is chosen by the caller (stdio in
// production, an in-memory pair in tests), keeping this model-agnostic.
export function createRecallMcpServer(context: RecallMcpContext): Server {
  const server = new Server(
    { name: "whetstone-memory", version: "0.1.0" },
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
