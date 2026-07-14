import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Passage seeding reads the ProseMirror `doc_blocks` that only EPUB ingestion writes, so a due
// recitation needs an EPUB-backed Work. This spec uploads its OWN dedicated fixture
// (`today-cycle.epub`, distinct bytes/sha256) rather than the shared `setup.epub`/`aesop-fables.epub`
// (which `stack.ts` seeds and the passages spec adopts) — otherwise EPUB upload would dedupe to the same
// Work and the two recitation plans would collide on the shared DEFAULT_USER_ID.
const todayEpubFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "epub",
  "today-cycle.epub"
);

async function post(
  request: APIRequestContext,
  baseURL: string,
  path: string,
  data?: unknown
): Promise<unknown> {
  const response = await request.post(`${baseURL}api${path}`, data === undefined ? {} : { data });
  expect(response.ok(), `POST ${path} → ${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

async function uploadTodayWork(
  request: APIRequestContext,
  baseURL: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(todayEpubFixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

// The Today daily cycle (#610): the server-composed board shows the learner's real obligations as two
// grouped routine rows, each routine is completed inside its owning feature (the recitation hub, recall),
// and returning to Today recomputes a truthful clear board with the optional Continue section still
// present. The stack boots with models disabled, so this whole loop is deterministic.
test.describe("Today daily cycle (#610)", () => {
  test("clears mixed due recitation and memory, then shows the truthful clear board", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    // A due recitation routine: adopt the EPUB Work and introduce its first passage so one card is due.
    const work = await uploadTodayWork(page.request, baseURL);
    const plan = (await post(page.request, baseURL, "/recitation/plans", {
      phase: "learning",
      workEntryId: work.entryId
    })) as { entryId: string };
    await post(page.request, baseURL, `/recitation/plans/${plan.entryId}/passages/seed`);
    await post(page.request, baseURL, `/recitation/plans/${plan.entryId}/introduce-next`);

    // A due memory routine: deposit one scheduled prompt (a cue with an answer is due immediately).
    await post(page.request, baseURL, "/memory/notes", {
      captureSource: "manual",
      noteText: "kanmusu — ship girl",
      prompts: [{ answerText: "ship girl", cueText: "kanmusu" }]
    });

    // Today shows both obligations as grouped Due-now rows, and no false clear.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByRole("heading", { name: "Due now" })).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();
    await expect(page.getByText("Memory review")).toBeVisible();
    await expect(page.getByText("All due work is clear.")).toHaveCount(0);

    // Complete the due recitation via the hub (the #609 session runs inline there).
    await page.getByRole("link", { name: "Start", exact: true }).click();
    const hub = page.getByRole("region", { name: "Recitation" });
    await hub.getByRole("button", { name: "Start session" }).click();
    const session = hub.getByRole("region", { name: "Recitation session" });
    await session.getByRole("button", { name: "Reveal" }).click();
    await session.getByRole("button", { name: "Complete, with effort" }).click();
    // With the due passage cleared, the session offers to introduce another passage; skipping that
    // optional new passage reaches the truthful completion state.
    await session.getByRole("button", { name: "Skip new passage for now" }).click();
    await expect(session.getByText("Due recitation clear")).toBeVisible();
    await session.getByRole("button", { name: "Exit session" }).click();

    // Back on a freshly recomputed board the recitation row is gone; memory review is still due.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("Memory review")).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toHaveCount(0);

    // Review the due memory via recall.
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/#\/recall$/);
    await expect(page.getByText("kanmusu")).toBeVisible();
    await page.getByRole("button", { name: "Show answer" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    await expect(page.getByText(/all caught up/)).toBeVisible();

    // Returning to Today shows the truthful clear state, with the optional Continue section still present.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("All due work is clear.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Due now" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Continue" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to your diary" })).toBeVisible();
  });
});
