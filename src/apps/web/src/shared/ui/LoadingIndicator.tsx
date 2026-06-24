import { Spinner } from "./Spinner.js";

export type LoadingIndicatorProps = Readonly<{
  label?: string;
}>;

// The shared page/section loading treatment: a spinner plus a label, announced politely
// (`role="status"`) and marked `aria-busy`. Replaces the app's scattered plain-text
// loaders so every load looks and reads the same.
export function LoadingIndicator({ label = "Loading…" }: LoadingIndicatorProps): React.JSX.Element {
  return (
    <p aria-busy="true" className="flex items-center gap-2 text-text-muted" role="status">
      <Spinner />
      <span>{label}</span>
    </p>
  );
}
