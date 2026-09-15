import { localDayKey } from "@whetstone/domain";
import type { RecitationOverviewDto } from "@whetstone/contracts";

import type { DingTalkClient } from "./dingTalkClient.js";

export type DueRecitationNotificationDependencies = Readonly<{
  dingTalk: DingTalkClient;
  loadRecitationOverview: (userId: string, now: Date) => Promise<RecitationOverviewDto>;
  log: (event: string, fields: Record<string, unknown>) => void;
  now: () => Date;
}>;

export type DueRecitationNotificationResult = Readonly<{ notifiedDayKey: string | undefined }>;

function composeMessage(dueWorkTitles: readonly string[]): string {
  const heading =
    dueWorkTitles.length === 1
      ? "1 Work has recitation due today:"
      : `${dueWorkTitles.length} Works have recitation due today:`;
  return [heading, ...dueWorkTitles.map((title) => `- ${title}`)].join("\n");
}

// The daily due-recitation forward (#933): a deterministic, best-effort forward of state Whetstone
// already computes (`loadRecitationOverview`'s due count/Works), never a new scheduling or grading
// capability. Sends at most once per learner local day — `lastNotifiedDayKey` is the caller's
// in-memory record of the last day a send succeeded; a day already notified is a no-op (no query, no
// send). A failed send leaves `notifiedDayKey` unset so the next check retries rather than silently
// marking the day "done" (PRODUCT.md: never fabricate a due-complete state).
export async function sendDueRecitationNotificationIfNeeded(
  dependencies: DueRecitationNotificationDependencies,
  userId: string,
  timeZone: string,
  lastNotifiedDayKey: string | undefined
): Promise<DueRecitationNotificationResult> {
  const { dingTalk, loadRecitationOverview, log, now } = dependencies;
  const todayKey = localDayKey(now(), timeZone);

  if (todayKey === lastNotifiedDayKey) {
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  const overview = await loadRecitationOverview(userId, now());
  if (overview.dueCount === 0) {
    log("due_recitation_notification_skipped", { dueCount: 0 });
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  const dueWorkTitles = overview.works.filter((work) => work.isDue).map((work) => work.workTitle);
  const result = await dingTalk.send(composeMessage(dueWorkTitles));

  if (!result.ok) {
    log("due_recitation_notification_failed", { dueCount: overview.dueCount, error: result.error });
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  log("due_recitation_notification_sent", { dueCount: overview.dueCount });
  return { notifiedDayKey: todayKey };
}
