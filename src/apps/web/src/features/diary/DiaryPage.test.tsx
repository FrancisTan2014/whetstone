// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./diaryApi", () => ({
  submitDiaryCapture: vi.fn(),
  deleteDiaryEntry: vi.fn(),
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
  loadPersistedTimeZone: vi.fn(),
  resolveBrowserTimeZone: vi.fn()
}));

import type { DiaryEntryDto, TimelineDayDto, TimelineEntryDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { localDayKey } from "@whetstone/domain";

import { submitVoiceCapture, fetchActiveVoiceCaptures } from "../capture/voiceCaptureApi";
import {
  loadPersistedTimeZone,
  resolveBrowserTimeZone
} from "../../shared/preferences/preferencesApi";
import { submitDiaryCapture, deleteDiaryEntry, fetchTimeline, updateDiaryEntry } from "./diaryApi";
import { DiaryPage } from "./DiaryPage";
import { clearDiarySession } from "./diarySessionStore";
import type { CaptureVoiceDependencies, VoiceRecording } from "../capture/CaptureCard";

const mockedTimeline = vi.mocked(fetchTimeline);
const mockedSubmit = vi.mocked(submitDiaryCapture);
const mockedUpdate = vi.mocked(updateDiaryEntry);
const mockedDelete = vi.mocked(deleteDiaryEntry);
const mockedVoiceSubmit = vi.mocked(submitVoiceCapture);
const mockedVoiceActive = vi.mocked(fetchActiveVoiceCaptures);
const mockedZone = vi.mocked(loadPersistedTimeZone);
const mockedResolveZone = vi.mocked(resolveBrowserTimeZone);

// The learner's zone the page groups by. Use the real browser zone so it matches how the test builds
// in-month dates (MONTH below), keeping grouping deterministic on any machine.
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Dates are built inside the current month; `d(day)` yields a `YYYY-MM-DD` day key for the timeline.
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
  return {
    captureSource: "reader",
    entryId: id,
    kind: "note",
    occurredAt,
    promptCount: 0,
    text
  };
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
  // The Diary remembers its place for the app session (#648); clear it so each case starts fresh at the
  // top and its first render fetches rather than restoring a previous case's snapshot.
  clearDiarySession();
  mockedTimeline.mockResolvedValue({ days: [] });
  mockedVoiceActive.mockResolvedValue([]);
  mockedResolveZone.mockReturnValue(BROWSER_ZONE);
  mockedZone.mockResolvedValue(BROWSER_ZONE);
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
    let resolveZone: ((value: string) => void) | undefined;
    mockedZone.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveZone = resolve;
      })
    );
    // Never resolve the first page, so nothing but the timezone adoption is in flight.
    mockedTimeline.mockReturnValue(new Promise(() => {}));

    const view = render(<DiaryPage capture={makeCapture().capture} />);
    view.unmount();

    // Resolving after unmount hits the cleanup guard: it must not throw or attempt a state update.
    await act(async () => {
      resolveZone?.("America/New_York");
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { level: 1, name: "Diary" })).toBeNull();
  });

  it("ignores a failed timezone resolve after the page unmounts (no update on an unmounted page)", async () => {
    let rejectZone: ((reason?: unknown) => void) | undefined;
    mockedZone.mockReset();
    mockedZone.mockReturnValueOnce(
      new Promise<string>((_resolve, reject) => {
        rejectZone = reject;
      })
    );
    // Never resolve the first page, so nothing but the timezone adoption is in flight.
    mockedTimeline.mockReturnValue(new Promise(() => {}));

    const view = render(<DiaryPage capture={makeCapture().capture} />);
    view.unmount();

    // Rejecting after unmount hits the cleanup guard on the failure path: no throw, no state update.
    await act(async () => {
      rejectZone?.(new Error("preferences unavailable"));
      await Promise.resolve();
    });

    expect(screen.queryByRole("heading", { level: 1, name: "Diary" })).toBeNull();
  });

  it("waits for the persisted learner zone before the first timeline load, so paging uses the browser-zone cursor (#606)", async () => {
    // First use: the browser zone persists only after a tick. Until it lands, the server's timeline
    // would answer in its UTC fallback with a UTC-grouped cursor — the page must not page off that.
    // Hold the zone, prove no timeline fetch happens, then release it.
    let resolveZone: ((value: string) => void) | undefined;
    mockedZone.mockReset();
    mockedZone.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveZone = resolve;
      })
    );
    // A full first page (7 days) grouped in the learner's browser zone, so its oldest day-key cursor is
    // the browser-zone key d(22) — only reachable because the load waited for the zone to persist.
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce({
      days: [28, 27, 26, 25, 24, 23, 22].map((day) =>
        tDay(d(day), [tEntry(`r${day}`, `${d(day)}T08:00:00.000Z`, `entry ${day}`)])
      )
    });
    mockedTimeline.mockResolvedValueOnce({
      days: [tDay(d(21), [tEntry("r21", `${d(21)}T08:00:00.000Z`, "entry 21")])]
    });

    render(<DiaryPage capture={makeCapture().capture} />);

    // Gate holds: no timeline request until the zone is persisted (the bug fetched it immediately).
    expect(mockedTimeline).not.toHaveBeenCalled();

    await act(async () => {
      resolveZone?.(BROWSER_ZONE);
      await Promise.resolve();
    });

    await screen.findByText("entry 22");
    expect(mockedTimeline).toHaveBeenNthCalledWith(1, undefined, 7);

    // Older-page load pages off the browser-zone cursor from that first (post-persistence) page.
    const observer = await waitForObserver();
    await act(async () => {
      observer.trigger(true);
    });

    await screen.findByText("entry 21");
    expect(mockedTimeline).toHaveBeenNthCalledWith(2, d(22), 7);
  });

  it("still loads the timeline under the browser-zone fallback when resolving the persisted zone fails (#606)", async () => {
    mockedZone.mockReset();
    mockedZone.mockRejectedValueOnce(new Error("preferences unavailable"));

    await renderReady(makeCapture().capture);

    expect(screen.getByText(/No entries yet/)).toBeTruthy();
    expect(mockedTimeline).toHaveBeenCalledWith(undefined, 7);
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
    expect(mockedVoiceSubmit).toHaveBeenCalledWith(expect.any(Blob));
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
    expect(mockedSubmit).toHaveBeenCalledWith("a typed thought", "typed");
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

  it("removes a day's section from the timeline when its last entry is deleted", async () => {
    mockedDelete.mockResolvedValue();

    await renderReady(makeCapture().capture);
    expect(screen.getByText("original text")).toBeDefined();

    await userEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByText("original text")).toBeNull());
    // The day's only entry is gone, so the timeline falls back to its empty state.
    expect(screen.getByText(/No entries yet/)).toBeDefined();
  });

  it("keeps the day section and its sibling when one of two same-day entries is deleted", async () => {
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

    await renderReady(makeCapture().capture);

    // Newest-first ordering (#571) may render the sibling first, so delete the original by its text.
    const originalItem = screen.getByText("original text").closest("li");
    if (originalItem === null) {
      throw new Error("expected the original entry's list item");
    }
    await userEvent.click(
      within(originalItem as HTMLElement).getByRole("button", { name: "Delete" })
    );

    await waitFor(() => expect(screen.queryByText("original text")).toBeNull());
    // A sibling entry still falls on the day, so the day section stays (no empty state).
    expect(screen.getByText("sibling text")).toBeDefined();
    expect(screen.queryByText(/No entries yet/)).toBeNull();
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

describe("DiaryPage scroll restoration (#648)", () => {
  // The Diary scroll container is the AppShell `<main>`; wrap the page in one so `closest("main")` resolves
  // to a real, scrollable ancestor the way it does in the app.
  function renderInScroller(capture: CaptureVoiceDependencies): ReturnType<typeof render> {
    return render(
      <main data-testid="scroller">
        <DiaryPage capture={capture} />
      </main>
    );
  }

  it("restores the remembered timeline and scroll offset when returning to Diary in the same session", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [tDay(d(28), [tEntry("r28", `${d(28)}T08:00:00.000Z`, "a remembered thought")])]
    });

    const first = renderInScroller(makeCapture().capture);
    await screen.findByRole("heading", { level: 1, name: "Diary" });
    await screen.findByText("a remembered thought");

    // The learner scrolls down; the passive listener remembers the offset for the session.
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 240;
    fireEvent.scroll(scroller);

    first.unmount();

    // Returning must restore from the remembered snapshot without refetching the first page.
    mockedTimeline.mockClear();
    renderInScroller(makeCapture().capture);

    await screen.findByText("a remembered thought");
    expect(mockedTimeline).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId("scroller").scrollTop).toBe(240));
  });

  it("remembers older pages loaded before leaving, so returning restores the fuller timeline", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValueOnce({
      days: [28, 27, 26, 25, 24, 23, 22].map((day) =>
        tDay(d(day), [tEntry(`r${day}`, `${d(day)}T08:00:00.000Z`, `entry ${day}`)])
      )
    });
    mockedTimeline.mockResolvedValueOnce({
      days: [tDay(d(21), [tEntry("r21", `${d(21)}T08:00:00.000Z`, "older entry 21")])]
    });

    const first = renderInScroller(makeCapture().capture);
    await screen.findByText("entry 28");

    const observer = await waitForObserver();
    await act(async () => {
      observer.trigger(true);
    });
    await screen.findByText("older entry 21");

    first.unmount();

    // On return, the older page loaded before leaving is still present without any further fetch.
    mockedTimeline.mockClear();
    renderInScroller(makeCapture().capture);

    await screen.findByText("older entry 21");
    expect(screen.getByText("entry 28")).toBeDefined();
    expect(mockedTimeline).not.toHaveBeenCalled();
  });

  it("starts fresh at the top after the session is cleared", async () => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [tDay(d(28), [tEntry("r28", `${d(28)}T08:00:00.000Z`, "a remembered thought")])]
    });

    const first = renderInScroller(makeCapture().capture);
    await screen.findByText("a remembered thought");
    first.unmount();

    // A new app session (e.g. a full reload) forgets the place: the next open fetches the first page again.
    clearDiarySession();
    mockedTimeline.mockClear();
    renderInScroller(makeCapture().capture);

    await screen.findByText("a remembered thought");
    expect(mockedTimeline).toHaveBeenCalledTimes(1);
  });
});
