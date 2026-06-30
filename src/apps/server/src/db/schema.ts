import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core";

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
    language: text("language", { enum: ["zh-CN", "zh-TW", "en"] as const }).notNull(),
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

// Decomposed ProseMirror/Tiptap block rows (#311): one row per top-level PM node of a chapter's
// fidelity-ingested document, keyed by the node's stable id (from `assignNodeIds`). `node_json`
// carries that PM node (with its nested stable ids). The reader renders these PM blocks via
// `@tiptap/static-renderer` (#312). Written alongside `blocks` (dual-write) by EPUB ingestion; the
// Markdown path writes none yet. Each row is also a first-class `entries` row (`type: "block"`)
// linked under its reading unit (a `contains` `entry_links` edge), so a PM block id is an
// addressable anchor: notes / reading positions FK to it and locate / note-listing resolve it
// through the shared `addressableBlocks` union, exactly as for a legacy `blocks` row (#312).
export const docBlocks = pgTable(
  "doc_blocks",
  {
    id: text("id").primaryKey(),
    nodeJson: jsonb("node_json").notNull(),
    orderIndex: integer("order_index").notNull(),
    // The block's plaintext (the in-order concatenation of its PM node's descendant text), so a PM
    // `doc_blocks` id is a first-class addressable block: notes and reading positions anchor to it and
    // search/locate read its text, exactly as for a legacy `blocks` row (#312).
    plaintext: text("plaintext").notNull(),
    readingUnitEntryId: text("reading_unit_entry_id")
      .notNull()
      .references(() => entries.id),
    type: text("type").notNull(),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [
    index("doc_blocks_reading_unit_idx").on(table.readingUnitEntryId),
    index("doc_blocks_work_idx").on(table.workEntryId)
  ]
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
    alt: text("alt"),
    // The host element's id at ingest, an in-work cross-reference target (e.g. a figure or heading id)
    // so a same-work `#id` link resolves to this block (#252). Null when the source had no id.
    anchorId: text("anchor_id"),
    // A footnote/endnote block's back-link: the anchor id of the marker (noteref) that points here, so
    // the reader renders a jump-back affordance (#250). Null on ordinary blocks.
    backlinkAnchorId: text("backlink_anchor_id"),
    blockType: text("block_type", {
      enum: ["paragraph", "heading", "list", "blockquote", "code", "table", "figure"] as const
    }).notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    imageResourceId: text("image_resource_id"),
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
  // Creation time, so reading-capture recency is a durable signal (#243): note ids are uuids, not
  // time-ordered, so the harvest must order by this, not by id.
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  markdownBody: text("markdown_body").notNull(),
  // Null for a mark-only highlight (a "Gem", #255): a one-tap highlight with no template/body that
  // reuses the note anchor + overlap + delete model. A templated note references a seeded template.
  templateId: text("template_id").references(() => noteTemplates.id),
  // The owning user (the v0 default identity). Notes are user-owned personal data — stamped on
  // create from the current-user provider and filtered by on read (PRODUCT.md "Identity & ownership").
  userId: text("user_id").notNull()
});

// Per-user, per-work reading position: the reading unit the reader last had open and a
// best-effort topmost-visible block anchor within it, so reopening a work resumes where the
// reader left off — durably on the server (it survives a localStorage clear, a new browser, or a
// different device, and the server is the source of truth). One row per (user, work), enforced by
// the composite primary key. `anchor_block_entry_id` is nullable: null means the top of the unit.
export const readingPositions = pgTable(
  "reading_positions",
  {
    anchorBlockEntryId: text("anchor_block_entry_id").references(() => entries.id),
    unitEntryId: text("unit_entry_id")
      .notNull()
      .references(() => entries.id),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    userId: text("user_id").notNull(),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [primaryKey({ columns: [table.userId, table.workEntryId] })]
);

// Per-user reader preferences (work-independent): text size and Day/Night theme, server-owned so they
// restore on any device. One row per user (current user = DEFAULT_USER_ID in v0). Designed to grow —
// new settings join as columns, no new endpoint. `updated_at` records the last change.
export const readerPreferences = pgTable("reader_preferences", {
  readingSize: text("reading_size").notNull(),
  theme: text("theme").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  userId: text("user_id").primaryKey()
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
    // The end block of a (possibly cross-block) note span (#257); equals `block_entry_id` for a
    // single-block note. `start_offset` is on the start block, `end_offset` on the end block.
    endBlockEntryId: text("end_block_entry_id")
      .notNull()
      .references(() => entries.id),
    endOffset: integer("end_offset"),
    noteEntryId: text("note_entry_id")
      .primaryKey()
      .references(() => entries.id),
    selectedText: text("selected_text").notNull(),
    startOffset: integer("start_offset")
  },
  (table) => [index("note_anchors_block_idx").on(table.blockEntryId)]
);

// The authored content substrate for the language coach (#205): a map of everyday-life domains, each
// holding cases (a situation + communicative function), each carrying a chunk inventory (the native
// phrasings to practise). This is SHARED content (no owner, like works/blocks); it is seeded from the
// domain's canonical corpus on boot. Per-user mastery is never stored here — it is computed from the
// recall store (#189) via `recall_items.chunk_id`.
export const domains = pgTable("domains", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Frequency / importance weight in [0, 1].
  weight: doublePrecision("weight").notNull(),
  orderIndex: integer("order_index").notNull()
});

export const cases = pgTable(
  "cases",
  {
    communicativeFunction: text("communicative_function").notNull(),
    domainId: text("domain_id")
      .notNull()
      .references(() => domains.id),
    id: text("id").primaryKey(),
    orderIndex: integer("order_index").notNull(),
    situation: text("situation").notNull(),
    // Lifecycle status (#209): seeded and accepted cases are `active` (the default, so existing/seed
    // rows are active); LLM-authored cases land as `needs_review` until a curator accepts/edits them.
    status: text("status", { enum: ["needs_review", "active"] as const })
      .notNull()
      .default("active"),
    // Deterministic key of the authoring brief that produced this case (#209), so re-requesting the
    // same brief reuses the cached case instead of calling the model again. Null for seeded cases;
    // unique among authored cases.
    briefKey: text("brief_key")
  },
  (table) => [
    index("cases_domain_idx").on(table.domainId),
    uniqueIndex("cases_brief_key_idx").on(table.briefKey)
  ]
);

export const chunks = pgTable(
  "chunks",
  {
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    gloss: text("gloss"),
    id: text("id").primaryKey(),
    orderIndex: integer("order_index").notNull(),
    // The reading block this chunk was harvested from (#243), so a round seeded from reading deposits
    // recall items linked back to the source block. Null for authored/seed chunks.
    sourceBlockEntryId: text("source_block_entry_id").references(() => entries.id),
    text: text("text").notNull(),
    usageNote: text("usage_note")
  },
  (table) => [index("chunks_case_idx").on(table.caseId)]
);

// A recall item: a pattern / idiom / proverb / chunk / word / phrase the learner wants to
// remember, carrying its SM-2 review state inline (one state per item) and an optional link into
// the content graph (`provenance_entry_id` -> a source note or block when it came from reading;
// null when jotted or LLM-supplied). User-owned personal data, like notes and reading position —
// stamped with `user_id` on enroll and filtered by it on read.
export const recallItems = pgTable(
  "recall_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind", {
      enum: ["pattern", "idiom", "proverb", "chunk", "word", "phrase"] as const
    }).notNull(),
    text: text("text").notNull(),
    gloss: text("gloss"),
    provenanceEntryId: text("provenance_entry_id").references(() => entries.id),
    // Optional link to the practice chunk (#205) this item is recalling, so jots / reading captures
    // attach to a case. Null when the item is not tied to the authored corpus. Per-case mastery is
    // computed by joining a user's items to a case's chunks through this column.
    chunkId: text("chunk_id").references(() => chunks.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    // Inlined SM-2 ReviewState (@whetstone/domain): ease, interval (days), streak, lapses, and the
    // last-reviewed (null until first review) / due timestamps. `due_at` is indexed with the user
    // so `listDue` is a cheap range scan.
    easeFactor: doublePrecision("ease_factor").notNull(),
    intervalDays: integer("interval_days").notNull(),
    repetitions: integer("repetitions").notNull(),
    lapses: integer("lapses").notNull(),
    lastReviewedAt: timestamp("last_reviewed_at", { mode: "date", withTimezone: true }),
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }).notNull()
  },
  (table) => [
    index("recall_items_user_due_idx").on(table.userId, table.dueAt),
    index("recall_items_user_idx").on(table.userId)
  ]
);

// The append-only review log: one row per recorded review (the grade and when), so a recall item's
// history is auditable independently of its current (overwritten) review state.
export const recallReviews = pgTable(
  "recall_reviews",
  {
    id: text("id").primaryKey(),
    recallItemId: text("recall_item_id")
      .notNull()
      .references(() => recallItems.id),
    grade: integer("grade").notNull(),
    reviewedAt: timestamp("reviewed_at", { mode: "date", withTimezone: true }).notNull()
  },
  (table) => [index("recall_reviews_item_idx").on(table.recallItemId)]
);

// The learner model (#208) — user-owned personal data, like notes and recall. Three tables: the
// categorized error-pattern store, the deposited turn outcomes, and the rolling profile. Enum literals
// mirror `@whetstone/domain` (`learnerModel.ts`); duplicated so migration generation does not depend
// on the domain package being built first.

// Per-user categorized recurring errors with frequency (`count`) and recency (`last_seen_at`). One row
// per (user, category) — a deposited turn with that category increments the count and bumps recency.
export const errorPatterns = pgTable(
  "error_patterns",
  {
    category: text("category", {
      enum: [
        "article_drop",
        "l1_calque",
        "wrong_collocation",
        "register",
        "word_order",
        "tense_aspect",
        "other"
      ] as const
    }).notNull(),
    count: integer("count").notNull(),
    lastSeenAt: timestamp("last_seen_at", { mode: "date", withTimezone: true }).notNull(),
    userId: text("user_id").notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.category] })]
);

// The append-only log of deposited turn outcomes: the grade, the chunk practised (if any), and the
// diagnosed error category (if any). Recent outcomes for the compiled context come from here.
export const turnOutcomes = pgTable(
  "turn_outcomes",
  {
    chunkId: text("chunk_id").references(() => chunks.id),
    errorCategory: text("error_category", {
      enum: [
        "article_drop",
        "l1_calque",
        "wrong_collocation",
        "register",
        "word_order",
        "tense_aspect",
        "other"
      ] as const
    }),
    grade: integer("grade").notNull(),
    id: text("id").primaryKey(),
    recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).notNull(),
    userId: text("user_id").notNull()
  },
  (table) => [index("turn_outcomes_user_recorded_idx").on(table.userId, table.recordedAt)]
);

// The rolling, periodically-distilled profile: one row per user (level, focus, a phrased summary, and
// the structured strengths/weaknesses lists), recomputed from outcomes.
export const learnerProfiles = pgTable("learner_profiles", {
  focus: text("focus").notNull(),
  level: text("level", {
    enum: ["beginner", "elementary", "intermediate", "advanced"] as const
  }).notNull(),
  strengthsJson: jsonb("strengths_json").notNull(),
  summary: text("summary").notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull(),
  userId: text("user_id").primaryKey(),
  weaknessesJson: jsonb("weaknesses_json").notNull()
});

// A finished practice session's summary (#211): one row per ended session, user-scoped. The per-turn
// deposits live in recall (#189) and `turn_outcomes` (#208); this records the session recap that is
// shown to the learner and kept for history.
export const sessionSummaries = pgTable(
  "session_summaries",
  {
    averageGrade: doublePrecision("average_grade").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    errorCountsJson: jsonb("error_counts_json").notNull(),
    id: text("id").primaryKey(),
    strongTurns: integer("strong_turns").notNull(),
    turnCount: integer("turn_count").notNull(),
    userId: text("user_id").notNull()
  },
  (table) => [index("session_summaries_user_idx").on(table.userId, table.createdAt)]
);

// The append-only conversational exchange of a live coaching call (#220): one row per turn the learner
// or coach spoke, user-owned and scoped to the case the call is set in. The server reconstructs the
// conversation history from these rows (ordered by `order_index`, which is monotonic per user+case and
// stable under a fixed clock) so the client only sends the latest line. `repair_json` records the
// coach's light-repair signal on a breakdown turn (null otherwise). No per-turn grade lives here —
// grading is the end-of-round job (#222).
export const sessionExchanges = pgTable(
  "session_exchanges",
  {
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    id: text("id").primaryKey(),
    orderIndex: integer("order_index").notNull(),
    // The English share of a user turn (#270): the bilingual-dial level signal, recorded per turn so
    // the trend can be read over rounds. Null on coach turns.
    englishShare: doublePrecision("english_share"),
    // The one English chunk the bilingual coach pushed for the learner to retry (#270), recorded on
    // the coach turn so it can be deposited as recall practice at end of round. Null otherwise.
    englishTarget: text("english_target"),
    repairJson: jsonb("repair_json"),
    role: text("role", { enum: ["user", "coach"] as const }).notNull(),
    text: text("text").notNull(),
    userId: text("user_id").notNull()
  },
  (table) => [
    index("session_exchanges_user_case_idx").on(table.userId, table.caseId, table.orderIndex)
  ]
);

// The voice diary (#246): one tidied entry per row, filed under the local day it was captured. This IS
// the coach-readable learner-history facet for diary capture (un-anchored, any language) — persisted and
// queryable by user. `entry_date` is the `YYYY-MM-DD` day (the server computes "today" at create);
// `created_at` is the capture instant (timeline order within a day); `text` is the tidied entry;
// `language` is the free-form detected/provided language (null when unknown in v0). User-owned: stamped
// on create and filtered on every read. Indexed on (user, day) for the day-grouped Timeline and the
// date-jump calendar's range scans.
export const diaryEntries = pgTable(
  "diary_entries",
  {
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    entryDate: text("entry_date").notNull(),
    id: text("id").primaryKey(),
    language: text("language"),
    text: text("text").notNull(),
    userId: text("user_id").notNull()
  },
  (table) => [index("diary_entries_user_date_idx").on(table.userId, table.entryDate)]
);

// Per-chunk nudge interaction state (#245): the lightweight, user-owned record behind the
// reading->practice nudge. The ranking is derived LIVE each time from the user's recent captures; only
// this interaction state is persisted. One row per (user, chunk). `dismissed_until` is the cooldown
// horizon a dismiss sets (the chunk is suppressed while `now < dismissed_until`); `last_surfaced_at`
// records when the nudge was last shown. `chunk_id` is intentionally NOT a FK to `chunks`: a fresh
// capture can be dismissed by its prospective harvest chunk id before any `chunks` row exists.
export const nudgeState = pgTable(
  "nudge_state",
  {
    chunkId: text("chunk_id").notNull(),
    dismissedUntil: timestamp("dismissed_until", { mode: "date", withTimezone: true }),
    lastSurfacedAt: timestamp("last_surfaced_at", { mode: "date", withTimezone: true }),
    userId: text("user_id").notNull()
  },
  (table) => [primaryKey({ columns: [table.userId, table.chunkId] })]
);
