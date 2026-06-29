import { describe, expect, it } from "vitest";

import { createCoachAdapters } from "./coachAdapters.js";

describe("createCoachAdapters", () => {
  it("builds cheap (local) and strong (cloud) judges that both expose analyze", () => {
    const adapters = createCoachAdapters("sk-test", "llama3.1:8b");
    expect(typeof adapters.cheap.analyze).toBe("function");
    expect(typeof adapters.strong.analyze).toBe("function");
  });
});
