import { toAuthorId } from "@whetstone/domain";
import type { AuthorDto } from "@whetstone/contracts";
import { sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";

// The resolver runs inside a caller's transaction so a Work-creation or ingestion path resolves its
// author atomically with the rest of its writes.
export type AuthorResolverTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export type ResolveNamedAuthorResult = Readonly<{ author: AuthorDto; created: boolean }>;

type AuthorRow = Readonly<{ id: string; name: string }>;

// The one named-author identity boundary (#694). Manual creation, inline Work creation, and EPUB
// ingestion all resolve through here so a single canonical row backs each name, even when requests
// race. Identity is computed by the shared `clean_author_name` / `author_name_key` SQL functions —
// never reimplemented in TypeScript, because JavaScript and PostgreSQL Unicode lowercase differ.
//
// Concurrency: insert the cleaned name + canonical key and let the partial unique index arbitrate via
// `ON CONFLICT ... DO NOTHING`. A winning insert returns its row (`created`); a losing racer reads back
// the now-committed survivor by key. Two canonical-equivalent resolves therefore return the same id and
// leave exactly one row.
export async function resolveNamedAuthor(
  tx: AuthorResolverTx,
  createAuthorId: () => string,
  name: string
): Promise<ResolveNamedAuthorResult> {
  const inserted = await tx.execute(sql`
    INSERT INTO authors (id, name, name_key)
    VALUES (${createAuthorId()}, clean_author_name(${name}), author_name_key(${name}))
    ON CONFLICT (name_key) WHERE name_key IS NOT NULL DO NOTHING
    RETURNING id, name
  `);
  const insertedRow = inserted.rows[0] as AuthorRow | undefined;

  if (insertedRow !== undefined) {
    return {
      author: { id: toAuthorId(insertedRow.id), name: insertedRow.name },
      created: true
    };
  }

  const existing = await tx.execute(sql`
    SELECT id, name FROM authors WHERE name_key = author_name_key(${name}) LIMIT 1
  `);
  const existingRow = existing.rows[0] as AuthorRow;

  return {
    author: { id: toAuthorId(existingRow.id), name: existingRow.name },
    created: false
  };
}
