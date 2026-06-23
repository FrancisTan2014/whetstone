import { index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const entries = pgTable("entries", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["work", "reading_unit", "note"] as const }).notNull()
});

export const authors = pgTable("authors", {
  id: text("id").primaryKey(),
  name: text("name").notNull()
});

export const workMeta = pgTable("work_meta", {
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
});

export const readingUnitMeta = pgTable(
  "reading_unit_meta",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    markdownFilePath: text("markdown_file_path").notNull(),
    orderIndex: integer("order_index").notNull(),
    title: text("title").notNull(),
    workId: text("work_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("ru_work_order_idx").on(table.workId, table.orderIndex)]
);

export const entryLinks = pgTable(
  "entry_links",
  {
    fromEntryId: text("from_entry_id")
      .notNull()
      .references(() => entries.id),
    linkType: text("link_type", {
      enum: ["contains", "annotates", "references", "related_to"] as const
    }).notNull(),
    toEntryId: text("to_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [
    primaryKey({ columns: [table.fromEntryId, table.toEntryId, table.linkType] }),
    index("el_from_idx").on(table.fromEntryId)
  ]
);
