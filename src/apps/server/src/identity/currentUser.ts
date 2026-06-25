// The stable, well-known id every user-owned write stamps and every user-owned read filters by in
// v0 (PRODUCT.md "Identity & ownership (v0)"): there is no users table, login, or session yet.
// Defined in exactly one place and reached only through the provider below, so future auth swaps
// only the provider — and adds a users table + FKs — with no ownership backfill or query rewrite.
export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";

// The single source of the current user id for request handling. Injected through the server so
// handlers never read a literal and tests can pass a fake; v0 always resolves DEFAULT_USER_ID.
export interface CurrentUserProvider {
  getCurrentUserId(): string;
}

export function createDefaultCurrentUserProvider(): CurrentUserProvider {
  return Object.freeze({ getCurrentUserId: () => DEFAULT_USER_ID });
}
