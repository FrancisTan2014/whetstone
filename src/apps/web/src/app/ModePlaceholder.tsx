type ModePlaceholderProps = Readonly<{
  description: string;
  mode: string;
}>;

// A labelled empty region for a navigation mode whose screen has not shipped yet
// (Notes, Search). Keeps the route resolvable and the destination reachable from the
// shell with an explicit, accessible empty state.
export function ModePlaceholder({ description, mode }: ModePlaceholderProps): React.JSX.Element {
  const headingId = `${mode.toLowerCase()}-mode-heading`;

  return (
    <section aria-labelledby={headingId} className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id={headingId}>
        {mode}
      </h1>
      <p className="mt-2 text-text-muted">{description}</p>
    </section>
  );
}
