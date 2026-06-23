declare const authorIdBrand: unique symbol;

// Author/Source is a relational entity, not an Entry, so it has its own id space.
export type AuthorId = string & { readonly [authorIdBrand]: "AuthorId" };

export function toAuthorId(value: string): AuthorId {
  if (value.trim().length === 0) {
    throw new Error("AuthorId must be a non-empty string.");
  }

  return value as AuthorId;
}
