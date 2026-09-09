import { Component, lazy, Suspense } from "react";

import { Spinner } from "../../shared/ui/Spinner";
import type { ExplainEligibility } from "../reader/explainTarget";
import { SelectionPanel, type SelectionPanelProps } from "./SelectionPanel";

// Remains its own budgeted chunk, loaded only after the disclosed toolbar action.
const ExplainSection = lazy(() =>
  import("./explain/ExplainSection").then((module) => ({ default: module.ExplainSection }))
);

class ExplainErrorBoundary extends Component<
  Readonly<{ children: React.ReactNode; fallback: React.ReactNode }>,
  Readonly<{ hasError: boolean }>
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): Readonly<{ hasError: boolean }> {
    return { hasError: true };
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

function ExplainContent({
  eligibility,
  renderSurface
}: {
  eligibility: ExplainEligibility;
  renderSurface: (content: React.JSX.Element) => React.JSX.Element;
}): React.JSX.Element {
  switch (eligibility.status) {
    case "none":
      return renderSurface(<></>);
    case "cross_block":
      return renderSurface(
        <p className="explainIneligible" role="note">
          Explain with AI isn't available for a selection spanning multiple paragraphs. Select a
          shorter phrase within one paragraph to use it.
        </p>
      );
    case "eligible":
      return (
        <ExplainErrorBoundary
          fallback={renderSurface(
            <p role="alert">
              Explain with AI couldn't load. Close and reload the page to try again. Look up is
              still available.
            </p>
          )}
        >
          <Suspense
            fallback={renderSurface(
              <p className="flex items-center gap-2" role="status">
                <Spinner /> Explaining...
              </p>
            )}
          >
            <ExplainSection renderSurface={renderSurface} target={eligibility.target} />
          </Suspense>
        </ExplainErrorBoundary>
      );
  }
}

export function ExplainPanel({
  eligibility,
  term,
  ...panel
}: Omit<SelectionPanelProps, "children" | "title"> &
  Readonly<{ eligibility: ExplainEligibility; term: string }>): React.JSX.Element {
  const renderSurface = (content: React.JSX.Element): React.JSX.Element => (
    <SelectionPanel {...panel} title={`Explain with AI: ${term}`}>
      {content}
    </SelectionPanel>
  );
  return <ExplainContent eligibility={eligibility} renderSurface={renderSurface} />;
}
