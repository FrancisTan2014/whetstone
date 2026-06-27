import { useEffect, useState } from "react";

import type { MapCaseDto, MapDomainDto, ProgressMapDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchProgressMap } from "./progressApi";
import { lightLabel, lightTileClass } from "./progressLight.tokens";

type LoadState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ map: ProgressMapDto; status: "ready" }>;

type ProgressMapPageProps = Readonly<{
  // The entry to start a session from a chosen region. When provided, each case becomes an actionable
  // tile; the practice slice wires this. Absent (today) -> the map is read-only.
  onStartRegion?: (caseId: string) => void;
}>;

function humanizeCategory(category: string): string {
  return category.replace(/_/g, " ");
}

export function ProgressMapPage({ onStartRegion }: ProgressMapPageProps): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const map = await fetchProgressMap();
        setState({ map, status: "ready" });
      } catch {
        setState({ status: "error" });
      }
    }

    void load();
  }, []);

  async function refresh(): Promise<void> {
    setState({ status: "loading" });
    try {
      const map = await fetchProgressMap();
      setState({ map, status: "ready" });
    } catch {
      setState({ status: "error" });
    }
  }

  return (
    <section aria-labelledby="progress-heading" className="mx-auto max-w-4xl p-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold text-text" id="progress-heading">
          Your world
        </h1>
        <Button onClick={() => void refresh()} variant="secondary">
          Refresh
        </Button>
      </div>

      <div className="mt-6">{renderState(state, onStartRegion)}</div>
    </section>
  );
}

function renderState(
  state: LoadState,
  onStartRegion: ((caseId: string) => void) | undefined
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Mapping your progress…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your progress map. Please try again.
      </p>
    );
  }

  return <ProgressMap map={state.map} onStartRegion={onStartRegion} />;
}

function ProgressMap({
  map,
  onStartRegion
}: Readonly<{
  map: ProgressMapDto;
  onStartRegion: ((caseId: string) => void) | undefined;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-8">
      <ProgressSignals map={map} />
      {map.domains.map((domain) => (
        <DomainSection domain={domain} key={domain.domain.id} onStartRegion={onStartRegion} />
      ))}
    </div>
  );
}

function ProgressSignals({ map }: Readonly<{ map: ProgressMapDto }>): React.JSX.Element {
  const { signals } = map;

  return (
    <div aria-label="Progress signals" className="rounded border border-border bg-surface p-4">
      <p className="text-text">{signals.summary}</p>
      <ul
        aria-label="Progress counts"
        className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-muted"
      >
        <li>Owned {signals.ownedChunks}</li>
        <li>Needs review {signals.weakChunks}</li>
        <li>{signals.totalChunks} in your world</li>
      </ul>

      <div className="mt-3">
        <h2 className="text-sm font-medium text-text">Error trend</h2>
        {signals.errorTrend.length === 0 ? (
          <p className="text-sm text-text-muted">No recurring errors yet.</p>
        ) : (
          <ul aria-label="Error trend" className="mt-1 flex flex-wrap gap-2">
            {signals.errorTrend.map((pattern) => (
              <li
                className="rounded border border-border px-2 py-1 text-sm text-text-muted"
                key={pattern.category}
              >
                {humanizeCategory(pattern.category)} · {pattern.count}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DomainSection({
  domain,
  onStartRegion
}: Readonly<{
  domain: MapDomainDto;
  onStartRegion: ((caseId: string) => void) | undefined;
}>): React.JSX.Element {
  return (
    <section aria-label={domain.domain.name}>
      <h2 className="text-lg font-semibold text-text">{domain.domain.name}</h2>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {domain.cases.map((mapCase) => (
          <CaseTile caseEntry={mapCase} key={mapCase.caseId} onStartRegion={onStartRegion} />
        ))}
      </div>
    </section>
  );
}

function CaseTile({
  caseEntry,
  onStartRegion
}: Readonly<{
  caseEntry: MapCaseDto;
  onStartRegion: ((caseId: string) => void) | undefined;
}>): React.JSX.Element {
  const ring = caseEntry.recommended ? " ring-2 ring-ring" : "";
  const className = `flex flex-col gap-1 rounded border p-4 text-left ${lightTileClass(
    caseEntry.light
  )}${ring}`;
  const label = `${caseEntry.situation} — ${lightLabel(caseEntry.light)}${
    caseEntry.recommended ? ", recommended next" : ""
  }`;

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{caseEntry.situation}</span>
        {caseEntry.recommended ? (
          <span className="rounded bg-accent px-2 py-0.5 text-xs font-medium text-accent-fg">
            Recommended
          </span>
        ) : null}
      </div>
      <span className="text-sm text-text-muted">{caseEntry.communicativeFunction}</span>
      <span className="text-xs text-text-muted">
        {lightLabel(caseEntry.light)} · {caseEntry.mastery.masteredChunks}/
        {caseEntry.mastery.totalChunks} owned
      </span>
    </>
  );

  if (onStartRegion === undefined) {
    return (
      <article aria-label={label} className={className}>
        {body}
      </article>
    );
  }

  return (
    <button
      aria-label={label}
      className={className}
      onClick={() => onStartRegion(caseEntry.caseId)}
      type="button"
    >
      {body}
    </button>
  );
}
