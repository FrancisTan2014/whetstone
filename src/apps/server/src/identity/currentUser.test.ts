import { describe, expect, it } from "vitest";

import {
  DEFAULT_USER_ID,
  createDefaultCurrentUserProvider,
  type CurrentUserProvider
} from "./currentUser.js";

describe("currentUser", () => {
  it("defines DEFAULT_USER_ID as a single stable, uuid-shaped id", () => {
    expect(DEFAULT_USER_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("resolves the current user id to DEFAULT_USER_ID in v0", () => {
    expect(createDefaultCurrentUserProvider().getCurrentUserId()).toBe(DEFAULT_USER_ID);
  });

  it("lets a fake provider satisfy the interface and override the id", () => {
    const fake: CurrentUserProvider = { getCurrentUserId: () => "fake-user" };

    expect(fake.getCurrentUserId()).toBe("fake-user");
  });
});
