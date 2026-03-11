import { randomUUID } from "node:crypto";
import { type Request, Router } from "express";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import type { ClientConfigResponse, ProcessRequest } from "../models.js";
import { loadIndex, searchIndex } from "../services/index-store.js";
import { appendActivityLog, clearActivityLog, createActivityLogger, streamActivityLog } from "../services/activity-log.js";
import { getAiRuntimeStatus } from "../services/ai-matching.js";
import { clearAiRuntimeSettings, saveAiRuntimeSettings } from "../services/ai-runtime-settings.js";
import { selectLocalFolder } from "../services/folder-dialog.js";
import { revealLocalPath } from "../services/local-file-actions.js";
import { processArchive } from "../services/process-service.js";

const upload = multer({ storage: multer.memoryStorage() });

const processSchema = z.object({
  localPath: z.string().optional(),
  frameioLink: z.string().optional(),
  forceRefresh: z
    .union([z.literal("true"), z.literal("false"), z.boolean()])
    .optional()
    .transform((value) => value === true || value === "true"),
  transcriptText: z.string().optional(),
  requestId: z.string().min(1).max(120).optional(),
  aiProvider: z.enum(["auto", "ollama", "gemini-cli", "nvidia", "openrouter"]).optional(),
  aiModel: z.string().optional(),
  maxCandidates: z.coerce.number().int().min(10).max(100).optional(),
  maxMatches: z.coerce.number().int().min(1).max(20).optional(),
});

const frameIoSessionSchema = z.object({
  bearerToken: z.string().optional(),
  sessionCookie: z.string().optional(),
});

const aiRuntimeSchema = z.object({
  ollamaBaseUrl: z.string().optional(),
  ollamaModel: z.string().optional(),
  openRouterBaseUrl: z.string().optional(),
  openRouterModel: z.string().optional(),
  openRouterApiKey: z.string().optional(),
});

const revealLocalPathSchema = z.object({
  path: z.string().min(1),
});

const activityStreamSchema = z.object({
  requestId: z.string().min(1).max(120),
});

export const apiRouter = Router();

async function buildClientConfigResponse(request: Request): Promise<ClientConfigResponse> {
  const ai = await getAiRuntimeStatus();
  return {
    frameio: {
      hasEnvBearerToken: Boolean(config.frameio.bearerToken),
      hasEnvSessionCookie: Boolean(config.frameio.sessionCookie),
      hasSessionBearerToken: Boolean(request.session.frameioBearerToken),
      hasSessionSessionCookie: Boolean(request.session.frameioSessionCookie),
    },
    ai,
  };
}

apiRouter.get("/health", (_request, response) => {
  response.json({ ok: true });
});

apiRouter.get("/activity-stream", (request, response, next) => {
  try {
    const payload = activityStreamSchema.parse(request.query);
    const cleanup = streamActivityLog(payload.requestId, response);
    request.on("close", cleanup);
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/config", async (request, response, next) => {
  try {
    const payload = await buildClientConfigResponse(request);
    response.json(payload);
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/frameio/session", (request, response, next) => {
  try {
    const payload = frameIoSessionSchema.parse(request.body);
    request.session.frameioBearerToken = payload.bearerToken?.trim() || undefined;
    request.session.frameioSessionCookie = payload.sessionCookie?.trim() || undefined;
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/ai/runtime", async (request, response, next) => {
  try {
    const payload = aiRuntimeSchema.parse(request.body);
    await saveAiRuntimeSettings(payload);
    response.json({
      ok: true,
      config: await buildClientConfigResponse(request),
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.delete("/ai/runtime", async (request, response, next) => {
  try {
    await clearAiRuntimeSettings();
    response.json({
      ok: true,
      config: await buildClientConfigResponse(request),
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/local-folder/select", async (_request, response, next) => {
  try {
    const selectedPath = await selectLocalFolder();
    response.json({ path: selectedPath });
  } catch (error) {
    next(error);
  }
});

apiRouter.post("/local-file/reveal", async (request, response, next) => {
  try {
    const payload = revealLocalPathSchema.parse(request.body);
    await revealLocalPath(payload.path);
    response.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

apiRouter.post(
  "/process",
  upload.fields([
    { name: "rankingFile", maxCount: 1 },
    { name: "transcriptFile", maxCount: 1 },
  ]),
  async (request, response, next) => {
    let requestId: string | undefined;
    try {
      const payload = processSchema.parse(request.body);
      requestId = payload.requestId?.trim() || randomUUID();
      const files = request.files as Record<string, Express.Multer.File[] | undefined>;
      const transcriptFile = files?.transcriptFile?.[0];
      const rankingFile = files?.rankingFile?.[0];

      clearActivityLog(requestId);
      const activity = createActivityLogger(requestId);
      activity({
        stage: "request",
        message: "Processing request accepted",
        detail: {
          sourceMode: payload.localPath ? "local" : "frameio",
          aiProvider: payload.aiProvider ?? "auto",
        },
      });

      const processRequest: ProcessRequest = {
        ...payload,
        requestId,
        transcriptText:
          transcriptFile?.buffer?.toString("utf8") ||
          payload.transcriptText?.trim() ||
          undefined,
        transcriptFileName: transcriptFile?.originalname,
      };

      const result = await processArchive(processRequest, rankingFile?.buffer?.toString("utf8"), {
        bearerToken: request.session.frameioBearerToken,
        sessionCookie: request.session.frameioSessionCookie,
      }, activity);

      activity({
        stage: "request",
        level: "success",
        message: "Processing request completed",
        detail: {
          jobId: result.jobId,
          matchedCount: result.summary.matchedCount,
        },
      });

      response.json(result);
    } catch (error) {
      if (requestId) {
        appendActivityLog(requestId, {
          stage: "request",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      next(error);
    }
  },
);

apiRouter.get("/jobs/:jobId", async (request, response, next) => {
  try {
    const index = await loadIndex(request.params.jobId);
    if (!index) {
      response.status(404).json({ message: "Job not found." });
      return;
    }

    response.json({
      jobId: index.id,
      source: index.source,
      summary: {
        ...index.summary,
        resumed: false,
        warnings: [],
      },
      transcript: {
        fileName: index.transcript?.fileName,
        textLength: index.transcript?.textLength ?? 0,
        hasTranscript: (index.transcript?.textLength ?? 0) > 0,
      },
      rankingTerms: index.rankingTerms,
      matching: index.matching,
      references: index.references,
    });
  } catch (error) {
    next(error);
  }
});

apiRouter.get("/jobs/:jobId/search", async (request, response, next) => {
  try {
    const query = z.string().parse(request.query.q ?? "");
    const results = await searchIndex(request.params.jobId, query);
    response.json({ results });
  } catch (error) {
    next(error);
  }
});
