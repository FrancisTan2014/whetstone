import { createHealthResponse, healthEndpointPath } from "@whetstone/contracts";
import { formatProductHeading, productIdentity } from "@whetstone/domain";

const healthResponse = createHealthResponse();

export function App(): React.JSX.Element {
  return (
    <main className="appShell">
      <section className="placeholderCard" aria-labelledby="app-title">
        <p className="eyebrow">Foundation scaffold</p>
        <h1 id="app-title">{formatProductHeading(productIdentity)}</h1>
        <p>
          Placeholder web app only. Future issues will add admin input, reader display, and linked
          note capture.
        </p>
        <p>
          Server health endpoint: <code>{healthEndpointPath}</code> returns{" "}
          <code>{healthResponse.status}</code>.
        </p>
      </section>
    </main>
  );
}
