// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./diaryApi", () => ({
  createDiaryEntry: vi.fn(),
  deleteDiaryEntry: vi.fn(),
  fetchDiaryCalendar: vi.fn(),
  fetchTimeline: vi.fn(),
  updateDiaryEntry: vi.fn()
}));

vi.mock("../session/sessionApi", () => ({ transcribe: vi.fn() }));

import type { DiaryEntryDto, TimelineDayDto, TimelineEntryDto } from "@whetstone/contracts";
import { toDayKey } from "@whetstone/domain";

import { transcribe } from "../session/sessionApi";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  fetchDiaryCalendar,
  fetchTimeline,
  updateDiaryEntry
} from "./diaryApi";
import { DiaryPage, type DiaryCaptureDependencies, type DiaryRecording } from "./DiaryPage";

const mockedTimeline = vi.mocked(fetchTimeline);
const mockedCalendar = vi.mocked(fetchDiaryCalendar);
const mockedCreate = vi.mocked(createDiaryEntry);
const mockedUpdate = vi.mocked(updateDiaryEntry);
const mockedDelete = vi.mocked(deleteDiaryEntry);
const mockedTranscribe = vi.mocked(transcribe);

// Dates are built inside the diary's current month so the date-jump calendar actually renders their
// buttons (the grid only draws the visible month).
const MONTH = toDayKey(new Date()).slice(0, 7);
const d = (day: number): string => `${MONTH}-${String(day).padStart(2, "0")}`;

function tEntry(id: string, createdAt: string, text: string): TimelineEntryDto {
  return { createdAt, id, kind: "diary", language: null, text };
}

function tDay(date: string, entries: TimelineEntryDto[]): TimelineDayDto {
  return { date, entries };
}

function entryDto(id: string, entryDate: string, text: string): DiaryEntryDto {
  return { createdAt: `${entryDate}T12:00:00.000Z`, entryDate, id, language: null, text };
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
  capture: DiaryCaptureDependencies;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(overrides?.stop ?? (async () => new Blob(["audio"])));
  const recording: DiaryRecording = { stop };
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

async function renderReady(capture: DiaryCaptureDependencies): Promise<void> {
  render(<DiaryPage capture={capture} />);
  await screen.findByRole("heading", { level: 1, name: "Diary" });
}

beforeEach(() => {
  observers = [];
  vi.clearAllMocks();
  mockedTimeline.mockResolvedValue({ days: [] });
  mockedCalendar.mockResolvedValue({ dates: [] });
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

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings[0]?.textContent).toContain("30");
    expect(headings[1]?.textContent).toContain("29");
    expect(screen.getByText("first on the 30th")).toBeTruthy();
    expect(screen.getByText("second on the 30th")).toBeTruthy();
  });
});

describe("DiaryPage capture", () => {
  it("records, transcribes, tidies and files a new entry under today", async () => {
    mockedTranscribe.mockResolvedValue({ transcript: "um hello there", words: [] });
    mockedCreate.mockResolvedValue(entryDto("new-1", d(30), "hello there"));
    const { capture, start, stop } = makeCapture();

    await renderReady(capture);

    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    expect(start).toHaveBeenCalledOnce();
    expect(screen.getByText("Listening…")).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText("hello there");
    expect(stop).toHaveBeenCalledOnce();
    expect(mockedCreate).toHaveBeenCalledWith("um hello there");
  });

  it("warns and saves nothing when the transcript is blank", async () => {
    mockedTranscribe.mockResolvedValue({ transcript: "   ", words: [] });
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText(/Didn't catch any speech/);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("warns when the microphone cannot be opened", async () => {
    const { capture } = makeCapture({ startRejects: true });

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));

    await screen.findByText(/Couldn't access the microphone/);
  });

  it("warns when transcription or saving fails", async () => {
    mockedTranscribe.mockRejectedValue(new Error("stt down"));
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Tap to talk" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop & save" }));

    await screen.findByText(/Something went wrong saving your entry/);
  });

  it("adds a typed entry via the fallback box and shows a saving state", async () => {
    let resolveCreate: (entry: DiaryEntryDto) => void = () => {};
    mockedCreate.mockImplementation(
      () =>
        new Promise<DiaryEntryDto>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.type(screen.getByLabelText("Or write it down"), "a typed thought");
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));

    expect(screen.getAllByText("Saving…").length).toBeGreaterThan(0);
    act(() => resolveCreate(entryDto("typed-1", d(30), "a typed thought")));

    await screen.findByText("a typed thought");
    expect(mockedCreate).toHaveBeenCalledWith("a typed thought");
  });

  it("ignores an empty typed entry", async () => {
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));

    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("warns when a typed entry fails to save", async () => {
    mockedCreate.mockRejectedValue(new Error("nope"));
    const { capture } = makeCapture();

    await renderReady(capture);
    await userEvent.type(screen.getByLabelText("Or write it down"), "boom");
    await userEvent.click(screen.getByRole("button", { name: "Add entry" }));

    await screen.findByText(/Something went wrong saving your entry/);
  });

  it("hides the record button when voice capture is unsupported but keeps the typed box", async () => {
    const { capture } = makeCapture({ supported: false });

    await renderReady(capture);

    expect(screen.queryByRole("button", { name: "Tap to talk" })).toBeNull();
    expect(screen.getByLabelText("Or write it down")).toBeTruthy();
  });
});

describe("DiaryPage edit and delete", () => {
  beforeEach(() => {
    mockedTimeline.mockReset();
    mockedTimeline.mockResolvedValue({
      days: [tDay(d(30), [tEntry("e1", `${d(30)}T08:00:00.000Z`, "original text")])]
    });
  });

  it("edits an entry's text, leaving its siblings untouched", async () => {
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
    const [firstEdit] = screen.getAllByRole("button", { name: "Edit" });
    if (firstEdit === undefined) {
      throw new Error("expected an Edit button");
    }
    await userEvent.click(firstEdit);
    const editor = screen.getByLabelText("Edit entry");
    await userEvent.clear(editor);
    await userEvent.type(editor, "edited text");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByText("edited text");
    expect(screen.getByText("sibling text")).toBeTruthy();
    expect(mockedUpdate).toHaveBeenCalledWith("e1", "edited text");
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
