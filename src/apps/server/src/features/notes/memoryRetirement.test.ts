import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { PREVIEW_CARD_CREATION_TOOL } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

// The standalone Memory server surface and its MCP bridge are retired (#662): the Memory feature, the
// deposit/search/prompt/review MCP tools, and every `/api/memory`/`/api/recall` route are gone. The
// durable model is deliberately KEPT — the `memory_prompts` table, its migrations, and legacy-custom
// reveal reads stay so existing prompts remain reviewable. These structural guards lock both halves in
// place: the retired writers cannot return, and the preserved model cannot be dropped by accident. The
// ONLY MCP surface allowed back is the local card-preview server (#717), which exposes exactly the single
// read-mostly `preview_card_creation` tool and none of the retired descriptors.

function abs(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(abs(relative), "utf8");
}

// Every production server source file (excludes tests), comments stripped, so a scan asserts on real
// code — not on prose that names the very retired surface being guarded.
function productionServerCode(): readonly { readonly path: string; readonly body: string }[] {
  const root = abs("../../");
  const out: { path: string; body: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.ts$/u.test(entry.name) || /\.test\.ts$/u.test(entry.name)) {
        continue;
      }
      const body = readFileSync(full, "utf8")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .replace(/\/\/[^\n]*/gu, "");
      out.push({ body, path: full });
    }
  };
  walk(root);
  return out;
}

describe("standalone Memory server retirement (#662)", () => {
  it("deletes the Memory feature and keeps only the card-preview MCP surface", () => {
    // The Memory feature and its retired MCP bridge are gone. The only MCP surface that may exist is the
    // #717 local card-preview server, and it registers exactly the single read-mostly preview tool.
    expect(existsSync(abs("../memory"))).toBe(false);
    const mcpServer = read("../../mcp/mcpServer.ts");
    expect(mcpServer).toContain(PREVIEW_CARD_CREATION_TOOL);
    expect(PREVIEW_CARD_CREATION_TOOL).toBe("preview_card_creation");
    // The retired Memory MCP bridge module is not resurrected under its old name.
    expect(existsSync(abs("../../mcp/memoryMcpServer.ts"))).toBe(false);
    expect(existsSync(abs("../../mcp/memoryBridge.ts"))).toBe(false);
  });

  it("removes every MCP tool descriptor from production server code", () => {
    const descriptors = [
      "deposit_memory",
      "search_memory",
      "get_memory_prompt",
      "list_due_prompts",
      "record_review"
    ] as const;
    for (const { body } of productionServerCode()) {
      for (const descriptor of descriptors) {
        expect(body).not.toContain(descriptor);
      }
    }
  });

  it("registers no /api/memory, /api/recall, or /memory/notes route", () => {
    for (const { body } of productionServerCode()) {
      expect(body).not.toContain("/api/memory");
      expect(body).not.toContain("/api/recall");
      expect(body).not.toContain("/memory/notes");
    }
  });

  it("creates prompts only as current-note, null-answer rows — never a new legacy_custom writer", () => {
    // The one prompt inserter writes a current-note prompt with both answer projections null; a live
    // session can never mint a legacy_custom prompt (those exist only as preserved historical rows).
    const noteCommands = read("./noteCommands.ts").replace(/\/\/[^\n]*/gu, "");
    expect(noteCommands).toMatch(
      /insertCurrentNotePromptInTx[\s\S]*?revealKind:\s*"current_note"/u
    );
    expect(noteCommands).toMatch(/insertCurrentNotePromptInTx[\s\S]*?answerDoc:\s*null/u);
    expect(noteCommands).toMatch(/insertCurrentNotePromptInTx[\s\S]*?answerText:\s*null/u);
    // No production code writes a legacy_custom prompt (the object-literal INSERT form). Reads that
    // reveal preserved rows use `eq(...revealKind, "legacy_custom")` and are intentionally allowed.
    for (const { body } of productionServerCode()) {
      expect(body).not.toContain('revealKind: "legacy_custom"');
    }
  });

  it("preserves the memory_prompts model and its migrations for existing prompts", () => {
    const schema = read("../../db/schema.ts");
    // The table is retained (not renamed/dropped) so legacy prompts keep resolving on the shared schedule.
    expect(schema).toMatch(/export const memoryPrompts = pgTable\(\s*"memory_prompts"/u);
    // The historical migrations that established the table are not deleted.
    const migrations = readdirSync(abs("../../db/migrations")).filter((name) =>
      name.endsWith(".sql")
    );
    expect(migrations.length).toBeGreaterThan(0);
  });
});
