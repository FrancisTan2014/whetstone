import {
  enrollRecitationRequestSchema,
  recitationReviewResponseSchema,
  recordRecitationReviewRequestSchema,
  recordRecitationReviewResponseSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import {
  enrollRecitation,
  pauseRecitation,
  recordRecitationReview,
  removeRecitation,
  resumeRecitation,
  type RecitationDependencies
} from "./recitationCommands.js";
import {
  listRecitationPlans,
  loadOwnedRecitationPlan,
  toRecitationPlanDto
} from "./recitationQueries.js";
import { loadRecitationReview } from "./recitationReviewQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
const workNotFound = { error: "work_not_found" } as const;

type PlanParams = Readonly<{ id: string }>;

export type RecitationRouteDependencies = RecitationDependencies;

export function registerRecitationRoutes(
  server: FastifyInstance,
  dependencies: RecitationRouteDependencies
): void {
  // "I can recite this" (#643): enroll a known Work straight into Recitation maintenance. Eligible Works
  // are any Work (imported or authored) → 400 `work_not_found` when the id is unknown. Idempotent: a Work
  // already enrolled reuses its plan, target, and card. Persists BEFORE any review opens; returns the plan.
  server.post("/api/recitation/enroll", async (request, reply) => {
    const parsed = enrollRecitationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await enrollRecitation(
      dependencies,
      parsed.data.workEntryId,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "work_not_found") {
      return reply.code(400).send(workNotFound);
    }

    request.log.info(
      { planEntryId: result.plan.entryId, route: "POST /api/recitation/enroll" },
      "recitation_enrolled"
    );
    return reply.code(200).send(result.plan);
  });

  // The user's recitation plans so the Library can mark which Works are already enrolled in maintenance.
  server.get("/api/recitation/plans", async (request) => {
    const plans = await listRecitationPlans(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { plans };
  });

  // The Work-level maintenance review to present (#643). With `?work=<id>` the caller opens THAT exact
  // Work's review (the review just after enrolling); with no query the earliest-due Work is chosen by the
  // #633 aggregate. `review` is null when nothing is due / the Work is not enrolled, so the client routes
  // to a Library recovery path instead of a dead screen. Static path, registered before the `:id` routes.
  server.get<{ Querystring: { work?: string } }>("/api/recitation/review", async (request) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const workEntryId =
      typeof request.query.work === "string" && request.query.work.length > 0
        ? request.query.work
        : undefined;
    const review = await loadRecitationReview(
      { db: dependencies.db },
      userId,
      dependencies.now(),
      workEntryId
    );
    return recitationReviewResponseSchema.parse({ review });
  });

  // Record one Work-level maintenance review (#643): rate the plan's single Work-level card, appending one
  // review event and rescheduling only that card. Owner-scoped (404 otherwise); a malformed rating is
  // rejected at the boundary (400). Returns the rescheduled review.
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/review",
    async (request, reply) => {
      const parsed = recordRecitationReviewRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(invalidRequest);
      }

      const result = await recordRecitationReview(
        dependencies,
        toEntryId(request.params.id),
        parsed.data.rating,
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      request.log.info(
        { planEntryId: request.params.id, rating: parsed.data.rating, route: "POST review" },
        "recitation_reviewed"
      );
      return reply.code(200).send(
        recordRecitationReviewResponseSchema.parse({
          remainingDueCount: result.remainingDueCount,
          review: result.review
        })
      );
    }
  );

  // Pause maintenance for a plan (#608/#643): withhold its Work-level card from the due scan without
  // deleting progress or history. Owner-scoped (404 otherwise); idempotent. Returns the refreshed plan.
  server.post<{ Params: PlanParams }>("/api/recitation/plans/:id/pause", async (request, reply) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const planEntryId = toEntryId(request.params.id);
    const result = await pauseRecitation(dependencies, planEntryId, userId);
    if (result === "not_found") {
      return reply.code(404).send(notFound);
    }
    const owned = (await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId))!;
    return reply.code(200).send(toRecitationPlanDto(owned));
  });

  // Resume a paused plan (#608/#643): return its preserved card to the due scan. Owner-scoped (404
  // otherwise); idempotent. Returns the refreshed plan.
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/resume",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      const planEntryId = toEntryId(request.params.id);
      const result = await resumeRecitation(dependencies, planEntryId, userId);
      if (result === "not_found") {
        return reply.code(404).send(notFound);
      }
      const owned = (await loadOwnedRecitationPlan(dependencies.db, planEntryId, userId))!;
      return reply.code(200).send(toRecitationPlanDto(owned));
    }
  );

  // Remove maintenance for a plan (#643): drop its Work-level card, preserving the Work, its source
  // content, and the append-only review history. Owner-scoped (404 otherwise); idempotent.
  server.delete<{ Params: PlanParams }>("/api/recitation/plans/:id", async (request, reply) => {
    const result = await removeRecitation(
      dependencies,
      toEntryId(request.params.id),
      request.server.currentUser.getCurrentUserId()
    );
    if (result === "not_found") {
      return reply.code(404).send(notFound);
    }
    return reply.code(200).send({ removed: true });
  });
}
