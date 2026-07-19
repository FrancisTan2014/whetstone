import { Link } from "react-router-dom";

import { PageFrame } from "../shared/ui/PageFrame.js";

// The catch-all not-found page: any unrecognized path — including retired routes such as /practice and
// /progress — lands here inside the shell rather than on a blank screen. It stays calm and gives one
// clear way back to Today, so a stale bookmark or hand-typed hash never dead-ends the reader.
export function NotFoundPage(): React.JSX.Element {
  return (
    <PageFrame
      description="That page isn’t here. It may have moved, or the link may be out of date."
      title="Page not found"
    >
      <Link className="inline-flex min-h-[44px] items-center text-text underline" to="/">
        Back to Today
      </Link>
    </PageFrame>
  );
}
