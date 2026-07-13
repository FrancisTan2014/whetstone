import { Link } from "react-router-dom";

// The catch-all not-found page: any unrecognized path — including retired routes such as /practice and
// /progress — lands here inside the shell rather than on a blank screen. It stays calm and gives one
// clear way back to Today, so a stale bookmark or hand-typed hash never dead-ends the reader.
export function NotFoundPage(): React.JSX.Element {
  return (
    <section aria-labelledby="not-found-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="not-found-heading">
        Page not found
      </h1>
      <p className="mt-2 text-text-muted">
        That page isn’t here. It may have moved, or the link may be out of date.
      </p>
      <Link className="mt-4 inline-block text-text underline" to="/">
        Back to Today
      </Link>
    </section>
  );
}
