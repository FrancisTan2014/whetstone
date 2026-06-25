import type { LookupResponse } from "@whetstone/contracts";
import { describe, expect, it, vi } from "vitest";

import { createServer } from "../../http/createServer.js";

const foundResponse: LookupResponse = {
  entry: {
    headword: "word",
    partsOfSpeech: [
      {
        partOfSpeech: "noun",
        senses: [{ definition: "a unit of language", examples: [], synonyms: [] }]
      }
    ],
    pronunciations: [{ ipa: "wɜːd" }],
    sources: ["WordNet", "Wiktionary"]
  },
  found: true
};

function buildServer(lookup: (term: string, language: string) => Promise<LookupResponse>) {
  return createServer({ logger: false, lookup: { lookup } });
}

describe("GET /api/lookup", () => {
  it("validates the query and returns the normalized entry on a match", async () => {
    const lookup = vi.fn().mockResolvedValue(foundResponse);
    const server = buildServer(lookup);

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/lookup?term=word&language=en"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(foundResponse);
      expect(lookup).toHaveBeenCalledWith("word", "en");
    } finally {
      await server.close();
    }
  });

  it("returns 200 with an explicit not-found when there is no match", async () => {
    const server = buildServer(() => Promise.resolve({ found: false }));

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/lookup?term=absent&language=en"
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ found: false });
    } finally {
      await server.close();
    }
  });

  it("accepts a Chinese language and routes it to the service", async () => {
    const lookup = vi.fn().mockResolvedValue(foundResponse);
    const server = buildServer(lookup);

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/lookup?term=%E4%BD%A0%E5%A5%BD&language=zh-CN"
      });

      expect(response.statusCode).toBe(200);
      expect(lookup).toHaveBeenCalledWith("你好", "zh-CN");
    } finally {
      await server.close();
    }
  });

  it("rejects an unsupported language with 400", async () => {
    const lookup = vi.fn().mockResolvedValue(foundResponse);
    const server = buildServer(lookup);

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/lookup?term=word&language=fr"
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects a missing term with 400", async () => {
    const server = buildServer(() => Promise.resolve(foundResponse));

    try {
      const response = await server.inject({ method: "GET", url: "/api/lookup?language=en" });

      expect(response.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });
});
