import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

// #619 data migration: templated notes (`answers_json` keyed by `note_templates.fields_json`) become a
// single canonical rich `body_doc` + server-derived `body_text`, every null-template Gem becomes a
// bodyless `mark`, and the whole thing aborts loudly rather than losing or inventing content. These
// tests seed the pre-0051 shape (mirroring `fsrsReviewStateMigration.test.ts`) and assert the exact
// transformed body, order, and preserved provenance, plus each fail-loud guard.

const migrationFile = join(
  dirname(fileURLToPath(import.meta.url)),
  "migrations",
  "0051_rich_note_body.sql"
);

async function applyMigrationFile(pglite: PGlite): Promise<void> {
  const sql = await readFile(migrationFile, "utf8");
  for (const statement of sql.split("--> statement-breakpoint")) {
    if (statement.trim().length > 0) {
      await pglite.exec(statement);
    }
  }
}

// The three canonical seeded templates, reproduced from the (now-deleted) domain `noteTemplate.ts` so
// the transform is exercised against their real ids, field order, and labels.
const vocabularyFields = [
  { id: "meaning", label: "Meaning in this context", type: "long_text" },
  { id: "explanation", label: "My explanation or translation", type: "long_text" },
  { id: "memory_hook", label: "Memory hook", type: "short_text" },
  { id: "example", label: "Example I might use", type: "long_text" }
];
const expressionFields = [
  { id: "doing", label: "What the phrase is doing", type: "long_text" },
  { id: "useful", label: "Why it sounds useful", type: "long_text" },
  { id: "imitation", label: "My imitation sentence", type: "long_text" }
];
const thoughtFields = [
  { id: "noticed", label: "What I noticed", type: "long_text" },
  { id: "matters", label: "Why it matters", type: "long_text" },
  { id: "question", label: "Question or connection", type: "long_text" }
];

// Create the pre-0051 subset of the schema the migration reads and rewrites. `withTemplateFk` names the
// FK exactly as Drizzle did (`notes_template_id_note_templates_id_fk`) so step 6's DROP CONSTRAINT
// resolves; the missing-template guard test omits it so a dangling `template_id` can be seeded at all.
async function createPreMigrationSchema(pglite: PGlite, withTemplateFk = true): Promise<void> {
  await pglite.exec(`
    CREATE TABLE entries (id text PRIMARY KEY, type text NOT NULL);
    CREATE TABLE note_templates (
      fields_json jsonb NOT NULL,
      id text PRIMARY KEY,
      name text NOT NULL,
      order_index integer NOT NULL
    );
    CREATE TABLE notes (
      answers_json jsonb NOT NULL,
      entry_id text PRIMARY KEY REFERENCES entries(id),
      markdown_body text NOT NULL,
      template_id text${
        withTemplateFk
          ? ",\n      CONSTRAINT notes_template_id_note_templates_id_fk FOREIGN KEY (template_id) REFERENCES note_templates(id)"
          : ""
      }
    );
    CREATE TABLE note_anchors (
      block_entry_id text NOT NULL REFERENCES entries(id),
      context_snapshot text NOT NULL,
      end_block_entry_id text NOT NULL REFERENCES entries(id),
      end_offset integer,
      note_entry_id text PRIMARY KEY REFERENCES entries(id),
      selected_text text NOT NULL,
      start_offset integer
    );
    CREATE TABLE personal_entries (
      entry_id text PRIMARY KEY REFERENCES entries(id),
      user_id text NOT NULL,
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
  `);
}

async function seedTemplates(pglite: PGlite): Promise<void> {
  await pglite.query(
    `INSERT INTO note_templates (fields_json, id, name, order_index) VALUES
      ($1, 'vocabulary', 'Vocabulary', 0),
      ($2, 'expression', 'Expression / phrase', 1),
      ($3, 'thought', 'Thought / question', 2)`,
    [
      JSON.stringify(vocabularyFields),
      JSON.stringify(expressionFields),
      JSON.stringify(thoughtFields)
    ]
  );
}

async function seedEntry(pglite: PGlite, id: string, type: string): Promise<void> {
  await pglite.query("INSERT INTO entries (id, type) VALUES ($1, $2)", [id, type]);
}

async function seedNote(
  pglite: PGlite,
  entryId: string,
  templateId: string | null,
  answers: unknown
): Promise<void> {
  await pglite.query(
    "INSERT INTO notes (answers_json, entry_id, markdown_body, template_id) VALUES ($1, $2, '', $3)",
    [JSON.stringify(answers), entryId, templateId]
  );
}

async function seedAnchor(
  pglite: PGlite,
  noteEntryId: string,
  blockEntryId: string
): Promise<void> {
  await pglite.query(
    `INSERT INTO note_anchors
       (block_entry_id, context_snapshot, end_block_entry_id, end_offset, note_entry_id, selected_text, start_offset)
       VALUES ($1, 'the quick brown fox', $1, 5, $2, 'quick', 0)`,
    [blockEntryId, noteEntryId]
  );
}

async function seedPersonalEntry(
  pglite: PGlite,
  entryId: string,
  userId: string,
  when: string
): Promise<void> {
  await pglite.query(
    `INSERT INTO personal_entries (entry_id, user_id, occurred_at, created_at, updated_at)
       VALUES ($1, $2, $3, $3, $3)`,
    [entryId, userId, when]
  );
}

function paragraph(text: string): unknown {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

type NoteRow = {
  body_doc: unknown;
  body_text: string | null;
  capture_source: string;
  entry_id: string;
  kind: string;
};

async function noteRow(pglite: PGlite, entryId: string): Promise<NoteRow> {
  const result = await pglite.query<NoteRow>(
    "SELECT body_doc, body_text, capture_source, entry_id, kind FROM notes WHERE entry_id = $1",
    [entryId]
  );
  return result.rows[0] as NoteRow;
}

describe("0051 rich-note-body migration", () => {
  it("migrates templated notes into a canonical body and Gems into marks, preserving provenance", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedTemplates(pglite);

    for (const id of ["block-1", "note-vocab", "note-thought", "note-expr", "note-gem"]) {
      await seedEntry(pglite, id, id === "block-1" ? "block" : "note");
    }

    // A vocabulary note with a blank field (explanation) omitted, CJK, and a multiline answer.
    await seedNote(pglite, "note-vocab", "vocabulary", {
      meaning: "a beast",
      explanation: "   ",
      memory_hook: "棕熊",
      example: "Line one\nLine two"
    });
    // A thought note with an absent middle field (matters) omitted.
    await seedNote(pglite, "note-thought", "thought", {
      noticed: "I noticed X",
      question: "Why?"
    });
    // An expression note with a blank trailing field (useful) omitted and CJK content.
    await seedNote(pglite, "note-expr", "expression", {
      doing: "引出话题",
      useful: "",
      imitation: "我想说"
    });
    // A one-tap bodyless Gem (null template) becomes a mark.
    await seedNote(pglite, "note-gem", null, {});

    // Two notes anchored to the same block/offsets — the anchor is per-note and must survive intact.
    await seedAnchor(pglite, "note-vocab", "block-1");
    await seedAnchor(pglite, "note-thought", "block-1");
    await seedAnchor(pglite, "note-expr", "block-1");
    await seedAnchor(pglite, "note-gem", "block-1");

    await seedPersonalEntry(pglite, "note-vocab", "user-1", "2026-01-02T03:04:05.000Z");
    await seedPersonalEntry(pglite, "note-thought", "user-1", "2026-01-03T03:04:05.000Z");
    await seedPersonalEntry(pglite, "note-expr", "user-2", "2026-01-04T03:04:05.000Z");
    await seedPersonalEntry(pglite, "note-gem", "user-2", "2026-01-05T03:04:05.000Z");

    await expect(applyMigrationFile(pglite)).resolves.toBeUndefined();

    const vocab = await noteRow(pglite, "note-vocab");
    expect(vocab.kind).toBe("note");
    expect(vocab.capture_source).toBe("reader");
    expect(vocab.body_doc).toEqual({
      type: "doc",
      content: [
        paragraph("Meaning in this context"),
        paragraph("a beast"),
        paragraph("Memory hook"),
        paragraph("棕熊"),
        paragraph("Example I might use"),
        paragraph("Line one\nLine two")
      ]
    });
    expect(vocab.body_text).toBe(
      "Meaning in this context a beast Memory hook 棕熊 Example I might use Line one\nLine two"
    );

    const thought = await noteRow(pglite, "note-thought");
    expect(thought.kind).toBe("note");
    expect(thought.body_doc).toEqual({
      type: "doc",
      content: [
        paragraph("What I noticed"),
        paragraph("I noticed X"),
        paragraph("Question or connection"),
        paragraph("Why?")
      ]
    });
    expect(thought.body_text).toBe("What I noticed I noticed X Question or connection Why?");

    const expr = await noteRow(pglite, "note-expr");
    expect(expr.kind).toBe("note");
    expect(expr.body_doc).toEqual({
      type: "doc",
      content: [
        paragraph("What the phrase is doing"),
        paragraph("引出话题"),
        paragraph("My imitation sentence"),
        paragraph("我想说")
      ]
    });
    expect(expr.body_text).toBe("What the phrase is doing 引出话题 My imitation sentence 我想说");

    const gem = await noteRow(pglite, "note-gem");
    expect(gem.kind).toBe("mark");
    expect(gem.body_doc).toBeNull();
    expect(gem.body_text).toBeNull();
    expect(gem.capture_source).toBe("reader");

    // Ownership + chronology (personal_entries) are untouched by the content migration.
    const owners = await pglite.query<{ entry_id: string; user_id: string; occurred_at: Date }>(
      "SELECT entry_id, user_id, occurred_at FROM personal_entries ORDER BY entry_id"
    );
    expect(owners.rows).toEqual([
      {
        entry_id: "note-expr",
        user_id: "user-2",
        occurred_at: new Date("2026-01-04T03:04:05.000Z")
      },
      {
        entry_id: "note-gem",
        user_id: "user-2",
        occurred_at: new Date("2026-01-05T03:04:05.000Z")
      },
      {
        entry_id: "note-thought",
        user_id: "user-1",
        occurred_at: new Date("2026-01-03T03:04:05.000Z")
      },
      {
        entry_id: "note-vocab",
        user_id: "user-1",
        occurred_at: new Date("2026-01-02T03:04:05.000Z")
      }
    ]);

    // The anchors (block ids + offsets + snapshots) are preserved verbatim, one per note.
    const anchors = await pglite.query<{
      note_entry_id: string;
      block_entry_id: string;
      start_offset: number;
      end_offset: number;
      selected_text: string;
    }>(
      "SELECT note_entry_id, block_entry_id, start_offset, end_offset, selected_text FROM note_anchors ORDER BY note_entry_id"
    );
    expect(anchors.rows).toEqual([
      {
        note_entry_id: "note-expr",
        block_entry_id: "block-1",
        start_offset: 0,
        end_offset: 5,
        selected_text: "quick"
      },
      {
        note_entry_id: "note-gem",
        block_entry_id: "block-1",
        start_offset: 0,
        end_offset: 5,
        selected_text: "quick"
      },
      {
        note_entry_id: "note-thought",
        block_entry_id: "block-1",
        start_offset: 0,
        end_offset: 5,
        selected_text: "quick"
      },
      {
        note_entry_id: "note-vocab",
        block_entry_id: "block-1",
        start_offset: 0,
        end_offset: 5,
        selected_text: "quick"
      }
    ]);

    // The template plumbing is gone.
    const templateTable = await pglite.query<{ exists: boolean }>(
      "SELECT to_regclass('public.note_templates') IS NOT NULL AS exists"
    );
    expect(templateTable.rows[0]?.exists).toBe(false);
    const legacyColumn = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'notes' AND column_name = 'template_id'
       ) AS exists`
    );
    expect(legacyColumn.rows[0]?.exists).toBe(false);
  });

  it("aborts when a templated note references a missing template", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite, false);
    await seedTemplates(pglite);
    await seedEntry(pglite, "note-orphan", "note");
    await seedNote(pglite, "note-orphan", "ghost", { meaning: "x" });

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/missing note_templates row/u);
  });

  it("aborts when an answer targets a field id the template does not define", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedTemplates(pglite);
    await seedEntry(pglite, "note-unknown", "note");
    await seedNote(pglite, "note-unknown", "vocabulary", { meaning: "x", bogus: "y" });

    await expect(applyMigrationFile(pglite)).rejects.toThrow(
      /field id its template does not define/u
    );
  });

  it("aborts when a templated note's answers_json is not a JSON object", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedTemplates(pglite);
    await seedEntry(pglite, "note-malformed", "note");
    await seedNote(pglite, "note-malformed", "vocabulary", ["not", "an", "object"]);

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/malformed answers_json/u);
  });

  it("aborts when a templated note has no recoverable non-blank content", async () => {
    const pglite = new PGlite();
    await createPreMigrationSchema(pglite);
    await seedTemplates(pglite);
    await seedEntry(pglite, "note-empty", "note");
    await seedNote(pglite, "note-empty", "vocabulary", { meaning: "   ", explanation: "" });

    await expect(applyMigrationFile(pglite)).rejects.toThrow(/no recoverable non-blank content/u);
  });

  it("applies the whole forward chain and lands the #619 note end-state", async () => {
    const pglite = new PGlite();
    await expect(runMigrations(pglite)).resolves.toBeUndefined();

    const tableExists = async (name: string): Promise<boolean> => {
      const result = await pglite.query<{ exists: boolean }>(
        `SELECT to_regclass('public.${name}') IS NOT NULL AS exists`
      );
      return result.rows[0]?.exists ?? false;
    };
    const columnExists = async (table: string, column: string): Promise<boolean> => {
      const result = await pglite.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_name = $1 AND column_name = $2
         ) AS exists`,
        [table, column]
      );
      return result.rows[0]?.exists ?? false;
    };

    expect(await tableExists("note_templates")).toBe(false);
    expect(await columnExists("notes", "kind")).toBe(true);
    expect(await columnExists("notes", "body_doc")).toBe(true);
    expect(await columnExists("notes", "body_text")).toBe(true);
    expect(await columnExists("notes", "capture_source")).toBe(true);
    expect(await columnExists("notes", "template_id")).toBe(false);
    expect(await columnExists("notes", "answers_json")).toBe(false);
  });
});
