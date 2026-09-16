import { describe, expect, it, vi } from "vitest";

import { sendDueRecitationNotificationIfNeeded } from "./dueRecitationNotification.js";

const TIME_ZONE = "UTC";
const USER_ID = "user-1";
const NOW = () => new Date("2026-09-15T08:00:00.000Z");

describe("sendDueRecitationNotificationIfNeeded", () => {
  it("does not query or send when the day already notified matches today", async () => {
    const loadRecitationOverview = vi.fn();
    const send = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      { dingTalk: { send }, ntfy: undefined, loadRecitationOverview, log: vi.fn(), now: NOW },
      USER_ID,
      TIME_ZONE,
      "2026-09-15"
    );

    expect(loadRecitationOverview).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ notifiedDayKey: "2026-09-15" });
  });

  it("skips sending when nothing is due, leaving notifiedDayKey unset", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({ dueCount: 0, works: [] });
    const send = vi.fn();
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      { dingTalk: { send }, ntfy: undefined, loadRecitationOverview, log, now: NOW },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ notifiedDayKey: undefined });
    expect(log).toHaveBeenCalledWith("info", "due_recitation_notification_skipped", {
      dueCount: 0
    });
  });

  it("sends a due-state message and records today's day key on success", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 2,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        },
        {
          isDue: false,
          nextReviewAt: "2026-09-16T00:00:00.000Z",
          paused: false,
          planEntryId: "plan-2",
          state: "review",
          workEntryId: "work-2",
          workTitle: "Not due"
        }
      ]
    });
    const send = vi.fn().mockResolvedValue({ ok: true });
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      { dingTalk: { send }, ntfy: undefined, loadRecitationOverview, log, now: NOW },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(send).toHaveBeenCalledTimes(1);
    const sentMessage = send.mock.calls[0]?.[0] as string;
    expect(sentMessage).toContain("The Analects");
    expect(sentMessage).not.toContain("Not due");
    expect(result).toEqual({ notifiedDayKey: "2026-09-15" });
    expect(log).toHaveBeenCalledWith("info", "due_recitation_notification_sent", { dueCount: 2 });
  });

  it("pluralizes the heading when more than one Work is due", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 2,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        },
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-2",
          state: "review",
          workEntryId: "work-2",
          workTitle: "Tao Te Ching"
        }
      ]
    });
    const send = vi.fn().mockResolvedValue({ ok: true });
    const log = vi.fn();

    await sendDueRecitationNotificationIfNeeded(
      { dingTalk: { send }, ntfy: undefined, loadRecitationOverview, log, now: NOW },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    const sentMessage = send.mock.calls[0]?.[0] as string;
    expect(sentMessage).toContain("2 Works have recitation due today:");
  });

  it("leaves notifiedDayKey unset when the send fails, so the next check retries", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 1,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        }
      ]
    });
    const send = vi.fn().mockResolvedValue({ error: { kind: "network" }, ok: false });
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      { dingTalk: { send }, ntfy: undefined, loadRecitationOverview, log, now: NOW },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(result).toEqual({ notifiedDayKey: undefined });
    expect(log).toHaveBeenCalledWith("warn", "due_recitation_notification_failed", {
      channel: "dingTalk",
      dueCount: 1,
      error: { kind: "network" }
    });
  });

  it("sends to ntfy independently of DingTalk and succeeds when only ntfy is configured", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 1,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        }
      ]
    });
    const ntfySend = vi.fn().mockResolvedValue({ ok: true });
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      {
        dingTalk: undefined,
        ntfy: { send: ntfySend },
        loadRecitationOverview,
        log,
        now: NOW
      },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(ntfySend).toHaveBeenCalledTimes(1);
    expect(ntfySend.mock.calls[0]?.[0]).toContain("The Analects");
    expect(result).toEqual({ notifiedDayKey: "2026-09-15" });
    expect(log).toHaveBeenCalledWith("info", "due_recitation_notification_sent", { dueCount: 1 });
  });

  it("records the day notified when one channel succeeds even if the other fails", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 1,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        }
      ]
    });
    const dingTalkSend = vi.fn().mockResolvedValue({ error: { kind: "network" }, ok: false });
    const ntfySend = vi.fn().mockResolvedValue({ ok: true });
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      {
        dingTalk: { send: dingTalkSend },
        ntfy: { send: ntfySend },
        loadRecitationOverview,
        log,
        now: NOW
      },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(dingTalkSend).toHaveBeenCalledTimes(1);
    expect(ntfySend).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ notifiedDayKey: "2026-09-15" });
    expect(log).toHaveBeenCalledWith("warn", "due_recitation_notification_failed", {
      channel: "dingTalk",
      dueCount: 1,
      error: { kind: "network" }
    });
    expect(log).toHaveBeenCalledWith("info", "due_recitation_notification_sent", { dueCount: 1 });
  });

  it("leaves notifiedDayKey unset only when every configured channel fails", async () => {
    const loadRecitationOverview = vi.fn().mockResolvedValue({
      dueCount: 1,
      works: [
        {
          isDue: true,
          nextReviewAt: null,
          paused: false,
          planEntryId: "plan-1",
          state: "review",
          workEntryId: "work-1",
          workTitle: "The Analects"
        }
      ]
    });
    const dingTalkSend = vi.fn().mockResolvedValue({ error: { kind: "network" }, ok: false });
    const ntfySend = vi.fn().mockResolvedValue({ error: { kind: "http", status: 500 }, ok: false });
    const log = vi.fn();

    const result = await sendDueRecitationNotificationIfNeeded(
      {
        dingTalk: { send: dingTalkSend },
        ntfy: { send: ntfySend },
        loadRecitationOverview,
        log,
        now: NOW
      },
      USER_ID,
      TIME_ZONE,
      undefined
    );

    expect(result).toEqual({ notifiedDayKey: undefined });
    expect(log).not.toHaveBeenCalledWith(
      "info",
      "due_recitation_notification_sent",
      expect.anything()
    );
  });
});
