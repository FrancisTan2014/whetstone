import { todayBoardResponseSchema } from "@whetstone/contracts";
import type { FastifyInstance } from "fastify";

import { getLearnerTimeZone } from "../preferences/preferencesQueries.js";
import { loadTodayBoard, type TodayDependencies } from "./todayQueries.js";

export type TodayRouteDependencies = TodayDependencies & Readonly<{ now: () => Date }>;

export function registerTodayRoutes(
  server: FastifyInstance,
  dependencies: TodayRouteDependencies
): void {
  // The Today board (#610): one server-composed read model of the learner's deterministic obligations and
  // optional invitations for their local day (#606). No new task/completion rows are written — it is a
  // pure compose over feature-owned canonical state. The response envelope is validated at the boundary,
  // so a drifted board shape fails loudly here rather than reaching the client.
  server.get("/api/today", async (request) => {
    const userId = request.server.currentUser.getCurrentUserId();
    const timeZone = await getLearnerTimeZone(dependencies.db, userId);
    const board = await loadTodayBoard(dependencies, userId, dependencies.now(), timeZone);
    return todayBoardResponseSchema.parse({ board });
  });
}
