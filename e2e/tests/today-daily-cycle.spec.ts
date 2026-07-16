import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../fixtures";
import type { APIRequestContext } from "@playwright/test";

// A due recitation needs an EPUB-backed Work whose blocks the whole-Work review reveals. This spec uploads
// its OWN dedicated fixture (`today-cycle.epub`, distinct bytes/sha256) rather than the shared
// `aesop-fables.epub` (which `stack.ts` seeds) — otherwise EPUB upload would dedupe to the same Work and
// the recitation plans would collide on the shared DEFAULT_USER_ID.
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

// The Today daily cycle (#610/#643): the server-composed board shows the learner's real obligations as two
// grouped routine rows, each routine is completed inside its owning feature (direct whole-Work recitation,
// recall), and returning to Today recomputes a truthful clear board with the optional Continue section
// still present. The stack boots with models disabled, so this whole loop is deterministic.
test.describe("Today daily cycle (#610)", () => {
  test("clears mixed due recitation and memory, then shows the truthful clear board", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    // A due recitation routine: enrol the EPUB Work directly into whole-Work maintenance (no passage
    // setup, no phase choice) so its Work-level card is due immediately.
    const work = await uploadTodayWork(page.request, baseURL);
    await post(page.request, baseURL, "/recitation/enroll", { workEntryId: work.entryId });

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

    // Complete the due recitation via the direct whole-Work review (reveal the canonical source, rate).
    await page.getByRole("link", { name: "Start", exact: true }).click();
    await page.getByRole("button", { name: "Reveal" }).click();
    await page.getByRole("button", { name: "Complete, with effort" }).click();
    await expect(page.getByRole("status")).toContainText("Scheduled");
    await page.getByRole("link", { name: "Back to Today" }).click();

    // Back on a freshly recomputed board the recitation row is gone; memory review is still due.
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
