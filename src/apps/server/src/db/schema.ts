import { index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

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
// node for safe rendering/export; `plaintext` backs search.
export const blocks = pgTable(
  "blocks",
  {
    blockType: text("block_type", {
      enum: ["paragraph", "heading", "list", "blockquote", "code"] as const
    }).notNull(),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    mdastJson: jsonb("mdast_json").notNull(),
    orderIndex: integer("order_index").notNull(),
    plaintext: text("plaintext").notNull(),
    readingUnitEntryId: text("reading_unit_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("blocks_reading_unit_idx").on(table.readingUnitEntryId)]
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
