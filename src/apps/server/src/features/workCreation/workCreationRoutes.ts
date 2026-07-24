import {
  importMarkdownWorkRequestSchema,
  parseKeepSeparateDecisionRequest,
  parseOpenExistingDecisionRequest
} from "@whetstone/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import {
  beginEpubCreation,
  beginMarkdownCreation,
  cancelWorkCreation,
  getWorkCreationReview,
  keepSeparateWork,
  openExistingWork,
  type BeginEpubResult,
  type BeginResult,
  type DecisionResult,
  type WorkCreationDependencies
} from "./workCreationCommands.js";

const invalidRequestBody = { error: "invalid_request" } as const;
const invalidEpubBody = { error: "invalid_epub" } as const;

type AttemptParams = Readonly<{ attemptId: string }>;

// The HTTP status each begin outcome maps to. `created` is a fresh Work (201); every other outcome
// leaves creation unresolved or reopens an existing Work (200), refuses input (422/400), or reports a
// candidate-query the server could not trust (503).
function beginStatusCode(status: BeginResult["status"]): number {
  switch (status) {
    case "created":
      return 201;
    case "empty_content":
      return 422;
    case "author_not_found":
      return 400;
    case "uncertain":
      return 503;
    /* v8 ignore next 2 -- exact_existing and needs_review both resolve to 200; listed for exhaustiveness. */
    default:
      return 200;
  }
}

// The HTTP status each decision outcome maps to. A new Work is 201; a reopen/refresh is 200; a fenced
// stale/gone attempt is 409; an expired one 410; a not-found 404; an untrusted recheck 503.
function decisionStatusCode(status: DecisionResult["status"]): number {
  switch (status) {
    case "created":
      return 201;
    case "existing_gone":
    case "superseded":
      return 409;
    case "expired":
      return 410;
    case "not_found":
      return 404;
    case "uncertain":
      return 503;
    /* v8 ignore next 2 -- opened, exact_existing, and needs_review all resolve to 200; exhaustiveness. */
    default:
      return 200;
  }
}

// Send an EPUB begin outcome (#748). Created/exact-existing return the bare Work resource (201/200), the
// same shape the one-step front door always returned, so a duplicate re-upload drops the learner into the
// owning Work. A credible candidate parks review (200 + the review envelope the shared panel consumes);
// bytes the parser could not open are 422; an untrusted candidate recheck is 503.
function sendEpubBegin(reply: FastifyReply, result: BeginEpubResult): FastifyReply {
  switch (result.status) {
    case "created":
      return reply.code(201).send(result.result);
    case "exact_existing":
      return reply.code(200).send(result.result);
    case "needs_review":
      return reply.code(200).send({ review: result.review, status: "needs_review" });
    case "invalid_epub":
      return reply.code(422).send(invalidEpubBody);
    /* v8 ignore next 2 -- uncertain is the only remaining case; listed for exhaustiveness. */
    default:
      return reply.code(503).send({ status: "uncertain" });
  }
}

// The server-owned Markdown creation-review boundary routes (#747). The browser holds only an opaque
// attempt id + revision and sends a semantic decision, so it can neither create around review nor decide
// candidate policy. Every owner scope is read from the request's current-user provider, never a literal.
export function registerWorkCreationRoutes(
  server: FastifyInstance,
  dependencies: WorkCreationDependencies
): void {
  // Begin: the imported-EPUB front door now routes through review (#748). Exact bytes reopen the owning
  // Work; bytes the parser cannot open are refused (422); with no credible candidate the Work is created
  // immediately through the atomic EPUB writer; a credible candidate parks a review attempt.
  server.post(
    "/api/works/epub",
    { bodyLimit: dependencies.content.epubUploadLimitBytes },
    async (request, reply) => {
      const body = request.body;

      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(400).send(invalidRequestBody);
      }

      const userId = request.server.currentUser.getCurrentUserId();
      const result = await beginEpubCreation(dependencies, userId, new Uint8Array(body));

      request.log.info(
        { route: "POST /api/works/epub", status: result.status },
        "work_epub_creation_begin"
      );

      return sendEpubBegin(reply, result);
    }
  );

  // Begin: the imported-Markdown front door now routes through review. Exact bytes reopen the owning
  // Work; a credible candidate parks a review attempt; otherwise the Work is created immediately.
  server.post("/api/works/markdown", async (request, reply) => {
    const parsed = importMarkdownWorkRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send(invalidRequestBody);
    }

    const userId = request.server.currentUser.getCurrentUserId();
    const result = await beginMarkdownCreation(dependencies, userId, parsed.data);

    request.log.info(
      { route: "POST /api/works/markdown", status: result.status },
      "work_markdown_creation_begin"
    );

    return reply.code(beginStatusCode(result.status)).send(result);
  });

  // Review: the current review view for an owner's attempt (opaque id).
  server.get<{ Params: AttemptParams }>(
    "/api/work-creation-attempts/:attemptId",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      const result = await getWorkCreationReview(dependencies, userId, request.params.attemptId);

      if (result.status === "ok") {
        return reply.code(200).send(result.review);
      }

      const code = result.status === "expired" ? 410 : result.status === "uncertain" ? 503 : 404;

      return reply.code(code).send({ status: result.status });
    }
  );

  // Open existing: reopen one reviewed candidate Work and consume the attempt (creates nothing).
  server.post<{ Params: AttemptParams }>(
    "/api/work-creation-attempts/:attemptId/open-existing",
    async (request, reply) => {
      const parsed = parseSafely(() => parseOpenExistingDecisionRequest(request.body));

      if (parsed === undefined) {
        return reply.code(400).send(invalidRequestBody);
      }

      const userId = request.server.currentUser.getCurrentUserId();
      const result = await openExistingWork(
        dependencies,
        userId,
        request.params.attemptId,
        parsed.revision,
        parsed.entryId
      );

      request.log.info(
        {
          route: "POST /api/work-creation-attempts/:attemptId/open-existing",
          status: result.status
        },
        "work_creation_open_existing"
      );

      return reply.code(decisionStatusCode(result.status)).send(result);
    }
  );

  // Keep separate: confirm the proposal is a distinct Work and commit it (transferring the staged upload).
  server.post<{ Params: AttemptParams }>(
    "/api/work-creation-attempts/:attemptId/keep-separate",
    async (request, reply) => {
      const parsed = parseSafely(() => parseKeepSeparateDecisionRequest(request.body));

      if (parsed === undefined) {
        return reply.code(400).send(invalidRequestBody);
      }

      const userId = request.server.currentUser.getCurrentUserId();
      const result = await keepSeparateWork(
        dependencies,
        userId,
        request.params.attemptId,
        parsed.revision
      );

      request.log.info(
        {
          route: "POST /api/work-creation-attempts/:attemptId/keep-separate",
          status: result.status
        },
        "work_creation_keep_separate"
      );

      return reply.code(decisionStatusCode(result.status)).send(result);
    }
  );

  // Back: abandon the review, cancelling the attempt and cleaning its staged bytes.
  server.post<{ Params: AttemptParams }>(
    "/api/work-creation-attempts/:attemptId/cancel",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      const result = await cancelWorkCreation(dependencies, userId, request.params.attemptId);

      return reply.code(200).send(result);
    }
  );
}

// Parse a request body with a throwing Zod parser, returning undefined on rejection so the route can
// answer 400 without leaking validation internals.
function parseSafely<T>(parse: () => T): T | undefined {
  try {
    return parse();
  } catch {
    return undefined;
  }
}
