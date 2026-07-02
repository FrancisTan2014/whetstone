// A kill-capable wall-clock bound shared by the PDF ingestion seams (#403). Both the Docling
// conversion and the OCRmyPDF pre-pass spawn a subprocess; without a bound a slow or hung process
// hangs the ingest request indefinitely. Reject if `work` does not settle within `timeoutMs` so the
// caller can map it to a 422 instead of hanging. `label` names the stage in the error message. The
// timer is always cleared, so a settled operation leaves no dangling handle.
export function withTimeout<T>(work: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
