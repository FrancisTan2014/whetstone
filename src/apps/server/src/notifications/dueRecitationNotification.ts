import { localDayKey } from "@whetstone/domain";
import type { RecitationOverviewDto } from "@whetstone/contracts";

import type { DingTalkClient } from "./dingTalkClient.js";
import type { NtfyClient } from "./ntfyClient.js";

export type DueRecitationNotificationDependencies = Readonly<{
  // Both channels are optional and independent (#936): either, both, or (with the interval simply not
  // scheduled) neither may be configured. Each configured channel is sent to regardless of whether the
  // other succeeds or fails, so a broken DingTalk webhook never silently suppresses the ntfy push to a
  // phone, and vice versa.
  dingTalk: DingTalkClient | undefined;
  ntfy: NtfyClient | undefined;
  loadRecitationOverview: (userId: string, now: Date) => Promise<RecitationOverviewDto>;
  log: (level: "info" | "warn", event: string, fields: Record<string, unknown>) => void;
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

// The daily due-recitation forward (#933, plus the ntfy iPhone push channel added by #936): a
// deterministic, best-effort forward of state Whetstone already computes (`loadRecitationOverview`'s
// due count/Works), never a new scheduling or grading capability. Sends at most once per learner local
// day — `lastNotifiedDayKey` is the caller's in-memory record of the last day at least one configured
// channel's send succeeded; a day already notified is a no-op (no query, no send). Only when every
// configured channel's send fails does `notifiedDayKey` stay unset, so the next check retries rather
// than silently marking the day "done" (PRODUCT.md: never fabricate a due-complete state).
export async function sendDueRecitationNotificationIfNeeded(
  dependencies: DueRecitationNotificationDependencies,
  userId: string,
  timeZone: string,
  lastNotifiedDayKey: string | undefined
): Promise<DueRecitationNotificationResult> {
  const { dingTalk, ntfy, loadRecitationOverview, log, now } = dependencies;
  const nowInstant = now();
  const todayKey = localDayKey(nowInstant, timeZone);

  if (todayKey === lastNotifiedDayKey) {
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  const overview = await loadRecitationOverview(userId, nowInstant);
  if (overview.dueCount === 0) {
    log("info", "due_recitation_notification_skipped", { dueCount: 0 });
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  const dueWorkTitles = overview.works.filter((work) => work.isDue).map((work) => work.workTitle);
  const message = composeMessage(dueWorkTitles);

  // Fan out to every configured channel independently (#936): a channel's failure never withholds the
  // send attempt on another configured channel. The day is recorded notified as soon as at least one
  // configured channel succeeds — a learner who receives the nudge on their phone (or in the shared
  // DingTalk group) has been notified for the day even if a second, differently-configured channel is
  // down, and a later fix to that channel is not owed a re-send of today's already-delivered nudge. Only
  // when every configured channel fails does the day stay unnotified so the next poll retries all of them.
  let anySucceeded = false;
  if (dingTalk !== undefined) {
    const result = await dingTalk.send(message);
    if (result.ok) {
      anySucceeded = true;
    } else {
      log("warn", "due_recitation_notification_failed", {
        channel: "dingTalk",
        dueCount: overview.dueCount,
        error: result.error
      });
    }
  }
  if (ntfy !== undefined) {
    const result = await ntfy.send(message);
    if (result.ok) {
      anySucceeded = true;
    } else {
      log("warn", "due_recitation_notification_failed", {
        channel: "ntfy",
        dueCount: overview.dueCount,
        error: result.error
      });
    }
  }

  if (!anySucceeded) {
    return { notifiedDayKey: lastNotifiedDayKey };
  }

  log("info", "due_recitation_notification_sent", { dueCount: overview.dueCount });
  return { notifiedDayKey: todayKey };
}
