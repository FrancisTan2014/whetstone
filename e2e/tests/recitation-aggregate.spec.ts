import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// Two disjoint public-domain EPUBs (distinct sha256) so the two recitation plans live on two SEPARATE
// Works. Reusing another spec's fixture would dedupe to the same Work on the shared user and collide.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "epub");
const aggregateEpubA = join(fixtureDir, "recitation-aggregate-a.epub");
const aggregateEpubB = join(fixtureDir, "recitation-aggregate-b.epub");

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

async function uploadWork(
  request: APIRequestContext,
  baseURL: string,
  fixture: string
): Promise<{ entryId: string; title: string }> {
  const response = await request.post(`${baseURL}api/works/epub`, {
    data: readFileSync(fixture),
    headers: { "content-type": "application/epub+zip" }
  });
  expect([200, 201], `EPUB upload → ${response.status()}: ${await response.text()}`).toContain(
    response.status()
  );
  const { work } = (await response.json()) as { work: { entryId: string; title: string } };
  return work;
}

// Adopt an EPUB Work as a learning plan and introduce its first passage so exactly one card is due now.
// Returns the plan entry id so the spec can pause the plan afterward (see the cleanup note below).
async function adoptDuePlan(
  request: APIRequestContext,
  baseURL: string,
  workEntryId: string
): Promise<string> {
  const plan = (await post(request, baseURL, "/recitation/plans", {
    phase: "learning",
    workEntryId
  })) as { entryId: string };
  await post(request, baseURL, `/recitation/plans/${plan.entryId}/passages/seed`);
  await post(request, baseURL, `/recitation/plans/${plan.entryId}/introduce-next`);
  return plan.entryId;
}

// The recitation obligation is one truthful aggregate over EVERY active Work (#633): Today stays due
// until the LAST plan clears, a contextual link opens exactly the requested Work (AC7), and the session
// advances across Works on its own (AC1). A most-recent-only proxy would clear Today after the first
// Work — this spec fails that regression by clearing across two Works and asserting Today only goes clear
// after both.
test.describe("recitation aggregate across every active Work (#633)", () => {
  test("Today stays due until every active Work's recitation is cleared", async ({ page, setup }) => {
    const baseURL = setup.baseURL;
    const workA = await uploadWork(page.request, baseURL, aggregateEpubA);
    const workB = await uploadWork(page.request, baseURL, aggregateEpubB);
    const planA = await adoptDuePlan(page.request, baseURL, workA.entryId);
    const planB = await adoptDuePlan(page.request, baseURL, workB.entryId);

    // Two active plans, each with a due passage — Today shows one aggregate Recitation obligation.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByRole("heading", { name: "Due now" })).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();

    // Open Work A via its contextual link (AC7): the hub opens exactly that Work, not the most-recent.
    await page.goto(`${baseURL}#/recitation?work=${encodeURIComponent(workA.entryId)}`);
    const hub = page.getByRole("region", { name: "Recitation" });
    await expect(hub.getByRole("heading", { name: workA.title })).toBeVisible();
    await hub.getByRole("button", { name: "Start session" }).click();

    // Clear Work A's due passage. With Work B still due, the aggregate suppresses optional new material
    // and the session advances on its own to Work B (AC1) — never a false all-clear after one Work.
    const session = hub.getByRole("region", { name: "Recitation session" });
    await expect(session.getByRole("heading", { name: workA.title })).toBeVisible();
    await session.getByRole("button", { name: "Reveal" }).click();
    await session.getByRole("button", { name: "Complete, with effort" }).click();
    await expect(session.getByRole("heading", { name: workB.title })).toBeVisible();
    await session.getByRole("button", { name: "Exit session" }).click();

    // Today is STILL due: the aggregate still owes Work B. (A most-recent proxy would falsely clear here.)
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();

    // Open Work B contextually and clear it — the last active Work.
    await page.goto(`${baseURL}#/recitation?work=${encodeURIComponent(workB.entryId)}`);
    await expect(hub.getByRole("heading", { name: workB.title })).toBeVisible();
    await hub.getByRole("button", { name: "Start session" }).click();
    await expect(session.getByRole("heading", { name: workB.title })).toBeVisible();
    await session.getByRole("button", { name: "Reveal" }).click();
    await session.getByRole("button", { name: "Complete, with effort" }).click();
    // With every Work now clear of required work, the aggregate stops suppressing optional new material
    // and offers the next introduction; skipping it reaches the truthful clear state.
    await session.getByRole("button", { name: "Skip new passage for now" }).click();
    await expect(session.getByText("Due recitation clear")).toBeVisible();
    await session.getByRole("button", { name: "Exit session" }).click();

    // Only now, with every active Work cleared, does the aggregate recitation obligation leave Today.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("Recitation", { exact: true })).toHaveCount(0);

    // Cleanup for the shared single-user E2E database: a just-learned passage re-enters its learning
    // step within minutes, so these two plans would re-surface as due for the later recitation specs
    // that run after this one (the routine is now a TRUE aggregate over every active plan — #633).
    // Pause both plans so they leave the aggregate entirely and each later spec sees only its own work.
    await post(page.request, baseURL, `/recitation/plans/${planA}/pause`);
    await post(page.request, baseURL, `/recitation/plans/${planB}/pause`);
  });
});
