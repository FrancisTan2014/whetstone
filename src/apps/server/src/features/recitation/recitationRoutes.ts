import {
  createRecitationPlanRequestSchema,
  setRecitationPhaseRequestSchema
} from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";
import type { FastifyInstance } from "fastify";

import { getLearnerTimeZone } from "../preferences/preferencesQueries.js";
import {
  createRecitationPlan,
  recordRecitationSession,
  setRecitationPhase,
  setRecitationPlanPaused,
  type RecitationDependencies
} from "./recitationCommands.js";
import { loadRecitationHub } from "./recitationHubQueries.js";
import { getContinueRecitation, listRecitationPlans } from "./recitationQueries.js";

const invalidRequest = { error: "invalid_request" } as const;
const notFound = { error: "not_found" } as const;
const workNotFound = { error: "work_not_found" } as const;
const alreadyExists = { error: "already_exists" } as const;

type PlanParams = Readonly<{ id: string }>;

export type RecitationRouteDependencies = RecitationDependencies;

export function registerRecitationRoutes(
  server: FastifyInstance,
  dependencies: RecitationRouteDependencies
): void {
  // Adopt a source Work as a recitation routine in the chosen initial phase (#577). Eligible Works are any
  // Work (imported or authored) → 400 `work_not_found` when the id is unknown, 409 `already_exists` when
  // the learner already recites this Work (no duplicate plan), 201 with the plan otherwise.
  server.post("/api/recitation/plans", async (request, reply) => {
    const parsed = createRecitationPlanRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await createRecitationPlan(
      dependencies,
      parsed.data,
      request.server.currentUser.getCurrentUserId()
    );

    if (result.status === "work_not_found") {
      return reply.code(400).send(workNotFound);
    }
    if (result.status === "already_exists") {
      return reply.code(409).send({ ...alreadyExists, plan: result.plan });
    }

    request.log.info(
      { route: "POST /api/recitation/plans", planEntryId: result.plan.entryId },
      "recitation_plan_created"
    );
    return reply.code(201).send(result.plan);
  });

  // The user's recitation plans (newest adopted first) so the Library can mark which Works are already
  // being recited and never offer a duplicate adoption.
  server.get("/api/recitation/plans", async (request) => {
    const plans = await listRecitationPlans(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { plans };
  });

  // Today's "Continue recitation" target: the most recently touched plan, or null when there is none.
  // Registered before the `:id` route so the static path wins over the parametric one.
  server.get("/api/recitation/continue", async (request) => {
    const plan = await getContinueRecitation(
      dependencies.db,
      request.server.currentUser.getCurrentUserId()
    );
    return { plan };
  });

  // The recitation routine hub (#608): one calm projection of the learner's most-recently-touched plan —
  // what needs attention now, where they are in this Work, and the next due-first action — derived purely
  // from canonical rows joined to shared card state. Static path, so registered before the `:id` routes.
  server.get("/api/recitation/hub", async (request) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const timeZone = await getLearnerTimeZone(dependencies.db, userId);
    const hub = await loadRecitationHub(dependencies, userId, dependencies.now(), timeZone);
    return { hub };
  });

  // Pause a plan (#608): remove its cards from all due/Today selection without deleting progress,
  // schedule, support levels, chains, or history. Owner-scoped (404 otherwise); idempotent. Returns the
  // refreshed hub so the client updates in one round-trip.
  server.post<{ Params: PlanParams }>("/api/recitation/plans/:id/pause", async (request, reply) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const result = await setRecitationPlanPaused(
      dependencies,
      toEntryId(request.params.id),
      true,
      userId
    );
    if (result === "not_found") {
      return reply.code(404).send(notFound);
    }
    const timeZone = await getLearnerTimeZone(dependencies.db, userId);
    const hub = await loadRecitationHub(dependencies, userId, dependencies.now(), timeZone);
    return reply.code(200).send({ hub });
  });

  // Resume a paused plan (#608): clear its pause so its preserved cards re-enter selection. Owner-scoped
  // (404 otherwise); idempotent. Returns the refreshed hub.
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/resume",
    async (request, reply) => {
      const userId = request.server.currentUser.getCurrentUserId();
      const result = await setRecitationPlanPaused(
        dependencies,
        toEntryId(request.params.id),
        false,
        userId
      );
      if (result === "not_found") {
        return reply.code(404).send(notFound);
      }
      const timeZone = await getLearnerTimeZone(dependencies.db, userId);
      const hub = await loadRecitationHub(dependencies, userId, dependencies.now(), timeZone);
      return reply.code(200).send({ hub });
    }
  );

  // The explicit learner-driven phase transition (e.g. "Start reciting"). Owner-scoped (404 otherwise); a
  // malformed phase is rejected at the boundary (400).
  server.put<{ Params: PlanParams }>("/api/recitation/plans/:id/phase", async (request, reply) => {
    const parsed = setRecitationPhaseRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(invalidRequest);
    }

    const result = await setRecitationPhase(
      dependencies,
      toEntryId(request.params.id),
      parsed.data.phase,
      request.server.currentUser.getCurrentUserId()
    );
    if (result.status === "not_found") {
      return reply.code(404).send(notFound);
    }

    request.log.info(
      { phase: result.plan.phase, planEntryId: result.plan.entryId, route: "PUT phase" },
      "recitation_phase_set"
    );
    return reply.code(200).send(result.plan);
  });

  // Record one reading session (lightweight routine state — not an Entry, never feeds FSRS). Owner-scoped
  // (404 otherwise). The reader's resume position is saved separately via the reading-position API.
  server.post<{ Params: PlanParams }>(
    "/api/recitation/plans/:id/session",
    async (request, reply) => {
      const result = await recordRecitationSession(
        dependencies,
        toEntryId(request.params.id),
        request.server.currentUser.getCurrentUserId()
      );
      if (result.status === "not_found") {
        return reply.code(404).send(notFound);
      }

      return reply.code(200).send(result.plan);
    }
  );
}
