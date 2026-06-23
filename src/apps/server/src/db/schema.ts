import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// The Drizzle schema is the database contract. Enum literals mirror the domain
// model (`entryTypes`, `workTypes`, `blockTypes`, `linkTypes`); they are duplicated
// here so migration generation does not depend on the domain package being built first.
export const entries = pgTable("entries", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["work", "reading_unit", "block", "note"] as const }).notNull()
});

export const authors = pgTable("authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull()
});

export const workMeta = pgTable(
  "work_meta",
  {
    authorId: text("author_id")
      .notNull()
      .references(() => authors.id),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    language: text("language").notNull(),
    title: text("title").notNull(),
    workType: text("work_type", {
      enum: ["book", "essay", "blog_post", "classical_text"] as const
    }).notNull()
  },
  (table) => [index("work_meta_author_idx").on(table.authorId)]
);

// Ordered reading units within a work. The work containment edge is also recorded
// in `entry_links`; `work_entry_id` keeps the per-work ordering scope queryable.
export const readingUnits = pgTable(
  "reading_units",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    orderIndex: integer("order_index").notNull(),
    title: text("title"),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("reading_units_work_idx").on(table.workEntryId)]
);

// Atomic, stably-identified content blocks. `mdast_json` stores the block's mdast
// node for safe rendering/export; `plaintext` backs search. A re-ingestion content
// diff preserves `entry_id` for matched blocks; removed blocks are soft-deleted
// (`deleted_at` set, detached from their reading unit) so existing note anchors stay
// valid while the block is excluded from the reader, search, and export. `work_entry_id`
// records the owning work directly so notes anchored to a soft-deleted (unit-detached)
// block remain addressable for that work.
export const blocks = pgTable(
  "blocks",
  {
    blockType: text("block_type", {
      enum: ["paragraph", "heading", "list", "blockquote", "code"] as const
    }).notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    mdastJson: jsonb("mdast_json").notNull(),
    orderIndex: integer("order_index").notNull(),
    plaintext: text("plaintext").notNull(),
    readingUnitEntryId: text("reading_unit_entry_id").references(() => entries.id),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [
    index("blocks_reading_unit_idx").on(table.readingUnitEntryId),
    index("blocks_work_idx").on(table.workEntryId)
  ]
);

// Typed containment graph between entries (work -> reading unit -> block in v0).
export const entryLinks = pgTable(
  "entry_links",
  {
    fromEntryId: text("from_entry_id")
      .notNull()
      .references(() => entries.id),
    toEntryId: text("to_entry_id")
      .notNull()
      .references(() => entries.id),
    type: text("type", {
      enum: ["contains", "annotates", "references", "related_to"] as const
    }).notNull()
  },
  (table) => [primaryKey({ columns: [table.fromEntryId, table.toEntryId, table.type] })]
);

// Provenance for each ingestion: uploads retain a server-generated file path and
// sha256; manual input retains its source text. The original file name is metadata.
export const workSources = pgTable(
  "work_sources",
  {
    fileName: text("file_name"),
    filePath: text("file_path"),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["manual", "upload"] as const }).notNull(),
    sha256: text("sha256").notNull(),
    sourceText: text("source_text"),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("work_sources_work_idx").on(table.workEntryId)]
);

// v0 note templates, seeded from the domain's canonical definitions. `fields_json`
// stores the ordered field list (id, label, v0 field type); the note editor loads
// these from the API rather than hard-coding them.
export const noteTemplates = pgTable("note_templates", {
  fieldsJson: jsonb("fields_json").notNull(),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  orderIndex: integer("order_index").notNull()
});

// A note is an Entry annotating a source block. `answers_json` holds the structured
// answers keyed by template field id; `markdown_body` is the rendered note body.
export const notes = pgTable("notes", {
  answersJson: jsonb("answers_json").notNull(),
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  markdownBody: text("markdown_body").notNull(),
  templateId: text("template_id")
    .notNull()
    .references(() => noteTemplates.id)
});

// The anchor binds a note to a stable block id, with an optional sub-block character
// offset range and the selected-text / surrounding-context snapshots.
export const noteAnchors = pgTable(
  "note_anchors",
  {
    blockEntryId: text("block_entry_id")
      .notNull()
      .references(() => entries.id),
    contextSnapshot: text("context_snapshot").notNull(),
    endOffset: integer("end_offset"),
    noteEntryId: text("note_entry_id")
      .primaryKey()
      .references(() => entries.id),
    selectedText: text("selected_text").notNull(),
    startOffset: integer("start_offset")
  },
  (table) => [index("note_anchors_block_idx").on(table.blockEntryId)]
);
