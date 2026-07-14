// The pure Today board composer (#610). Today is a read model over feature-owned obligations and
// invitations, never a task ledger: this module takes already-fetched, typed source results and folds
// them into one deterministic board. It is dependency-free (no React, Fastify, DB, or fs) and holds no
// state, so every ordering, grouping, and clear-state rule is unit-testable in isolation.
//
// It is generic over the two Continue payloads (the latest reading position and the authored Work
// summary) precisely so `domain` never imports `contracts` (contracts already depends on domain): the
// server instantiates the payloads with their DTO types, then validates the whole board at the API
// boundary. The routine obligations are fully concrete here — their shape is the product logic Today owns.

// The deterministic-obligation sources Today groups into one row each (#609 Recitation, Memory review).
export type TodayRoutineKind = "recitation" | "memory";

// A routine's due summary from its owning feature: the raw counts plus the earliest due instant. By
// construction of every source, `nextDueAt` is non-null exactly when the routine has due work
// (`dueCount > 0`) and null when it is clear or paused — so the composer keys due-ness off `nextDueAt`.
export type TodayRoutineSummary = Readonly<{
  dueCount: number;
  nextDueAt: string | null;
  overdueCount: number;
}>;

// A routine source result: its summary, or a failed load. A failed routine never yields a due row and
// always lands in `routineFailures`, so it can never contribute to a false clear state.
export type TodayRoutineSource =
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ok"; summary: TodayRoutineSummary }>;

// An optional-invitation source carrying a nullable payload (a position, a Work): present, absent, or a
// failed load. Invitations never block the clear state; a failure surfaces as a quiet client retry.
export type TodayInvitationSource<Payload> =
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ok"; value: Payload | null }>;

// The Recitation "New passage" source (#607): the plan to route into when a new passage is available,
// null when it is not, or a failed load. `planEntryId` non-null is the availability discriminant.
export type TodayNewPassageSource =
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ok"; planEntryId: string | null }>;

// One grouped Due-now routine row: a strictly-positive count, its overdue emphasis, and the instant the
// board orders by.
export type TodayRoutineComposition = Readonly<{
  dueCount: number;
  kind: TodayRoutineKind;
  nextDueAt: string;
  overdue: boolean;
  overdueCount: number;
}>;

export type TodayContinueReading<Position> =
  | Readonly<{ position: Position; status: "ready" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "failed" }>;

export type TodayContinueWriting<Work> =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ready"; work: Work }>;

export type TodayNewPassage =
  | Readonly<{ planEntryId: string; status: "available" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "unavailable" }>;

export type TodayBoard<Position, Work> = Readonly<{
  clear: boolean;
  continueReading: TodayContinueReading<Position>;
  continueWriting: TodayContinueWriting<Work>;
  date: string;
  dueNow: ReadonlyArray<TodayRoutineComposition>;
  newPassage: TodayNewPassage;
  routineFailures: ReadonlyArray<TodayRoutineKind>;
}>;

export type ComposeTodayBoardInput<Position, Work> = Readonly<{
  date: string;
  memory: TodayRoutineSource;
  newPassage: TodayNewPassageSource;
  reading: TodayInvitationSource<Position>;
  recitation: TodayRoutineSource;
  writing: TodayInvitationSource<Work>;
}>;

// Order Due now: overdue routines first, then earliest `nextDueAt` ascending, then kind as a stable
// deterministic tie-break (kinds are always distinct). ISO instants compare chronologically as strings.
function compareRoutines(a: TodayRoutineComposition, b: TodayRoutineComposition): number {
  if (a.overdue !== b.overdue) {
    return a.overdue ? -1 : 1;
  }
  if (a.nextDueAt !== b.nextDueAt) {
    return a.nextDueAt < b.nextDueAt ? -1 : 1;
  }
  return a.kind < b.kind ? -1 : 1;
}

function toContinueReading<Position>(
  source: TodayInvitationSource<Position>
): TodayContinueReading<Position> {
  if (source.status === "failed") {
    return { status: "failed" };
  }
  return source.value === null ? { status: "empty" } : { position: source.value, status: "ready" };
}

function toContinueWriting<Work>(source: TodayInvitationSource<Work>): TodayContinueWriting<Work> {
  if (source.status === "failed") {
    return { status: "failed" };
  }
  return source.value === null ? { status: "empty" } : { status: "ready", work: source.value };
}

function toNewPassage(source: TodayNewPassageSource): TodayNewPassage {
  if (source.status === "failed") {
    return { status: "failed" };
  }
  return source.planEntryId === null
    ? { status: "unavailable" }
    : { planEntryId: source.planEntryId, status: "available" };
}

export function composeTodayBoard<Position, Work>(
  input: ComposeTodayBoardInput<Position, Work>
): TodayBoard<Position, Work> {
  const dueNow: TodayRoutineComposition[] = [];
  const routineFailures: TodayRoutineKind[] = [];

  // Fixed iteration order (recitation, then memory) so `routineFailures` is deterministic; the due rows
  // are re-sorted by obligation priority below.
  const routines: ReadonlyArray<Readonly<{ kind: TodayRoutineKind; source: TodayRoutineSource }>> =
    [
      { kind: "recitation", source: input.recitation },
      { kind: "memory", source: input.memory }
    ];
  for (const { kind, source } of routines) {
    if (source.status === "failed") {
      routineFailures.push(kind);
      continue;
    }
    const { summary } = source;
    // A routine appears in Due now only when it has due work; a paused or zero-due routine has a null
    // `nextDueAt` and is excluded (never an invented obligation).
    if (summary.nextDueAt !== null) {
      dueNow.push({
        dueCount: summary.dueCount,
        kind,
        nextDueAt: summary.nextDueAt,
        overdue: summary.overdueCount > 0,
        overdueCount: summary.overdueCount
      });
    }
  }
  dueNow.sort(compareRoutines);

  return {
    // Clear only when nothing is due AND every routine source loaded: a failed routine keeps the board
    // un-clear rather than presenting a false "all clear".
    clear: dueNow.length === 0 && routineFailures.length === 0,
    continueReading: toContinueReading(input.reading),
    continueWriting: toContinueWriting(input.writing),
    date: input.date,
    dueNow,
    newPassage: toNewPassage(input.newPassage),
    routineFailures
  };
}
