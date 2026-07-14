// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./diaryApi", () => ({
  submitDiaryCapture: vi.fn(),
  deleteDiaryEntry: vi.fn(),
  fetchDiaryCalendar: vi.fn(),
  fetchTimeline: vi.fn(),
  updateDiaryEntry: vi.fn()
}));

// The shared rich editor (#570) is exercised in its own suite; here it stands in as a plain textarea so
// the diary's editing behaviour (which document is saved) is asserted without driving Tiptap in jsdom.
vi.mock("../../shared/editor/index.js", async () => {
  const { createTextDocument, documentText } = await import("@whetstone/document");
  const React = await import("react");
  return {
    RichContentEditor: ({
      ariaLabel,
      document,
      onChange
    }: {
      ariaLabel?: string;
      document: unknown;
      onChange: (document: unknown) => void;
    }) =>
      React.createElement("textarea", {
        "aria-label": ariaLabel,
        defaultValue: documentText(document as never),
        onChange: (event: { target: { value: string } }) =>
          onChange(createTextDocument(event.target.value))
      })
  };
});

vi.mock("../capture/voiceCaptureApi", () => ({
  submitVoiceCapture: vi.fn(),
  fetchActiveVoiceCaptures: vi.fn(),
  fetchVoiceCaptureStatus: vi.fn(),
  retryVoiceCapture: vi.fn()
}));

// The page adopts the learner's server-owned timezone once on mount (#606); stub the preferences module
// so grouping is deterministic (the real one performs a network fetch).
vi.mock("../../shared/preferences/preferencesApi", () => ({
  fetchPreferences: vi.fn(),
  resolveBrowserTimeZone: vi.fn()
}));

import type {
  DiaryEntryDto,
  PreferencesDto,
  TimelineDayDto,
  TimelineEntryDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { localDayKey } from "@whetstone/domain";

import { submitVoiceCapture, fetchActiveVoiceCaptures } from "../capture/voiceCaptureApi";
import { fetchPreferences, resolveBrowserTimeZone } from "../../shared/preferences/preferencesApi";
import {
  submitDiaryCapture,
  deleteDiaryEntry,
  fetchDiaryCalendar,
  fetchTimeline,
  updateDiaryEntry
} from "./diaryApi";
import { DiaryPage, dayToUnmarkAfterDelete, type FlatEntry } from "./DiaryPage";
import type { CaptureVoiceDependencies, VoiceRecording } from "../capture/CaptureCard";

const mockedTimeline = vi.mocked(fetchTimeline);
const mockedCalendar = vi.mocked(fetchDiaryCalendar);
const mockedSubmit = vi.mocked(submitDiaryCapture);
const mockedUpdate = vi.mocked(updateDiaryEntry);
const mockedDelete = vi.mocked(deleteDiaryEntry);
const mockedVoiceSubmit = vi.mocked(submitVoiceCapture);
const mockedVoiceActive = vi.mocked(fetchActiveVoiceCaptures);
const mockedPreferences = vi.mocked(fetchPreferences);
const mockedResolveZone = vi.mocked(resolveBrowserTimeZone);

// The learner's zone the page groups by. Use the real browser zone so it matches how the test builds
// in-month dates (MONTH below), keeping grouping deterministic on any machine.
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Dates are built inside the diary's current month so the date-jump calendar actually renders their
// buttons (the grid only draws the visible month).
const MONTH = localDayKey(new Date(), BROWSER_ZONE).slice(0, 7);
const d = (day: number): string => `${MONTH}-${String(day).padStart(2, "0")}`;

// A diary timeline row (#571): a discriminated `kind: "diary"` DTO carrying the rich body + its plaintext.
function tEntry(id: string, occurredAt: string, text: string): TimelineEntryDto {
  return {
    bodyDoc: createTextDocument(text),
    bodyText: text,
    entryId: id,
    kind: "diary",
    language: null,
    occurredAt
  };
}

// A note timeline row — the Timeline is a mixed logical view; the Diary filters these out.
function tNote(id: string, occurredAt: string, text: string): TimelineEntryDto {
  return { entryId: id, kind: "note", occurredAt, text };
}

function tDay(date: string, entries: TimelineEntryDto[]): TimelineDayDto {
  return { date, entries };
}

function entryDto(id: string, dayKey: string, text: string): DiaryEntryDto {
  const occurredAt = `${dayKey}T12:00:00.000Z`;
  return {
    bodyDoc: createTextDocument(text),
    bodyText: text,
    createdAt: occurredAt,
    failureReason: null,
    id,
    inputMode: "typed",
    language: null,
    occurredAt,
    processingStatus: null,
    updatedAt: occurredAt
  };
}

type FakeIntersectionObserver = {
  trigger: (isIntersecting: boolean) => void;
};

let observers: FakeIntersectionObserver[];

class StubObserver {
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push({
      trigger: (isIntersecting) =>
        this.callback(
          [{ isIntersecting } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver
        )
    });
  }

  observe(): void {}
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

async function waitForObserver(): Promise<FakeIntersectionObserver> {
  // The sentinel's IntersectionObserver is created in a post-load effect, so it may not exist the
  // instant the initial render settles. Wait for it rather than reading synchronously (which raced
  // under parallel load and flaked with "no IntersectionObserver was created").
  return waitFor(() => {
    const observer = observers.at(-1);
    if (observer === undefined) {
      throw new Error("no IntersectionObserver was created");
    }
    return observer;
  });
}

function makeCapture(
  overrides?: Partial<{ supported: boolean; startRejects: boolean; stop: () => Promise<Blob> }>
): {
  capture: CaptureVoiceDependencies;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(overrides?.stop ?? (async () => new Blob(["audio"])));
  const recording: VoiceRecording = { stop };
  const start = vi.fn(async () => {
    if (overrides?.startRejects === true) {
      throw new Error("denied");
    }
    return recording;
  });

  return {
    capture: { start, supported: overrides?.supported ?? true },
    start,
    stop
  };
}

async function renderReady(capture: CaptureVoiceDependencies): Promise<void> {
  render(<DiaryPage capture={capture} />);
  await screen.findByRole("heading", { level: 1, name: "Diary" });
}

beforeEach(() => {
  observers = [];
  vi.clearAllMocks();
  mockedTimeline.mockResolvedValue({ days: [] });
  mockedCalendar.mockResolvedValue({ dates: [] });
  mockedVoiceActive.mockResolvedValue([]);
  mockedResolveZone.mockReturnValue(BROWSER_ZONE);
  mockedPreferences.mockResolvedValue({ readingSize: "md", theme: "day", timeZone: BROWSER_ZONE });
  vi.stubGlobal("IntersectionObserver", StubObserver);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DiaryPage timeline", () => {
  it("shows an empty state when there are no entries", async () => {
    await renderReady(makeCapture().capture);

    expect(screen.getByText(/No entries yet/)).toBeTruthy();
  });

  it("ignores a timezone that resolves after the page unmounts (no update on an unmounted page)", async () => {
    let resolvePreferences: ((value: PreferencesDto) => void) | undefined;
    mockedPreferences.mockReturnValueOnce(
      new Promise<PreferencesDto>((resolve) => {
        resolvePreferences = resolve;
      })
    );
    // Never resolve the first page, so nothing but the timezone adoption is in flight.
    mockedTimeline.mockReturnValue(new Promise(() => {}));

    const view = render(<DiaryPage capture={makeCapture().capture} />);
    view.unmount();

    // Resolving after unmount hits the cleanup guard: it must not throw or attempt a state update.
    await act(async () => {
      resolvePreferences?.({ readingSize: "md", theme: "day", timeZone: "America/New_York" });
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { level: 1, name: "Diary" })).toBeNull();
  });

  it("shows a fatal error with retry when the first page fails to load", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockRejectedValueOnce(new Error("boom"));
    mockedTimeline.mockResolvedValue({ days: [] });

    await renderReady(makeCapture().capture);

    expect(screen.getByText(/couldn't open your diary/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByText(/No entries yet/);
  });

  it("groups entries by day, newest-first, stacking same-day entries", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [
        tDay(d(30), [
          tEntry("a", `${d(30)}T08:00:00.000Z`, "first on the 30th"),
          tEntry("b", `${d(30)}T10:00:00.000Z`, "second on the 30th")
        ]),
        tDay(d(29), [tEntry("c", `${d(29)}T09:00:00.000Z`, "only on the 29th")])
      ]
    });

    await renderReady(makeCapture().capture);

    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .filter((heading) => heading.textContent !== "Capture today");
    expect(headings[0]?.textContent).toContain("30");
    expect(headings[1]?.textContent).toContain("29");
    // Within a day the Timeline is newest-first by occurredAt (#571): the 10:00 entry precedes the 08:00.
    const sameDayBodies = screen.getAllByText(/on the 30th/).map((element) => element.textContent);
    expect(sameDayBodies).toEqual(["second on the 30th", "first on the 30th"]);
  });

  it("filters the mixed timeline down to diary entries (#571)", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [
        tDay(d(30), [
          tEntry("diary-a", `${d(30)}T08:00:00.000Z`, "a diary moment"),
          tNote("note-a", `${d(30)}T09:00:00.000Z`, "a study note")
        ])
      ]
    });

    await renderReady(makeCapture().capture);

    // The diary body shows; the note (a different personal Entry kind) is filtered out of the Diary view.
    expect(screen.getByText("a diary moment")).toBeTruthy();
    expect(screen.queryByText("a study note")).toBeNull();
  });
});

describe("DiaryPage capture", () => {
  it("saves a recorded voice capture first and shows it processing", async () => {
    mockedVoiceSubmit.mockResolvedValue({ id: "vc-1", status: "queued" });
    mockedVoiceActive.mockResolvedValueOnce([]).mockResolvedValue([
      {
        failureReason: null,
        id: "vc-1",
        language: "en",
        occurredAt: `${d(30)}T08:00:00.000Z`,
        status: "queued",
        text: null
      }
    ]);
    const { capture, start, stop } = makeCapture();

    await renderReady(capture);

    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.getByText("Listening…")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText("Saved — waiting to transcribe…");
    expect(stop).toHaveBeenCalledOnce();
    expect(mockedVoiceSubmit).toHaveBeenCalledWith(expect.any(Blob), "en");
    // Saved-first: the audio is filed immediately; no synchronous diary text is written on stop.
    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("warns and saves nothing when no speech is caught", async () => {
    const { capture } = makeCapture({ stop: async () => new Blob() });

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText(/Didn't catch any speech/);
    expect(mockedVoiceSubmit).not.toHaveBeenCalled();
  });

  it("warns when the microphone cannot be opened", async () => {
    const { capture } = makeCapture({ startRejects: true });

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await screen.findByText(/Couldn't reach the microphone/);
  });

  it("warns when saving the recorded audio fails", async () => {
    mockedVoiceSubmit.mockRejectedValue(new Error("save down"));
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText(/Couldn't save your capture/);
  });

  it("adds a typed entry via the fallback box and shows a saving state", async () => {
    let resolveCreate: (result: DiaryEntryDto) => void = () => {};
    mockedSubmit.mockImplementation(
      () =>
        new Promise<DiaryEntryDto>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.type(screen.getByLabelText("Capture text"), "a typed thought");
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
    act(() => resolveCreate(entryDto("typed-1", d(30), "a typed thought")));

    await screen.findByText("a typed thought");
    expect(mockedSubmit).toHaveBeenCalledWith("a typed thought", "typed", "en");
  });

  it("scrolls a newly added entry into view so its actions clear the bottom nav (#506)", async () => {
    mockedSubmit.mockResolvedValue(entryDto("typed-1", d(30), "a fresh thought"));
    const { capture } = makeCapture();

    await renderReady(capture);
    (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mockClear();

    await userEvent.type(screen.getByLabelText("Capture text"), "a fresh thought");
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    await screen.findByText("a fresh thought");
    // `block: "nearest"` lifts the entry the minimal amount so its Edit/Delete row is not clipped
    // behind the mobile bottom navigation. The date-jump scroll uses no options, so this arg is what
    // distinguishes the new-entry scroll.
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
    );
  });

  it("ignores an empty typed entry", async () => {
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    expect(mockedSubmit).not.toHaveBeenCalled();
  });

  it("warns when a typed entry fails to save", async () => {
    mockedSubmit.mockRejectedValue(new Error("nope"));
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.type(screen.getByLabelText("Capture text"), "boom");
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    await screen.findByText(/Couldn't save your capture/);
  });

  it("hides the record button when voice capture is unsupported but keeps the typed box", async () => {
    const { capture } = makeCapture({ supported: false });

    await renderReady(capture);

    expect(screen.queryByRole("button", { name: "Tap to talk" })).toBeNull();
    expect(screen.getByLabelText("Capture text")).toBeTruthy();
  });
});

describe("DiaryPage rich edit and delete (#571)", () => {
  beforeEach(() => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [tDay(d(30), [tEntry("e1", `${d(30)}T08:00:00.000Z`, "original text")])]
    });
  });

  it("edits an entry's rich body via the shared editor, leaving siblings untouched", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [
        tDay(d(30), [
          tEntry("e1", `${d(30)}T08:00:00.000Z`, "original text"),
          tEntry("e2", `${d(30)}T09:00:00.000Z`, "sibling text")
        ])
      ]
    });
    mockedUpdate.mockResolvedValue(entryDto("e1", d(30), "edited text"));

    await renderReady(makeCapture().capture);
    // With the newest-first Timeline ordering (#571) the sibling may render first, so target the
    // entry by its text rather than by DOM position.
    const originalItem = screen.getByText("original text").closest("li");
    if (originalItem === null) {
      throw new Error("expected the original entry's list item");
    }
    await userEvent.click(
      within(originalItem as HTMLElement).getByRole("button", { name: "Edit" })
    );
    const editor = screen.getByLabelText("Edit entry");
    await userEvent.clear(editor);
    await userEvent.type(editor, "edited text");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("edited text");
    expect(screen.getByText("sibling text")).toBeTruthy();
    // The rich body is what is persisted — the shared editor's document, not a bare string.
    expect(mockedUpdate).toHaveBeenCalledWith("e1", createTextDocument("edited text"));
  });

  it("does not save a blank edit", async () => {
    await renderReady(makeCapture().capture);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText("Edit entry"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("cancels editing without saving", async () => {
    await renderReady(makeCapture().capture);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByLabelText("Edit entry")).toBeNull();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("warns when an edit fails", async () => {
    mockedUpdate.mockRejectedValue(new Error("nope"));

    await renderReady(makeCapture().capture);
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText(/Couldn't save your edit/);
  });

  it("deletes an entry", async () => {
    mockedDelete.mockResolvedValue();

    await renderReady(makeCapture().capture);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("original text")).toBeNull());
    expect(mockedDelete).toHaveBeenCalledWith("e1");
  });

  it("warns when a delete fails", async () => {
    mockedDelete.mockRejectedValue(new Error("nope"));

    await renderReady(makeCapture().capture);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await screen.findByText(/Couldn't delete that entry/);
  });

  it("removes the calendar mark when the last entry for a day is deleted (#498)", async () => {
    mockedDelete.mockResolvedValue();
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(30)] });

    await renderReady(makeCapture().capture);
    await screen.findByRole("button", { name: `Go to ${d(30)}` });

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("original text")).toBeNull());
    // The day's only entry is gone, so its calendar mark is dropped immediately.
    expect(screen.queryByRole("button", { name: `Go to ${d(30)}` })).toBeNull();
  });

  it("keeps the calendar mark when another entry remains on the day (#498)", async () => {
    mockedDelete.mockResolvedValue();
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [
        tDay(d(30), [
          tEntry("e1", `${d(30)}T08:00:00.000Z`, "original text"),
          tEntry("e2", `${d(30)}T09:00:00.000Z`, "sibling text")
        ])
      ]
    });
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(30)] });

    await renderReady(makeCapture().capture);
    await screen.findByRole("button", { name: `Go to ${d(30)}` });

    // Newest-first ordering (#571) may render the sibling first, so delete the original by its text.
    const originalItem = screen.getByText("original text").closest("li");
    if (originalItem === null) {
      throw new Error("expected the original entry's list item");
    }
    await userEvent.click(
      within(originalItem as HTMLElement).getByRole("button", { name: "Delete" })
    );

    await waitFor(() => expect(screen.queryByText("original text")).toBeNull());
    // A sibling entry still falls on the day, so it stays marked.
    expect(screen.getByText("sibling text")).toBeDefined();
    expect(screen.getByRole("button", { name: `Go to ${d(30)}` })).toBeTruthy();
  });
});

describe("dayToUnmarkAfterDelete", () => {
  const entry = (id: string, date: string): FlatEntry => ({
    bodyDoc: createTextDocument(id),
    bodyText: id,
    date,
    entryId: id,
    kind: "diary",
    language: null,
    occurredAt: `${date}T08:00:00.000Z`
  });

  it("returns undefined when the id is not among the loaded entries", () => {
    expect(dayToUnmarkAfterDelete([entry("a", "2026-07-06")], "missing")).toBeUndefined();
  });

  it("returns undefined when another entry still falls on the deleted entry's day", () => {
    const entries = [entry("a", "2026-07-06"), entry("b", "2026-07-06")];
    expect(dayToUnmarkAfterDelete(entries, "a")).toBeUndefined();
  });

  it("returns the day when the deleted entry was the last one on it", () => {
    const entries = [entry("a", "2026-07-06"), entry("b", "2026-07-05")];
    expect(dayToUnmarkAfterDelete(entries, "a")).toBe("2026-07-06");
  });
});

describe("DiaryPage lazy-load", () => {
  function sevenDays(): { days: TimelineDayDto[] } {
    return {
      days: [28, 27, 26, 25, 24, 23, 22].map((day) =>
        tDay(d(day), [tEntry(`r${day}`, `${d(day)}T08:00:00.000Z`, `entry ${day}`)])
      )
    };
  }

  it("loads older days when the sentinel intersects, then stops at a partial page", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenDays());
    mockedTimeline.mockResolvedValueOnce({
      days: [tDay(d(21), [tEntry("r21", `${d(21)}T08:00:00.000Z`, "entry 21")])]
    });

    await renderReady(makeCapture().capture);
    expect(screen.getByText("entry 22")).toBeTruthy();

    // Not intersecting: nothing fetched.
    const observer = await waitForObserver();
    await act(async () => {
      observer.trigger(false);
    });
    expect(mockedTimeline).toHaveBeenCalledTimes(1);

    await act(async () => {
      observer.trigger(true);
    });

    await screen.findByText("entry 21");
    expect(mockedTimeline).toHaveBeenNthCalledWith(2, d(22), 7);
  });

  it("ignores a re-entrant intersection while a page is in flight", async () => {
    let resolveSecond: (page: { days: TimelineDayDto[] }) => void = () => {};
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenDays());
    mockedTimeline.mockImplementationOnce(
      () =>
        new Promise<{ days: TimelineDayDto[] }>((resolve) => {
          resolveSecond = resolve;
        })
    );

    await renderReady(makeCapture().capture);

    const observer = await waitForObserver();
    await act(async () => {
      observer.trigger(true);
      observer.trigger(true);
    });

    expect(mockedTimeline).toHaveBeenCalledTimes(2);
    await act(async () => {
      resolveSecond({ days: [] });
    });
  });

  it("stops lazy-loading and warns when an older page fails", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenDays());
    mockedTimeline.mockRejectedValueOnce(new Error("page failed"));

    await renderReady(makeCapture().capture);
    const observer = await waitForObserver();
    await act(async () => {
      observer.trigger(true);
    });

    await screen.findByText(/Couldn't load older entries/);
  });
});

describe("DiaryPage date-jump calendar", () => {
  function sevenRecentDays(): { days: TimelineDayDto[] } {
    return {
      days: [28, 27, 26, 25, 24, 23, 22].map((day) =>
        tDay(d(day), [tEntry(`r${day}`, `${d(day)}T08:00:00.000Z`, `entry ${day}`)])
      )
    };
  }

  it("navigates between months, refreshing the marks", async () => {
    await renderReady(makeCapture().capture);
    expect(mockedCalendar).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(mockedCalendar).toHaveBeenCalledTimes(2));

    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    await waitFor(() => expect(mockedCalendar).toHaveBeenCalledTimes(3));
  });

  it("gives the month navigation controls a >=44px hit target in both dimensions (#470)", async () => {
    await renderReady(makeCapture().capture);

    // jsdom has no layout, so assert the sizing utilities: min-h-11 (from the button base) and the
    // min-w-11 added for these icon-only arrows (‹ ›) — both = 44px. Dropping min-w-11 fails here.
    for (const label of ["Previous month", "Next month"]) {
      const button = screen.getByRole("button", { name: label });
      expect(button.className).toContain("min-h-11");
      expect(button.className).toContain("min-w-11");
    }
  });

  it("marks the new entry's day on the calendar immediately after saving (#471)", async () => {
    mockedSubmit.mockResolvedValue(entryDto("typed-1", d(6), "a fresh thought"));
    await renderReady(makeCapture().capture);

    // No marks yet (the calendar fetch returns none).
    expect(screen.queryByRole("button", { name: `Go to ${d(6)}` })).toBeNull();

    await userEvent.type(screen.getByLabelText("Capture text"), "a fresh thought");
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    await screen.findByText("a fresh thought");
    // The day is marked immediately, without a month toggle or reload.
    expect(screen.getByRole("button", { name: `Go to ${d(6)}` })).toBeTruthy();
  });

  it("leaves an already-marked day marked when another entry is added the same day (#471)", async () => {
    // The day is already marked from the calendar fetch; saving another entry that day keeps the mark
    // (the marked-day set is left unchanged rather than needlessly rebuilt).
    mockedCalendar.mockResolvedValue({ dates: [d(6)] });
    mockedSubmit.mockResolvedValue(entryDto("typed-2", d(6), "another thought"));
    await renderReady(makeCapture().capture);
    await screen.findByRole("button", { name: `Go to ${d(6)}` });

    await userEvent.type(screen.getByLabelText("Capture text"), "another thought");
    await userEvent.click(screen.getByRole("button", { name: "Capture" }));

    await screen.findByText("another thought");
    expect(screen.getByRole("button", { name: `Go to ${d(6)}` })).toBeTruthy();
  });

  it("clears marks when the calendar lookup fails", async () => {
    mockedCalendar.mockReset();
    mockedCalendar.mockRejectedValue(new Error("calendar down"));

    await renderReady(makeCapture().capture);

    expect(screen.queryByRole("button", { name: `Go to ${d(15)}` })).toBeNull();
  });

  it("scrolls to an already-loaded day", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [tDay(d(15), [tEntry("m1", `${d(15)}T08:00:00.000Z`, "mid month")])]
    });
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(15)] });

    await renderReady(makeCapture().capture);
    await userEvent.click(await screen.findByRole("button", { name: `Go to ${d(15)}` }));

    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  it("gives the marked-day button a >=44px hit target (#483)", async () => {
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(15)] });

    await renderReady(makeCapture().capture);

    // jsdom has no layout, so assert the sizing utility (size-11 = 44px square); it was size-7 (28px).
    const marked = await screen.findByRole("button", { name: `Go to ${d(15)}` });
    expect(marked.className).toContain("size-11");
  });

  it("lazy-loads older pages until the chosen day is loaded, then scrolls", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenRecentDays());
    mockedTimeline.mockResolvedValueOnce({
      days: [tDay(d(15), [tEntry("m1", `${d(15)}T08:00:00.000Z`, "mid month")])]
    });
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(15)] });

    await renderReady(makeCapture().capture);
    await userEvent.click(await screen.findByRole("button", { name: `Go to ${d(15)}` }));

    await screen.findByText("mid month");
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
    expect(mockedTimeline).toHaveBeenNthCalledWith(2, d(22), 7);
  });

  it("stops paging when the diary runs out before the chosen day is found", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenRecentDays());
    mockedTimeline.mockResolvedValueOnce({ days: [] });
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(15)] });

    await renderReady(makeCapture().capture);
    await userEvent.click(await screen.findByRole("button", { name: `Go to ${d(15)}` }));

    await waitFor(() => expect(mockedTimeline).toHaveBeenCalledTimes(2));
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("warns when a jump's page load fails", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce(sevenRecentDays());
    mockedTimeline.mockRejectedValueOnce(new Error("jump failed"));
    mockedCalendar.mockReset();
    mockedCalendar.mockResolvedValue({ dates: [d(15)] });

    await renderReady(makeCapture().capture);
    await userEvent.click(await screen.findByRole("button", { name: `Go to ${d(15)}` }));

    await screen.findByText(/Couldn't jump to that day/);
  });

  it("renders unmarked days as plain cells", async () => {
    await renderReady(makeCapture().capture);

    // With no marks, the grid still renders day numbers but none are jump buttons.
    expect(
      within(screen.getByLabelText("Jump to a day")).queryByRole("button", {
        name: /^Go to/
      })
    ).toBeNull();
  });
});
