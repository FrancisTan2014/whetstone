import { index, pgTable, text } from "drizzle-orm/pg-core";

// The Drizzle schema is the database contract. Enum literals mirror the domain
// model (`entryTypes`, `workTypes`); they are duplicated here so migration
// generation does not depend on the domain package being built first.
export const entries = pgTable("entries", {
  id: text("id").primaryKey(),
  type: text("type", { enum: ["work", "reading_unit", "note"] as const }).notNull()
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
