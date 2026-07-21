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
// note review), and returning to Today recomputes a truthful clear board with the optional Continue section
// still present. The stack boots with models disabled, so this whole loop is deterministic.
test.describe("Today daily cycle (#610)", () => {
  test("clears mixed due recitation and note review, then shows the truthful clear board", async ({
    page,
    setup
  }) => {
    const { baseURL } = setup;

    // A due recitation routine: enrol the EPUB Work directly into whole-Work maintenance (no passage
    // setup, no phase choice) so its Work-level card is due immediately.
    const work = await uploadTodayWork(page.request, baseURL);
    await post(page.request, baseURL, "/recitation/enroll", { workEntryId: work.entryId });

    // A due note-review routine: create one standalone note, then author its first review card in place
    // (#687 replaced the retired enrollment route) so its current-note prompt's card is due immediately.
    const doc = (text: string) => ({
      content: [{ content: [{ text, type: "text" }], type: "paragraph" }],
      type: "doc"
    });
    const note = (await post(page.request, baseURL, "/notes", {
      bodyDoc: doc("kanmusu — ship girl")
    })) as { entryId: string };
    await post(page.request, baseURL, "/notes/review/author-cards", {
      noteEntryId: note.entryId,
      questionDoc: doc("kanmusu"),
      submissionId: "today-daily-note-card",
      target: { kind: "current_note" }
    });

    // Today shows both obligations as grouped Due-now rows, and no false clear.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByRole("heading", { name: "Due now" })).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toBeVisible();
    await expect(page.getByText("Notes review")).toBeVisible();
    await expect(page.getByText("Done for today.")).toHaveCount(0);

    // Complete the due recitation via the direct whole-Work review (reveal the canonical source, rate).
    // Both required rows now read "Review" (#639), so scope to the Recitation row before clicking.
    await page
      .getByRole("listitem")
      .filter({ hasText: "Recitation" })
      .getByRole("link", { name: "Review", exact: true })
      .click();
    await page.getByRole("button", { name: "Reveal" }).click();
    await page.getByRole("button", { name: "Complete, with effort" }).click();
    await expect(page.getByRole("status")).toContainText("Scheduled");
    await page.getByRole("link", { name: "Back to Today" }).click();

    // Back on a freshly recomputed board the recitation row is gone; note review is still due.
    await expect(page.getByText("Notes review")).toBeVisible();
    await expect(page.getByText("Recitation", { exact: true })).toHaveCount(0);

    // Review the due note via the Notes-owned Review session (reached from Today's Review link).
    await page.getByRole("link", { name: "Review", exact: true }).click();
    await expect(page).toHaveURL(/#\/notes\/review$/);
    await expect(page.getByRole("heading", { name: "Review" })).toBeVisible();
    await expect(page.getByText("kanmusu")).toBeVisible();
    await page.getByRole("button", { name: "Show note" }).click();
    await page.getByRole("button", { name: "Good" }).click();
    // #676: the confirmed next review now shows a clock time (Later today / Tomorrow / a dated time),
    // never a bare date — so a same-day short-term interval reads truthfully. The old copy showed only a
    // calendar date, so asserting a time-of-day is a fail-before/pass-after guard.
    await expect(page.getByText(/\b\d{1,2}:\d{2}\s?(AM|PM)\b/u)).toBeVisible();
    await expect(page.getByText(/Due complete/)).toBeVisible();

    // Returning to Today shows the truthful clear state, with the optional Continue section still present.
    await page.goto(`${baseURL}#/`);
    await expect(page.getByText("Done for today.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Due now" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Continue" })).toBeVisible();
  });
});
