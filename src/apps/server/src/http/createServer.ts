import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type RawServerDefault
} from "fastify";

import {
  audioContentType,
  createHealthResponse,
  epubContentType,
  healthEndpointPath,
  healthResponseJsonSchema,
  pdfContentType,
  type HealthResponse
} from "@whetstone/contracts";

import { registerLibraryRoutes } from "../features/library/libraryRoutes.js";
import type { LibraryRouteDependencies } from "../features/library/libraryRoutes.js";
import { registerContentRoutes } from "../features/content/contentRoutes.js";
import type { ContentDependencies } from "../features/content/contentCommands.js";
import { registerWorkCreationRoutes } from "../features/workCreation/workCreationRoutes.js";
import type { WorkCreationDependencies } from "../features/workCreation/workCreationCommands.js";
import { registerNoteRoutes } from "../features/notes/noteRoutes.js";
import type { NotesDependencies } from "../features/notes/noteCommands.js";
import { registerReadingPositionRoutes } from "../features/readingPosition/readingPositionRoutes.js";
import type { ReadingPositionDependencies } from "../features/readingPosition/readingPositionCommands.js";
import { registerPreferencesRoutes } from "../features/preferences/preferencesRoutes.js";
import type { PreferencesDependencies } from "../features/preferences/preferencesCommands.js";
import { registerLookupRoutes } from "../features/lookup/lookupRoutes.js";
import type { LookupDependencies } from "../features/lookup/lookupRoutes.js";
import { registerSearchRoutes } from "../features/search/searchRoutes.js";
import type { SearchDependencies } from "../features/search/searchRoutes.js";
import { registerImageRoutes } from "../features/images/imageRoutes.js";
import type { ImageDependencies } from "../features/images/imageRoutes.js";
import { registerPdfImportRoutes } from "../features/pdfImport/pdfImportRoutes.js";
import type { PdfImportRouteDependencies } from "../features/pdfImport/pdfImportRoutes.js";
import { registerDiaryRoutes } from "../features/diary/diaryRoutes.js";
import type { DiaryRouteDependencies } from "../features/diary/diaryRoutes.js";
import { registerAuthoredWorkRoutes } from "../features/authoredWorks/authoredWorkRoutes.js";
import type { AuthoredWorkRouteDependencies } from "../features/authoredWorks/authoredWorkRoutes.js";
import { registerRecitationRoutes } from "../features/recitation/recitationRoutes.js";
import type { RecitationRouteDependencies } from "../features/recitation/recitationRoutes.js";
import { registerNotesReviewRoutes } from "../features/notesReview/notesReviewRoutes.js";
import type { NotesReviewRouteDependencies } from "../features/notesReview/notesReviewRoutes.js";
import { registerRelatedMaterialRoutes } from "../features/relatedMaterial/relatedMaterialRoutes.js";
import type { RelatedMaterialRouteDependencies } from "../features/relatedMaterial/relatedMaterialRoutes.js";
import { registerTodayRoutes } from "../features/today/todayRoutes.js";
import type { TodayRouteDependencies } from "../features/today/todayRoutes.js";
import { registerWebStatic } from "./staticWeb.js";
import {
  createDefaultCurrentUserProvider,
  type CurrentUserProvider
} from "../identity/currentUser.js";

// The current-user provider is exposed to every handler as a server decoration, so a request
// reads the current user id via `request.server.currentUser` (never a literal).
declare module "fastify" {
  interface FastifyInstance {
    currentUser: CurrentUserProvider;
  }
}

export type CreateServerOptions = Readonly<{
  authoredWorks?: AuthoredWorkRouteDependencies;
  content?: ContentDependencies;
  // The identity seam: the source of the current user id for user-owned reads/writes. Defaults to
  // the v0 DEFAULT_USER_ID provider; tests (and future auth) inject their own.
  currentUser?: CurrentUserProvider;
  diary?: DiaryRouteDependencies;
  images?: ImageDependencies;
  library?: LibraryRouteDependencies;
  logger: NonNullable<FastifyServerOptions["logger"]>;
  lookup?: LookupDependencies;
  notes?: NotesDependencies;
  notesReview?: NotesReviewRouteDependencies;
  pdfImport?: PdfImportRouteDependencies;
  preferences?: PreferencesDependencies;
  readingPosition?: ReadingPositionDependencies;
  recitation?: RecitationRouteDependencies;
  // The offline "Find related material" inspection aid for New-card creation (#716). When set, the composer's
  // disclosure can list a single-word Answer's senses and the owner's typed related saved Notes; read-only.
  relatedMaterial?: RelatedMaterialRouteDependencies;
  search?: SearchDependencies;
  today?: TodayRouteDependencies;
  // The server-owned Markdown creation-review boundary (#747). When set, imported-Markdown Work creation
  // routes through a durable review attempt instead of the old one-step content route.
  workCreation?: WorkCreationDependencies;
  // When set, the built web client in `web.dir` is served from this same origin (single-origin
  // deploy, #184). Left unset in dev/tests, where Vite serves the client separately.
  web?: { dir: string } | undefined;
}>;

export function createServer(options: CreateServerOptions): FastifyInstance {
  const server = Fastify<RawServerDefault>({
    logger: options.logger,
    requestIdHeader: "x-request-id"
  });

  server.decorate("currentUser", options.currentUser ?? createDefaultCurrentUserProvider());

  // Raw audio uploads (recorded clips) arrive as an octet-stream body the voice-capture worker reads
  // as bytes. Registered once here so the async Tap-and-Talk capture can consume it.
  server.addContentTypeParser(audioContentType, { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );

  // Born-digital PDF uploads (#702) stream straight into the import feature's staging/hash boundary, so
  // the whole file is never buffered in memory (GUIDELINES: no route buffers an entire source merely to
  // hash or persist it). This passthrough parser hands the route the raw request stream instead of a
  // Buffer. Registered here (not in a feature) because the content type is shared with the pdf-import
  // front door and it must be streaming.
  server.addContentTypeParser(pdfContentType, (_request, payload, done) => {
    done(null, payload);
  });

  // Uploaded EPUB bytes arrive as a binary body the creation-review front door (#748) hashes and parses.
  // Registered once here (not in a feature) because the endpoint now lives in the work-creation review
  // boundary while other content routes may register independently, so the parser must exist regardless
  // of which route module owns the EPUB endpoint.
  server.addContentTypeParser(epubContentType, { parseAs: "buffer" }, (_request, body, done) =>
    done(null, body)
  );

  server.get(
    healthEndpointPath,
    {
      schema: {
        response: {
          200: healthResponseJsonSchema
        }
      }
    },
    async (): Promise<HealthResponse> => createHealthResponse()
  );

  if (options.library !== undefined) {
    registerLibraryRoutes(server, options.library);
  }

  if (options.content !== undefined) {
    registerContentRoutes(server, options.content);
  }

  if (options.workCreation !== undefined) {
    registerWorkCreationRoutes(server, options.workCreation);
  }

  if (options.pdfImport !== undefined) {
    registerPdfImportRoutes(server, options.pdfImport);
  }

  if (options.notes !== undefined) {
    registerNoteRoutes(server, options.notes);
  }

  if (options.readingPosition !== undefined) {
    registerReadingPositionRoutes(server, options.readingPosition);
  }

  if (options.preferences !== undefined) {
    registerPreferencesRoutes(server, options.preferences);
  }

  if (options.lookup !== undefined) {
    registerLookupRoutes(server, options.lookup);
  }

  if (options.search !== undefined) {
    registerSearchRoutes(server, options.search);
  }

  if (options.diary !== undefined) {
    registerDiaryRoutes(server, options.diary);
  }

  if (options.authoredWorks !== undefined) {
    registerAuthoredWorkRoutes(server, options.authoredWorks);
  }

  if (options.recitation !== undefined) {
    registerRecitationRoutes(server, options.recitation);
  }

  if (options.notesReview !== undefined) {
    registerNotesReviewRoutes(server, options.notesReview);
  }

  if (options.relatedMaterial !== undefined) {
    registerRelatedMaterialRoutes(server, options.relatedMaterial);
  }

  if (options.today !== undefined) {
    registerTodayRoutes(server, options.today);
  }

  if (options.images !== undefined) {
    registerImageRoutes(server, options.images);
  }

  if (options.web !== undefined) {
    registerWebStatic(server, options.web.dir);
  }

  return server;
}
