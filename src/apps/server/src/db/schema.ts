import { sql } from "drizzle-orm";
import {
  check,
  boolean,
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
      "memory_prompt"
    ] as const
  }).notNull()
});

export const authors = pgTable(
  "authors",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // Canonical identity key for a named external author/source (#694): the database Unicode lowercase
    // of the NFKC-cleaned display name, computed by the `author_name_key` SQL function so migration and
    // every runtime writer share one policy. NULL for `self-author:<userId>` rows, which stay distinct
    // owner-keyed "You" identities and are excluded from the unique index below.
    nameKey: text("name_key")
  },
  (table) => [
    uniqueIndex("authors_name_key_unique")
      .on(table.nameKey)
      .where(sql`${table.nameKey} is not null`)
  ]
);

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
    // #724 canonical duplicate-candidate key: a GENERATED STORED column computed by the shared
    // `work_title_key` SQL function (database Unicode lowercase of the NFKC-cleaned title with all Unicode
    // whitespace removed). It is generated — never written by any of the several Work writers — so the key
    // can never desync from the title and Unicode lowercase is never duplicated in JavaScript. Punctuation,
    // symbols, digits, diacritics, and script are preserved so edition/language distinctions survive.
    // Required (the function fails loud on a blank-after-normalization title, so the value is never NULL) but
    // deliberately NON-unique: distinct editions, languages, or authors may share a key — title similarity is
    // candidate evidence, never Work identity, so no uniqueness constraint is placed on it.
    titleKey: text("title_key")
      .notNull()
      .generatedAlwaysAs(sql`work_title_key("title")`),
    workType: text("work_type", {
      enum: ["book", "essay", "blog_post", "classical_text"] as const
    }).notNull(),
    // A Work's explicit content authority and editing policy (#695). `imported` = externally sourced
    // EPUB/PDF/Markdown (replacement/re-ingestion); `manual` = learner-curated source, edited from the
    // Library; `authored` = the learner's own writing, edited from Writing. Required and orthogonal to
    // `work_type`. Mirrors `domain`'s `workOrigins`; duplicated here (like the other enums) so migration
    // generation never depends on the domain package building first.
    origin: text("origin", { enum: ["imported", "manual", "authored"] as const }).notNull(),
    // #703 Work-scoped content concurrency: a monotonic revision that fences canonical block writes for
    // every editable origin, independent of ownership or chronology. The optimistic-concurrency token an
    // editable-Work save/add compares-and-sets (increment only when the loaded value still matches);
    // `personal_entries.updated_at` stays owner chronology, never a second revision truth. Every Work of
    // every origin — including imported Works with no `personal_entries` facet — carries a valid initial
    // revision, so an imported-Work correction command (#762) can reuse the same fence.
    contentRevision: integer("content_revision").notNull().default(0)
  },
  (table) => [
    index("work_meta_author_idx").on(table.authorId),
    // #724 non-unique index over the canonical title key. Duplicate-candidate retrieval prefilters by
    // title-key length (a bounded window that is a complete superset of any fuzzy match), so an index on
    // the key keeps that scan cheap. Non-unique: many Works may legitimately share a title key.
    index("work_meta_title_key_idx").on(table.titleKey),
    // Enforce the closed origin set in the database, not only at the contract boundary, so no writer
    // (or restored dump) can land a Work with an unknown authority.
    check("work_meta_origin_ck", sql`${table.origin} in ('imported', 'manual', 'authored')`),
    // The revision is a non-negative counter; guard it in the database so no writer or restored dump can
    // land a negative token the compare-and-set fence could never match.
    check("work_meta_content_revision_ck", sql`${table.contentRevision} >= 0`)
  ]
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

// The single-owner claim on a set of uploaded bytes (#706). SHA-256 proves source identity: identical
// uploaded bytes are one claim, so re-uploading the same EPUB/Markdown/PDF reopens the owning Work
// instead of creating a duplicate. Only `origin = 'imported'`, `kind = 'upload'` bytes are claimed;
// manual source text never participates. The `sha256` primary key makes the claim race-safe — the
// transaction that creates a Work + its source inserts the claim atomically, so a concurrent loser
// fails the insert, rolls back, and reopens the winner. `work_entry_id` is not unique: one Work can
// own several claims as its uploaded source is revised over time.
export const uploadedSourceClaims = pgTable("uploaded_source_claims", {
  sha256: text("sha256").primaryKey(),
  workEntryId: text("work_entry_id")
    .notNull()
    .references(() => entries.id)
});

// A note is an Entry annotating a source block (#619). `kind` discriminates the two shapes a note row
// can take: a `note` carries a canonical rich ProseMirror/Tiptap document (`body_doc`) plus its
// server-derived readable projection (`body_text`); a `mark` is a one-tap bodyless highlight (a "Gem",
// #255) with both body columns null. `capture_source` records how it was captured (reuses the shared
// capture-source vocabulary; reader captures are `reader`). Ownership and chronology (owner, occurredAt,
// createdAt, updatedAt) live in the shared `personal_entries` facet (#571) — a note is a personal
// (owned) Entry, so it carries a `personal_entries` row and this table stays a pure content facet.
export const notes = pgTable(
  "notes",
  {
    bodyDoc: jsonb("body_doc"),
    bodyText: text("body_text"),
    captureSource: text("capture_source", {
      enum: ["manual", "reader", "import", "practice", "tool"] as const
    }).notNull(),
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    kind: text("kind", { enum: ["note", "mark"] as const }).notNull(),
    // The SHA-256 (hex) of the note body's canonical semantic projection (#711): a deterministic
    // lookup accelerator for "is this the same material?", derived server-side and kept in sync only
    // in the single note insert/update boundary. Deliberately NON-UNIQUE — it is only an accelerator,
    // never product identity, so a collision retrieves both rows and full projected-value equality
    // decides. A `note` always carries one; a `mark` (bodyless) carries none.
    materialFingerprint: text("material_fingerprint"),
    // The relaxed near-match key of the note body (#713): the note material NFKC-normalized, with
    // renderer-equivalent quotes/apostrophes/dashes collapsed, whitespace collapsed, and ASCII case
    // folded — the length-banded lookup accelerator for "is this very similar prose?". Like the exact
    // fingerprint it is derived server-side in the single note write boundary and is NEVER product
    // identity: the full guarded projection recomputed from the body decides a candidate. It is NULL
    // for a bodyless `mark` AND for a `note` whose material is UNSUPPORTED for fuzzy matching (a single
    // word, non-ASCII/mixed scripts, links/code/structure, or out-of-band length) — near matching stays
    // silent on those. `relaxed_key_length` is the key's code-point length, banded by the query.
    relaxedKey: text("relaxed_key"),
    relaxedKeyLength: integer("relaxed_key_length")
  },
  (table) => [
    // The discriminated shape is enforced in the database, not only at the contract boundary: a note
    // always has both a body doc and its text; a mark has neither.
    check(
      "notes_kind_body_ck",
      sql`(${table.kind} = 'note' and ${table.bodyDoc} is not null and ${table.bodyText} is not null) or (${table.kind} = 'mark' and ${table.bodyDoc} is null and ${table.bodyText} is null)`
    ),
    // The fingerprint mirrors the note/mark shape: a body-bearing note has one, a bodyless mark has
    // none. Added NOT VALID in migration 0074 so it enforces every future write immediately while the
    // one-time JS backfill fills legacy rows before the constraint is VALIDATEd.
    check(
      "notes_material_fingerprint_kind_ck",
      sql`(${table.kind} = 'note' and ${table.materialFingerprint} is not null) or (${table.kind} = 'mark' and ${table.materialFingerprint} is null)`
    ),
    // Non-unique index accelerating the owner-scoped exact-material lookup (#711).
    index("notes_material_fingerprint_idx").on(table.materialFingerprint),
    // The near-match key and its length travel together and only ever belong to a body-bearing note:
    // either both are NULL (a mark, or an unsupported note — near matching is silent), or it is a note
    // carrying both. Added VALID immediately: a freshly-added column is all-NULL, which already
    // satisfies this, so no legacy rows violate it and no NOT VALID/backfill-validate dance is needed.
    check(
      "notes_relaxed_key_pair_ck",
      sql`(${table.relaxedKey} is null and ${table.relaxedKeyLength} is null) or (${table.kind} = 'note' and ${table.relaxedKey} is not null and ${table.relaxedKeyLength} is not null)`
    ),
    // Non-unique index accelerating the owner-scoped near-match length-band scan (#713).
    index("notes_relaxed_key_length_idx").on(table.relaxedKeyLength)
  ]
);

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
    // Plan-level pause (#608): non-null removes the plan's cards from ALL cross-plan due/Today selection
    // without deleting any progress, schedule, support levels, chains, or history; resuming clears it.
    pausedAt: timestamp("paused_at", { mode: "date", withTimezone: true }),
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

// A Memory prompt (#595, #617, #620): one independently reviewable retrieval direction under a note.
// `note_entry_id` is its owning note in the unified `notes` facet (the note carries the `personal_entries`
// row, so the prompt inherits ownership transitively and never gets a Timeline row of its own — the
// note→prompt edge is also recorded in `entry_links` as `contains`). Referencing `notes.entry_id` makes an
// orphan prompt structurally invalid. `cue_doc`/`answer_doc` are the rich bodies, with `cue_text`/`answer_text`
// their readable projections. `lifecycle` records content completeness: `draft` (no revealable answer, so
// `answer_doc`/`answer_text` are NULL) or `ready` (a revealable answer). Scheduling state is NOT stored
// here anymore — enrollment and FSRS state live in the shared `review_cards` substrate keyed by this
// prompt's `entry_id` (#617). `chunk_id` optionally links the direction to a practice chunk (#205),
// retained Memory provenance after the Practice retirement (#603).
//
// `reveal_kind` (#657, #686) is the explicit, persisted reveal discriminant that declares what a reveal
// resolves — never inferred from the nullable answer columns. `legacy_custom` is the historical shape:
// the reveal resolves the prompt's own stored `answer_doc`/`answer_text` custom answer (a `draft` legacy
// prompt is not yet revealable, so both are NULL; a `ready` legacy prompt has both). `current_note` is
// the durable reference shape (later Notes enrollment/import produce it): the prompt stores NO answer and
// resolves its reveal live from the referenced note's canonical `body_doc`/`body_text` at read time, so a
// note edit is always reflected and note content is never copied onto the prompt. `expected_response`
// (#686) is the explicit graded shape: `answer_doc`/`answer_text` hold the concise learner-authored Success
// check (never a copied note body), and the reveal ALSO resolves the live note as Reference — so it grades
// against an authored expectation while the note stays canonical. The `memory_prompts_reveal_shape_ck`
// check enforces the shapes in the database: a `current_note` prompt is always `ready` with no answer
// columns; an `expected_response` prompt is always `ready` with both answer projections (the Success
// check); a `ready` legacy prompt has both answer projections; a `draft` legacy prompt has neither.
export const memoryPrompts = pgTable(
  "memory_prompts",
  {
    entryId: text("entry_id")
      .primaryKey()
      .references(() => entries.id),
    noteEntryId: text("note_entry_id")
      .notNull()
      .references(() => notes.entryId),
    cueDoc: jsonb("cue_doc").notNull(),
    cueText: text("cue_text").notNull(),
    answerDoc: jsonb("answer_doc"),
    answerText: text("answer_text"),
    lifecycle: text("lifecycle", { enum: ["draft", "ready"] as const }).notNull(),
    revealKind: text("reveal_kind", {
      enum: ["current_note", "expected_response", "legacy_custom"] as const
    }).notNull(),
    // Optimistic content revision for Question / grading-target writes. Repair and Card detail submit the
    // revision they loaded; a conditional update rejects a stale editor instead of overwriting newer work.
    revision: integer("revision").notNull().default(0),
    // Temporary retained Memory-provenance link (#603): optionally ties a prompt to the practice chunk
    // (#205) it was harvested from. Retained until a later issue migrates provenance off `chunk_id` and
    // drops `domains`/`cases`/`chunks`.
    chunkId: text("chunk_id").references(() => chunks.id),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("memory_prompts_note_idx").on(table.noteEntryId),
    index("memory_prompts_chunk_idx").on(table.chunkId),
    // Independent card directions per note (#688): a note may own ZERO OR MORE authored retrieval contracts
    // — recognition, production, and other capabilities — each a distinct `current_note` or
    // `expected_response` prompt with its own review card and history, alongside any preserved
    // `legacy_custom` siblings. #687's one-authored-prompt-per-note partial unique index is deliberately
    // dropped: multiplicity is the contract now, so two distinct authoring submissions create two distinct
    // cards over the same shared note. Per-submission idempotency is enforced by the creation receipt
    // (owner + `submissionId`), not by a uniqueness constraint on the note.
    // The reveal shapes are still enforced in the database, not only at the write boundary: a current-note
    // prompt is ready and answerless (its reveal is the live note body); an expected-response prompt is
    // ready with both answer projections (the authored Success check, revealed alongside the live note as
    // Reference); a ready legacy prompt has both answer projections; a draft legacy prompt has neither.
    check(
      "memory_prompts_reveal_shape_ck",
      sql`(${table.revealKind} = 'current_note' and ${table.lifecycle} = 'ready' and ${table.answerDoc} is null and ${table.answerText} is null) or (${table.revealKind} = 'expected_response' and ${table.lifecycle} = 'ready' and ${table.answerDoc} is not null and ${table.answerText} is not null) or (${table.revealKind} = 'legacy_custom' and ${table.lifecycle} = 'ready' and ${table.answerDoc} is not null and ${table.answerText} is not null) or (${table.revealKind} = 'legacy_custom' and ${table.lifecycle} = 'draft' and ${table.answerDoc} is null and ${table.answerText} is null)`
    )
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

// The idempotency ledger for retry-safe direct card creation (#689): one row per accepted submission,
// keyed by the owner and the client's stable `submission_id`, so a replayed request resolves to its
// original result instead of writing a second note/prompt/card. `payload_fingerprint` is a non-reversible
// digest of the submitted question/answer/grading-target documents (never the learning content itself),
// so a replay with a CHANGED payload under the same id is a detectable conflict rather than a silent
// overwrite. `note_entry_id` and `prompt_entry_id` record the created result. They are deliberately PLAIN
// text with NO foreign key to `entries`, so this receipt sits OUTSIDE the note delete cascade
// (`deleteNoteInTx`) and survives as a non-resurrecting tombstone: once the note is deleted a replay
// reports the result is gone and never recreates it. Owner-scoped (`user_id`) so different owners are
// isolated even when they reuse the same `submission_id`.
export const cardCreationReceipts = pgTable(
  "card_creation_receipts",
  {
    userId: text("user_id").notNull(),
    submissionId: text("submission_id").notNull(),
    noteEntryId: text("note_entry_id").notNull(),
    promptEntryId: text("prompt_entry_id").notNull(),
    payloadFingerprint: text("payload_fingerprint").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.userId, table.submissionId] })]
);

// The owner-scoped, expiring review attempt minted ONLY when a New-card save (#712) finds the drafted
// Answer already exact-projected in the learner's Notes. It is operational state — never an Entry, never
// on the Timeline/Today, excluded from backup — that binds one pending material review so a follow-on
// decision (Use existing material / Keep separate) is authoritative and fenced. It stores no learning
// content: `draft_fingerprint` is the opaque sha256 of the full authored draft (answer+question+target),
// so a decision whose draft changed (an edited Answer) is detected without persisting the draft;
// `candidate_note_ids` are the reviewed candidate note ids and `candidate_fingerprint` their opaque
// digest, so a new/changed/deleted candidate since review is detected and forces a refresh. `revision`
// fences a decision against a stale client; `source` records where review was raised (`ui`). A partial
// unique index keeps at most one PENDING attempt per (owner, submission), so a save retry resumes the
// same review instead of minting a second. The row is swept at its `expires_at` on startup and on each
// attempt operation; it has no foreign key into the note cascade, so a deleted candidate simply fails a
// later recheck rather than resurrecting anything.
export const cardCreationAttempts = pgTable(
  "card_creation_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    submissionId: text("submission_id").notNull(),
    draftFingerprint: text("draft_fingerprint").notNull(),
    candidateNoteIds: jsonb("candidate_note_ids").$type<ReadonlyArray<string>>().notNull(),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    source: text("source", { enum: ["ui"] as const }).notNull(),
    state: text("state", { enum: ["pending", "consumed"] as const }).notNull(),
    decision: text("decision", { enum: ["reuse", "keep_separate"] as const }),
    revision: integer("revision").notNull().default(0),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("card_creation_attempts_user_idx").on(table.userId),
    // At most ONE pending review per (owner, submission): a save retry for the same submission resumes
    // the existing review rather than minting a duplicate. A consumed attempt is terminal, so it never
    // participates in the active predicate.
    uniqueIndex("card_creation_attempts_single_pending")
      .on(table.userId, table.submissionId)
      .where(sql`${table.state} = 'pending'`),
    // A decision is recorded only on a consumed attempt, and a pending attempt never carries one: the
    // biconditional keeps the terminal state and its decision in lockstep so a half-written row is
    // impossible.
    check(
      "card_creation_attempts_decision_state_ck",
      sql`(${table.state} = 'consumed' and ${table.decision} is not null) or (${table.state} = 'pending' and ${table.decision} is null)`
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

// A recoverable staged PDF import attempt (#721): import EXECUTION state, deliberately SEPARATE from
// readable content. An attempt owns staged bytes and a bounded #701 conversion run; it is NOT an
// `entries` row and creates no Work/ReadingUnit/Block (publication is #702). `state` walks
// queued -> running -> converted/failed, with `cancelled` (owner-cancelled) and `interrupted` (a claim
// abandoned by a dead process, recovered at startup). `run_token` fences a stale child: a checkpoint is
// applied only while the row is still `running` under the same token. `stage_path` is the attempt-owned
// staging directory (relative, server-generated), null once the stage is removed. `source_hash` is the
// staged bytes' sha256; `adapter_fingerprint` records the exact converter build committed ranges were
// produced under, so a resume reuses only matching ranges. Progress is COUNTS (`completed_pages`,
// derived range counts), never a parsed percentage. The failure columns hold a typed failure only
// (kind/message/remedy) — never converter JSON or extracted learning content.
export const pdfImportAttempts = pgTable(
  "pdf_import_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    state: text("state", {
      enum: [
        "queued",
        "running",
        "awaiting_review",
        "converted",
        "failed",
        "cancelled",
        "interrupted"
      ] as const
    }).notNull(),
    runToken: text("run_token"),
    // The durable phase of a running attempt (#745): preflight probe, OCR text layer, structured (#701)
    // conversion, or publication handoff. Null when not running. Persisted so status reports a truthful
    // named step and recovery resumes the right stage. Fenced by `run_token` like every other write.
    phase: text("phase", {
      enum: ["preflight", "ocr", "structured", "publication"] as const
    }),
    // The fingerprint of the validated, atomically-adopted OCR stage (#745): engine build + `-l` language.
    // Null means no OCR stage has been adopted yet — the recovery boundary. Null → a crash reruns the
    // OCR pre-pass safely against the immutable original; non-null → the derived `ocr.pdf` is the trusted
    // source, so recovery skips OCR and resumes structured conversion over it without re-OCR'ing.
    ocrFingerprint: text("ocr_fingerprint"),
    // The resolved OCR language for this attempt (#746): the pre-import override if one was chosen,
    // otherwise the Work's own language. One of the three Work languages — never free text. Resolved and
    // frozen once when the attempt is queued, so the runner and publication read the SAME choice and it
    // cannot drift mid-run; a re-import is a fresh attempt that resolves its own value. `en` is the
    // neutral default so a legacy row (pre-#746) reads as English.
    ocrLanguage: text("ocr_language").notNull().default("en"),
    adapterFingerprint: text("adapter_fingerprint"),
    stagePath: text("stage_path"),
    totalPages: integer("total_pages"),
    completedPages: integer("completed_pages").notNull().default(0),
    totalRanges: integer("total_ranges"),
    // The typed failure of a `failed` attempt, stored as one jsonb value (never spread across log/error
    // columns, and never converter JSON). Null unless `failed`, enforced by the check below.
    failure: jsonb("failure").$type<{ kind: string; message: string; remedy: string }>(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { mode: "date", withTimezone: true })
  },
  (table) => [
    index("pdf_import_attempts_user_idx").on(table.userId),
    // At most ONE running attempt across the whole server: a partial unique index over the `state`
    // column restricted to running rows means a second concurrent claim cannot commit, so single
    // admission is guaranteed by the database, not only by the transactional claim.
    uniqueIndex("pdf_import_attempts_single_running")
      .on(table.state)
      .where(sql`${table.state} = 'running'`),
    // Enforce the closed state set in the database so no writer (or restored dump) can land an
    // unknown attempt state.
    check(
      "pdf_import_attempts_state_ck",
      sql`${table.state} in ('queued', 'running', 'awaiting_review', 'converted', 'failed', 'cancelled', 'interrupted')`
    ),
    // A typed failure is stored on (and only on) a `failed` attempt, so a non-failed row never carries
    // a stale failure and a failed row always explains itself.
    check(
      "pdf_import_attempts_failure_ck",
      sql`(${table.state} = 'failed' and ${table.failure} is not null) or (${table.state} <> 'failed' and ${table.failure} is null)`
    ),
    // The resolved OCR language is one of the three Work languages (#746) — never free text — so no
    // writer or restored dump can land an unknown OCR language the pack mapping would not cover.
    check(
      "pdf_import_attempts_ocr_language_ck",
      sql`${table.ocrLanguage} in ('en', 'zh-CN', 'zh-TW')`
    )
  ]
);

// One committed page-range result for an attempt (#721): the validated #701 RangeConversion projection
// for pages [start_page, end_page], stored idempotently by (attempt_id, range_index). `fingerprint` is
// the adapter build the range was produced under, so a resume/retry reuses only ranges matching the
// current build and drops stale ones. `payload` is the validated structural projection — evidence for
// #702, never published content. Deleted with its attempt (cascade) as operational hygiene.
export const pdfImportRanges = pgTable(
  "pdf_import_ranges",
  {
    attemptId: text("attempt_id")
      .notNull()
      .references(() => pdfImportAttempts.id, { onDelete: "cascade" }),
    rangeIndex: integer("range_index").notNull(),
    startPage: integer("start_page").notNull(),
    endPage: integer("end_page").notNull(),
    fingerprint: text("fingerprint").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.attemptId, table.rangeIndex] })]
);

// The #702 publication of a converted attempt into canonical content. The attempt (#721) is pure
// execution and knows nothing about publishing; this row is the publication's own record, one per
// attempt. It captures the learner's upload-time intent (`entered_*`, `file_name`) at start, then
// records the outcome exactly once at publish: `work_entry_id` (the published Work), OR
// `ocr_validation_failed_pages` (a positive page count when a document still had text-less pages after
// the OCR pass — preflight/full-conversion disagreement or incomplete OCR — so publishing is refused, no
// Work created), OR `no_content` (the pages carried native text but mapped to zero canonical blocks, so
// publishing would create an empty-shell Work — refused, no Work created), OR `unpreservable_images` (a
// positive count of picture/figure constructs whose images #701 cannot extract, so publishing would lose
// content — refused, no Work created). A row with no result set is a publication still pending; the
// `result_ck` check forbids ever setting more than one. Deleted with its attempt (cascade) as operational
// hygiene — the published Work and its blocks are independent, immutable content and are never touched by
// that cleanup.
export const pdfImportPublications = pgTable(
  "pdf_import_publications",
  {
    attemptId: text("attempt_id")
      .primaryKey()
      .references(() => pdfImportAttempts.id, { onDelete: "cascade" }),
    enteredTitle: text("entered_title"),
    enteredAuthor: text("entered_author"),
    enteredLanguage: text("entered_language"),
    fileName: text("file_name").notNull(),
    workEntryId: text("work_entry_id").references(() => entries.id),
    ocrValidationFailedPages: integer("ocr_validation_failed_pages"),
    noContent: boolean("no_content"),
    unpreservableImages: integer("unpreservable_images"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { mode: "date", withTimezone: true })
  },
  (table) => [
    // A publication resolves to at most one outcome: a published Work, an OCR-validation-failed page
    // count, a no-content refusal, or an unsupported-image refusal — never more than one. (None set =
    // pending.)
    check(
      "pdf_import_publications_result_ck",
      sql`(${table.workEntryId} is not null)::int + (${table.ocrValidationFailedPages} is not null)::int + (${table.noContent} is not null)::int + (${table.unpreservableImages} is not null)::int <= 1`
    ),
    // An OCR-validation-failed marker, when present, is a positive page count.
    check(
      "pdf_import_publications_ocr_validation_pages_ck",
      sql`${table.ocrValidationFailedPages} is null or ${table.ocrValidationFailedPages} > 0`
    ),
    // An unsupported-image marker, when present, is a positive image count.
    check(
      "pdf_import_publications_images_ck",
      sql`${table.unpreservableImages} is null or ${table.unpreservableImages} > 0`
    )
  ]
);

// Additive per-block provenance for a PDF-published block (#702): the page geometry, character span,
// converter confidence, and raw converter label the block was mapped from, plus — for a block whose page
// text came from the OCR pass (#745) — the OCR engine fingerprint and Tesseract language it was produced
// with. This is EVIDENCE only — the block's canonical content lives in `doc_blocks`; deleting or ignoring
// this row never changes what the reader shows. Keyed by the block id (one evidence row per published
// block that carried geometry). `work_entry_id` is denormalized for owner-scoped queries and cleanup.
export const pdfBlockEvidence = pgTable(
  "pdf_block_evidence",
  {
    blockId: text("block_id")
      .primaryKey()
      .references(() => docBlocks.id, { onDelete: "cascade" }),
    workEntryId: text("work_entry_id")
      .notNull()
      .references(() => entries.id),
    page: integer("page").notNull(),
    left: doublePrecision("left"),
    top: doublePrecision("top"),
    right: doublePrecision("right"),
    bottom: doublePrecision("bottom"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    confidence: doublePrecision("confidence"),
    label: text("label").notNull(),
    // The OCR provenance of this block, set only when the attempt adopted a validated OCR stage (#745):
    // the engine fingerprint (build + `-l` value) and the Tesseract language it was OCR'd in. Null for a
    // block from a born-digital (native) document that never went through OCR. Attempt-level (not
    // per-page) provenance — the post-conversion projection no longer carries the per-page OCR flag.
    ocrEngine: text("ocr_engine"),
    ocrLanguage: text("ocr_language")
  },
  (table) => [index("pdf_block_evidence_work_idx").on(table.workEntryId)]
);

// One durable, owner-scoped Work CREATION-REVIEW attempt (#725). Duplicate review is operational state,
// not Work identity: an attempt holds the learner's proposed metadata, the reviewed duplicate-candidate
// evidence snapshot (+ its fingerprint), the source kind/hash under review, and — for an ordinary upload
// (markdown/epub) — the staged bytes, until one serialized decision commits or discards it. It stores NO
// Work, ReadingUnit, Block, or source-claim row and has NO foreign key into content, so restoring an
// operational dump of this table creates no live Work/content. Source-processing features keep their own
// stages: a `pdf` attempt references `pdf_import_attempts`, which stays the sole owner of the PDF stages,
// so this table's `stage_path` is only ever an ordinary upload's. `state` walks pending -> finalizing ->
// completed, with `cancelled` (owner-abandoned) and `expired` (TTL swept). `revision` is the compare-and-
// set fence: a decision applies only while the row is still at the revision the client loaded, so a stale
// client can never commit and a replayed decision is rejected. The enum literals are duplicated here (not
// imported from `domain`) so migration generation never depends on the domain build.
export const workCreationAttempts = pgTable(
  "work_creation_attempts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    // The learner's proposal. `proposed_author_id` is set only when an existing Library author was chosen
    // (exact identity reuse); a brand-new author is carried by name alone until the decision creates it.
    proposedTitle: text("proposed_title").notNull(),
    proposedAuthorId: text("proposed_author_id"),
    proposedAuthorName: text("proposed_author_name").notNull(),
    proposedLanguage: text("proposed_language", {
      enum: ["zh-CN", "zh-TW", "en"] as const
    }).notNull(),
    proposedWorkType: text("proposed_work_type", {
      enum: ["book", "essay", "blog_post", "classical_text"] as const
    }).notNull(),
    // The source under review. `source_hash` (sha256 of the uploaded bytes) is null for a metadata-only
    // manual proposal, which never reopens an exact source.
    sourceKind: text("source_kind", {
      enum: ["manual", "markdown", "epub", "pdf"] as const
    }).notNull(),
    sourceHash: text("source_hash"),
    // For a `pdf` creation attempt (#750): the referenced #721 execution attempt whose validated,
    // converted source this review governs. The PDF import attempt stays the SOLE owner of the PDF stages
    // and committed ranges; this column is a reference/lock, never a file path. Null for manual/markdown/
    // epub (which own no PDF attempt); set exactly when `source_kind = 'pdf'` (enforced below). The partial
    // unique index restricts a PDF attempt to at most ONE active (pending/finalizing) creation-review
    // attempt, so concurrent status polls cannot mint two decisions over one converted source.
    pdfImportAttemptId: text("pdf_import_attempt_id").references(() => pdfImportAttempts.id),
    // The uploaded file's original name, carried so a deferred decision can complete the creation with the
    // same provenance the one-step front door records. Null for a metadata-only manual proposal (no file);
    // set for an ordinary upload (markdown/epub) whose bytes this attempt stages.
    sourceFileName: text("source_file_name"),
    // The reviewed candidate EVIDENCE the learner was shown (identity + displayed metadata), and its
    // fingerprint, stored together or not at all. Comparing the fingerprint to a freshly-computed one
    // detects changed evidence — not only new ids — and forces a fresh review. Never Work content.
    candidateSnapshot: jsonb("candidate_snapshot").$type<
      ReadonlyArray<{
        entryId: string;
        title: string;
        authorId: string;
        authorName: string;
        language: string;
        workType: string;
      }>
    >(),
    candidateFingerprint: text("candidate_fingerprint"),
    state: text("state", {
      enum: ["pending", "finalizing", "completed", "cancelled", "expired"] as const
    }).notNull(),
    revision: integer("revision").notNull().default(0),
    // The attempt-owned ordinary upload stage (relative, server-generated), null for manual/pdf and once
    // the stage is transferred to provenance or removed. Kept set until the filesystem removal succeeds,
    // so a failed cleanup stays visible and retryable rather than orphaning the staged bytes.
    stagePath: text("stage_path"),
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("work_creation_attempts_user_idx").on(table.userId),
    // At most ONE active (pending/finalizing) creation attempt per owner: a partial unique index enforces
    // the "one owner-scoped creation attempt" invariant in the database, so a client cannot bypass it by
    // racing two concurrent creates and end up with double-owned staged files or half-created Works.
    uniqueIndex("work_creation_attempts_single_active")
      .on(table.userId)
      .where(sql`${table.state} in ('pending', 'finalizing')`),
    // At most ONE active (pending/finalizing) creation-review attempt PER referenced PDF import attempt
    // (#750): a partial unique index over `pdf_import_attempt_id` for active rows. So the first status read
    // after conversion idempotently creates the review and concurrent polls cannot mint a second decision
    // over one converted source — the reference is fenced by the database, not only by the caller.
    uniqueIndex("work_creation_attempts_single_active_pdf")
      .on(table.pdfImportAttemptId)
      .where(
        sql`${table.pdfImportAttemptId} is not null and ${table.state} in ('pending', 'finalizing')`
      ),
    // Enforce the closed state set in the database so no writer (or restored dump) can land an unknown
    // attempt state.
    check(
      "work_creation_attempts_state_ck",
      sql`${table.state} in ('pending', 'finalizing', 'completed', 'cancelled', 'expired')`
    ),
    // Enforce the closed source-kind set in the database.
    check(
      "work_creation_attempts_source_kind_ck",
      sql`${table.sourceKind} in ('manual', 'markdown', 'epub', 'pdf')`
    ),
    // A PDF import attempt reference belongs to (and only to) a `pdf` creation attempt: a non-pdf attempt
    // owns no PDF execution attempt, and a pdf attempt must reference exactly the one it reviews. So the
    // reference is present iff the source kind is `pdf` — no phantom or missing lock (#750).
    check(
      "work_creation_attempts_pdf_ref_ck",
      sql`(${table.sourceKind} = 'pdf') = (${table.pdfImportAttemptId} is not null)`
    ),
    // A stage may only ever belong to an ORDINARY upload (markdown/epub). A manual proposal has no bytes,
    // and a pdf attempt's stage is owned by `pdf_import_attempts`, so a `stage_path` on either would be a
    // double-owned or phantom file — forbidden by construction.
    check(
      "work_creation_attempts_stage_kind_ck",
      sql`${table.stagePath} is null or ${table.sourceKind} in ('markdown', 'epub')`
    ),
    // The reviewed evidence and its fingerprint are stored together or not at all, so a fingerprint can
    // never claim to summarize an absent snapshot (and vice versa).
    check(
      "work_creation_attempts_snapshot_ck",
      sql`(${table.candidateSnapshot} is null) = (${table.candidateFingerprint} is null)`
    ),
    // The revision fence is monotonic and never negative.
    check("work_creation_attempts_revision_ck", sql`${table.revision} >= 0`)
  ]
);
