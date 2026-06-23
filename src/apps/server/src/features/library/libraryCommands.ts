import { toAuthorId, toEntryId, type AuthorId } from "@whetstone/domain";
import type {
  AuthorDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  WorkDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, entries, workMeta } from "../../db/schema.js";

// Real infrastructure boundaries (database client and id generation) are passed
// in so commands stay deterministic and testable.
export type LibraryDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  db: DbClient;
}>;

export type CreateWorkResult =
  | Readonly<{ status: "created"; work: WorkListItemDto }>
  | Readonly<{ status: "author_not_found"; authorId: AuthorId }>;

export async function createAuthor(
  dependencies: LibraryDependencies,
  request: CreateAuthorRequest
): Promise<AuthorDto> {
  const id = toAuthorId(dependencies.createAuthorId());
  await dependencies.db.insert(authors).values({ id, name: request.name });

  return { id, name: request.name };
}

export async function createWork(
  dependencies: LibraryDependencies,
  request: CreateWorkRequest
): Promise<CreateWorkResult> {
  return dependencies.db.transaction(async (tx) => {
    const resolved = await resolveAuthor(dependencies, tx, request.author);

    if (!resolved.found) {
      return { status: "author_not_found", authorId: resolved.authorId };
    }

    const author = resolved.author;
    const entryId = toEntryId(dependencies.createEntryId());
    await tx.insert(entries).values({ id: entryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: author.id,
      entryId,
      language: request.language,
      title: request.title,
      workType: request.workType
    });

    const work: WorkDto = {
      authorId: author.id,
      entryId,
      language: request.language,
      title: request.title,
      workType: request.workType
    };

    return { status: "created", work: { author, work } };
  });
}

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

type ResolvedAuthor =
  | Readonly<{ found: true; author: AuthorDto }>
  | Readonly<{ found: false; authorId: AuthorId }>;

async function resolveAuthor(
  dependencies: LibraryDependencies,
  tx: Transaction,
  selection: CreateWorkRequest["author"]
): Promise<ResolvedAuthor> {
  if (selection.mode === "new") {
    const id = toAuthorId(dependencies.createAuthorId());
    await tx.insert(authors).values({ id, name: selection.name });

    return { found: true, author: { id, name: selection.name } };
  }

  const existing = await tx
    .select()
    .from(authors)
    .where(eq(authors.id, selection.authorId))
    .limit(1);
  const found = existing[0];

  if (found === undefined) {
    return { found: false, authorId: selection.authorId };
  }

  return { found: true, author: { id: toAuthorId(found.id), name: found.name } };
}
