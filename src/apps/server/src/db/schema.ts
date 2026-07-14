import { sql } from "drizzle-orm";
import {
  check,
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
  // `toc_entry` (#379): a nav-derived table-of-contents entry is a first-class addressable Entry, like
  // a work/reading unit/block, so the authored nav tree persists as its own `toc_entries` rows keyed
  // by an `entries` id (mirroring how reading units register entries).
  type: text("type", {
    enum: [
      "work",
      "reading_unit",
      "block",
      "note",
      "toc_entry",
      "diary_entry",
      "recitation_plan",
      "recitation_passage",
      "recitation_whole_work",
      "memory_note",
      "memory_prompt"
    ] as const
  }).notNull()
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
    // The unit's source-file identity: the EPUB spine item href this unit was ingested from (null for
    // Markdown/PDF, which have no per-unit source file). Scopes an anchor to (source_file, anchor_id)
    // so a reused anchor id in different chapters resolves per-file, and lets the reader's work-scoped
    // reference resolver jump cross-unit (#366).
    sourceFile: text("source_file"),
    title: text("title"),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("reading_units_work_idx").on(table.workEntryId)]
);

// The work's authored navigation tree (#379): one row per EPUB nav entry (`nav.xhtml`/`toc.ncx`),
// persisted as an additive structure that points into reading units at anchors. Each row is also a
// first-class `entries` row (`type: "toc_entry"`) so the entry is addressable. `parent_entry_id`
// (an `entries` id, null at the root) plus `depth` capture the authored hierarchy, and `order_index`
// is a work-global pre-order rank so serving the rows in `order_index` order yields the tree fully
// expanded and correctly indented. `target_source_file` is the entry href resolved (relative to the
// nav document) to a spine source-file identity — matched to `reading_units.source_file` at serve time
// — and `target_anchor` is the href's `#fragment` (both null for a label-only/structural entry). The
// nav tree has more entries than units (a chapter's sub-sections share one spine file), so it is a
// separate structure, never a relabeling of units. Fail-soft: a work with no authored nav has no rows.
export const tocEntries = pgTable(
  "toc_entries",
  {
    depth: integer("depth").notNull(),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    label: text("label").notNull(),
    orderIndex: integer("order_index").notNull(),
    parentEntryId: text("parent_entry_id").references(() => entries.id),
    targetAnchor: text("target_anchor"),
    targetSourceFile: text("target_source_file"),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("toc_entries_work_idx").on(table.workEntryId)]
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
    // The block's source-HTML id at ingest (a figure/heading/paragraph id, an in-work cross-reference
    // target), lifted off the PM node so the node JSON stays pure content (#366). Keyed with the unit's
    // `source_file` it forms the work anchor index a cross-reference resolves through. Null when the
    // source element had no id; mirrors the legacy `blocks.anchor_id` column.
    anchorId: text("anchor_id"),
    // The complete per-block map from every id-bearing source element inside this block to the stable
    // PM node id that carries it: `[{ anchor: <sourceHtmlId>, nodeId: <pmNodeId> }, ...]`. Ingestion
    // used to lift only the top-level block's own id onto `anchor_id`, dropping every id nested inside
    // a container block, so a cross-reference to a nested target had nothing to resolve against. This
    // column keeps all of them, forming the complete work anchor index a reference resolves through,
    // and the node id gives element-precise jump within the block (#550). The block's own top-level id
    // (when present) is the first entry, with `nodeId === id`. Never null: empty when the block bears
    // no ids. Kept separate from `node_json` so the stored node stays pure render content (#366).
    anchors: jsonb("anchors")
      .notNull()
      .default(sql`'[]'::jsonb`),
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
      enum: ["contains", "annotates", "references", "related_to", "derived_from"] as const
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
// answers keyed by template field id; `markdown_body` is the rendered note body. Ownership and
// chronology (owner, occurredAt, createdAt, updatedAt) live in the shared `personal_entries` facet
// (#571) — a note is a personal (owned) Entry, so it carries a `personal_entries` row and this table
// stays a pure content facet.
export const notes = pgTable("notes", {
  answersJson: jsonb("answers_json").notNull(),
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  markdownBody: text("markdown_body").notNull(),
  // Null for a mark-only highlight (a "Gem", #255): a one-tap highlight with no template/body that
  // reuses the note anchor + overlap + delete model. A templated note references a seeded template.
  templateId: text("template_id").references(() => noteTemplates.id)
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

// A learner's recitation routine adopted from a source Work (#577): a first-class owned Entry whose
// ownership + chronology live in the shared `personal_entries` facet (so it appears on the logical
// Timeline and is owner-scoped). `work_entry_id` references the source Work — its content stays canonical
// and is never copied into a second store. `phase` is the learner-controlled routine stage
// (familiarizing → learning → maintenance), only ever changed by an explicit learner action (whetstone
// never infers readiness or auto-advances). `last_session_at` and `session_count` are the lightweight
// per-session routine state: they are updated in place on each reading session and are NOT Entries and do
// NOT feed FSRS, so a familiarizing session never creates a Timeline row or a review card. The reader's
// resume position is delegated to `reading_positions` (per user, per work), so it is not duplicated here.
export const recitationPlans = pgTable(
  "recitation_plans",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    lastSessionAt: timestamp("last_session_at", { mode: "date", withTimezone: true }),
    phase: text("phase", {
      enum: ["familiarizing", "learning", "maintenance"] as const
    }).notNull(),
    sessionCount: integer("session_count").notNull().default(0),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id)
  },
  (table) => [index("recitation_plans_work_idx").on(table.workEntryId)]
);

// A recitation passage (#578): a contiguous, learner-editable source range of a recitation Work that is
// practised and scheduled as one unit. Each passage is an addressable Entry linked to its plan and to
// its exact source range (mirroring `note_anchors`: start offset on the start block, end offset on the
// end block; equal block ids for a single-block passage). A passage has NO `personal_entries` row of its
// own — it is owned transitively through its plan's `personal_entries` row, so passages never surface on
// the Timeline. Scheduling truth is NOT stored here (#618): a passage is *active* iff `introduced_at` is
// non-null AND it owns a `review_cards` row keyed by its `entry_id` (the shared substrate holds its FSRS
// state); it is *queued* otherwise (introduced_at null, no card). `source_text` is the exact anchored
// snapshot used for the hidden target, cue derivation, and re-anchoring; `anchor_status` flips to
// `needs_repair` when the source drifts beyond a safe relocate, so stale text is never silently practised.
export const recitationPassages = pgTable(
  "recitation_passages",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    planEntryId: text("plan_entry_id")
      .notNull()
      .references(() => recitationPlans.entryId),
    orderIndex: integer("order_index").notNull(),
    startBlockEntryId: text("start_block_entry_id")
      .notNull()
      .references(() => entries.id),
    startOffset: integer("start_offset").notNull(),
    endBlockEntryId: text("end_block_entry_id")
      .notNull()
      .references(() => entries.id),
    endOffset: integer("end_offset").notNull(),
    sourceText: text("source_text").notNull(),
    contextSnapshot: text("context_snapshot").notNull(),
    anchorStatus: text("anchor_status", {
      enum: ["anchored", "needs_repair"] as const
    }).notNull(),
    // The learner's remembered visual support level for progressive fading (#579): how much of the
    // target is shown before an attempt. Learner-controlled only — never auto-lowered by elapsed days or
    // AI judgement — and independent of the FSRS schedule (changing it is not a review).
    supportLevel: text("support_level", {
      enum: ["full", "reduced", "first", "hidden"] as const
    })
      .notNull()
      .default("full"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    // The passage lifecycle (#605/#618): `introduced_at` is null while the passage is *queued*
    // (introduced, awaiting activation) and non-null once it is *active*. An active passage owns a
    // `review_cards` row keyed by its `entry_id`; a queued passage owns none. The FSRS state itself lives
    // in the shared substrate, never inlined here.
    introducedAt: timestamp("introduced_at", { mode: "date", withTimezone: true })
  },
  (table) => [index("recitation_passages_plan_order_idx").on(table.planEntryId, table.orderIndex)]
);

// Recitation-owned review evidence (#618): keyed one-to-one to a shared `review_events` row, it preserves
// the `cue_strength` the learner attempted a passage from (the preceding line, or a cold opening). Only
// Recitation writes and reads it — chaining/eligibility queries consult cue strength here; the generic
// scheduler never interprets it. A whole-Work aggregate rating writes no evidence (cue strength is a
// passage-level notion). It references `review_events`, so it is torn down with a passage's events.
export const recitationReviewEvidence = pgTable("recitation_review_evidence", {
  reviewEventId: text("review_event_id")
    .primaryKey()
    .references(() => reviewEvents.id),
  cueStrength: text("cue_strength", {
    enum: ["preceding_line", "opening"] as const
  }).notNull()
});

// A contiguous chain session (#580): a rehearsal of the transitions across the owned prefix's passages
// [0..end_order_index], in fixed source order with none skipped. It is NOT an Entry — it has no
// `personal_entries` row and never surfaces on the Timeline; it is owned transitively through its plan.
// At most one chain per plan is `active` at a time (enforced in the command layer); completing it stamps
// `completed_at`. A clean run rates nothing; only a passage the learner identifies as broken is failed.
export const recitationChains = pgTable(
  "recitation_chains",
  {
    id: text("id").primaryKey(),
    planEntryId: text("plan_entry_id")
      .notNull()
      .references(() => recitationPlans.entryId),
    endOrderIndex: integer("end_order_index").notNull(),
    status: text("status", { enum: ["active", "completed"] as const }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true })
  },
  (table) => [index("recitation_chains_plan_idx").on(table.planEntryId, table.status)]
);

// The whole-Work maintenance target for a plan (#580/#618): a dedicated `recitation_whole_work` Entry
// (`entry_id`) that measures the learner's upkeep of the entire Work, SEPARATE from every passage target
// (they measure different retrieval tasks). Its schedule lives in the shared substrate — a `review_cards`
// row keyed by this `entry_id` — never inlined here. `plan_entry_id` is the unique plan relationship; the
// plan links to this target with the existing `contains` relation in `entry_links`. At most one row per
// plan. The target Entry is owned transitively through its plan and has NO `personal_entries` row, so it
// never surfaces on the Timeline. A whole-Work lapse reschedules only this aggregate card; it never
// resets the passage cards.
export const recitationWholeWork = pgTable("recitation_whole_work", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  planEntryId: text("plan_entry_id")
    .notNull()
    .unique()
    .references(() => recitationPlans.entryId),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
});

// Per-user reader preferences (work-independent): text size and Day/Night theme, server-owned so they
// restore on any device. One row per user (current user = DEFAULT_USER_ID in v0). Designed to grow —
// new settings join as columns, no new endpoint. `timezone` is the learner's IANA calendar-day zone
// (#606), nullable until first-use defaulting persists the browser's resolved zone. `updated_at` records
// the last change.
export const readerPreferences = pgTable("reader_preferences", {
  readingSize: text("reading_size").notNull(),
  theme: text("theme").notNull(),
  timezone: text("timezone"),
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

// The `domains`/`cases`/`chunks` tables (#205) are RETAINED after the coach-led Practice retirement
// (#603) as the temporary owner of Memory provenance: `memory_prompts.chunk_id` still references
// `chunks.id`, so a scheduled Memory prompt harvested from a practice chunk keeps its provenance and
// its FSRS state stays derivable by chunk. Practice no longer writes these tables (they are seeded but
// otherwise inert); a later issue may migrate the surviving provenance off `chunk_id` and drop them.
// This is SHARED content (no owner, like works/blocks). Per-user mastery is never stored here — it is
// computed from the recall store (#189) via `recall_items.chunk_id`.
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

// A Memory note (#595): the durable retention target as a first-class owned Entry. `body_doc` is the
// canonical rich ProseMirror/Tiptap document; `body_text` is its readable plaintext projection
// (`documentReadableText`) kept for preview/search. `capture_source` records how it was captured.
// Ownership + chronology live in the shared `personal_entries` facet (like notes/diary), so the note
// appears exactly once on the logical Timeline; provenance to the source it came from is a
// `derived_from` row in `entry_links` (not a column). Keyed by the owning Entry.
export const memoryNotes = pgTable("memory_notes", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  bodyDoc: jsonb("body_doc").notNull(),
  bodyText: text("body_text").notNull(),
  captureSource: text("capture_source", {
    enum: ["manual", "reader", "import", "practice", "tool"] as const
  }).notNull()
});

// A Memory prompt (#595, #617): one independently reviewable retrieval direction under a note.
// `note_entry_id` is its owning note (the note carries the `personal_entries` row, so the prompt inherits
// ownership transitively and never gets a Timeline row of its own — the note→prompt edge is also recorded
// in `entry_links` as `contains`). `cue_doc`/`answer_doc` are the rich bodies, with `cue_text`/`answer_text`
// their readable projections. `lifecycle` records content completeness: `draft` (no revealable answer, so
// `answer_doc`/`answer_text` are NULL) or `ready` (a revealable answer). Scheduling state is NOT stored
// here anymore — enrollment and FSRS state live in the shared `review_cards` substrate keyed by this
// prompt's `entry_id` (#617). `chunk_id` optionally links the direction to a practice chunk (#205),
// retained Memory provenance after the Practice retirement (#603).
export const memoryPrompts = pgTable(
  "memory_prompts",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    noteEntryId: text("note_entry_id")
      .notNull()
      .references(() => entries.id),
    cueDoc: jsonb("cue_doc").notNull(),
    cueText: text("cue_text").notNull(),
    answerDoc: jsonb("answer_doc"),
    answerText: text("answer_text"),
    lifecycle: text("lifecycle", { enum: ["draft", "ready"] as const }).notNull(),
    // Temporary retained Memory-provenance link (#603): optionally ties a prompt to the practice chunk
    // (#205) it was harvested from. Retained until a later issue migrates provenance off `chunk_id` and
    // drops `domains`/`cases`/`chunks`.
    chunkId: text("chunk_id").references(() => chunks.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("memory_prompts_note_idx").on(table.noteEntryId),
    index("memory_prompts_chunk_idx").on(table.chunkId)
  ]
);

// The shared review-card substrate (#617): the single owner of scheduling state for ANY reviewable
// target. Keyed one-to-one by `target_entry_id` (an `entries.id`), so a target has a card iff it is
// enrolled for review — a target with no row is not enrolled. `user_id` is the owner; `status` is
// `active` (surfaced in the due scan) or `paused` (retained but withheld). `requested_retention` is the
// resolved scheduling policy the seeding caller chose (review-time code reads it here, never switching
// on the target's feature). Every `@whetstone/domain` `ReviewState` field is stored NOT NULL — a card is
// complete, never a partial FSRS state — except `last_reviewed_at`, which is legitimately null until the
// first review. This table depends only on `entries`; it never references Memory or Recitation.
export const reviewCards = pgTable(
  "review_cards",
  {
    targetEntryId: text("target_entry_id")
      .primaryKey()
      .references(() => entries.id),
    userId: text("user_id").notNull(),
    status: text("status", { enum: ["active", "paused"] as const }).notNull(),
    requestedRetention: doublePrecision("requested_retention").notNull(),
    stability: doublePrecision("stability").notNull(),
    difficulty: doublePrecision("difficulty").notNull(),
    elapsedDays: integer("elapsed_days").notNull(),
    scheduledDays: integer("scheduled_days").notNull(),
    learningSteps: integer("learning_steps").notNull(),
    reps: integer("reps").notNull(),
    lapses: integer("lapses").notNull(),
    state: text("state", { enum: ["new", "learning", "review", "relearning"] as const }).notNull(),
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }).notNull(),
    lastReviewedAt: timestamp("last_reviewed_at", { mode: "date", withTimezone: true }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("review_cards_owner_status_due_idx").on(table.userId, table.status, table.dueAt)
  ]
);

// The append-only review-event log (#617): one row per scheduler transition on a target, keyed by the
// same `target_entry_id` that identifies its card, so the history outlives any single card (it survives
// a restart that re-seeds the card, and an unenroll that drops it). Discriminated by `type`: a `rating`
// event carries the learner's FSRS `rating`; a `reset` event records an explicit schedule restart and
// carries no rating. `occurred_at` is the review/restart instant. Reveal, snooze, pause, and resume write
// no event. The `review_events_type_ck` check keeps the discriminant honest (rating ⇒ rating set, reset
// ⇒ rating null). It references `entries`, never Memory or Recitation.
export const reviewEvents = pgTable(
  "review_events",
  {
    id: text("id").primaryKey(),
    targetEntryId: text("target_entry_id")
      .notNull()
      .references(() => entries.id),
    type: text("type", { enum: ["rating", "reset"] as const }).notNull(),
    rating: text("rating", { enum: ["again", "hard", "good", "easy"] as const }),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull()
  },
  (table) => [
    index("review_events_target_idx").on(table.targetEntryId),
    check(
      "review_events_type_ck",
      sql`(${table.type} = 'rating' and ${table.rating} is not null) or (${table.type} = 'reset' and ${table.rating} is null)`
    )
  ]
);

// The shared ownership + chronology facet for personal (owned) Entries (#571): owner and the three
// timestamps a logical Timeline needs — `occurred_at` (when the entry happened, the Timeline sort key),
// `created_at` (when it was captured), and `updated_at` (last edit). Every personal Entry carries exactly
// one row here: BOTH `note` and `diary_entry` types. Shared library Entries (work/reading_unit/block/
// toc_entry) have NO row (they have no owner). The Timeline is derived by querying this facet for the
// current user ordered by `occurred_at` — there is no stored Timeline object. Keyed by the owning Entry.
export const personalEntries = pgTable(
  "personal_entries",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    userId: text("user_id").notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull()
  },
  (table) => [index("personal_entries_user_occurred_idx").on(table.userId, table.occurredAt)]
);

// A diary artifact as a first-class personal Entry (#571): its durable body is a ProseMirror/Tiptap
// document (`body_doc`, edited through the shared rich editor), with `body_text` the readable plaintext
// projection (`documentReadableText(body_doc)`, block-boundary spaces) kept for preview/search. Ownership + chronology live in `personal_entries`;
// this table holds the diary-specific facets. `input_mode` is how it was captured; `raw_audio_path`,
// `raw_transcript` (verbatim STT/typed text before tidy), and `tidied_text` preserve the voice pipeline's
// intermediate representations; `language` is the detected/selected language. `processing_status` is NULL
// for a synchronous typed capture that is ready on write; only the queued voice path carries a status,
// which a single background worker walks `queued -> transcribing -> tidying -> ready` (or `failed`), one
// capture at a time, so the user never waits for STT before recording again (save-first). `failure_reason`
// records why the worker gave up so a `failed` capture can be retried without losing the raw audio.
export const diaryEntries = pgTable("diary_entries", {
  entryId: text("entry_id")
    .primaryKey()
    .references(() => entries.id),
  bodyDoc: jsonb("body_doc").notNull(),
  bodyText: text("body_text").notNull(),
  language: text("language"),
  inputMode: text("input_mode", { enum: ["typed", "voice"] as const }).notNull(),
  rawAudioPath: text("raw_audio_path"),
  rawTranscript: text("raw_transcript"),
  tidiedText: text("tidied_text"),
  processingStatus: text("processing_status", {
    enum: ["queued", "transcribing", "tidying", "ready", "failed"] as const
  }),
  failureReason: text("failure_reason")
});
