import type { FrameIoAuth, MatchingResult, ProcessRequest, ProcessResponse } from "../models.js";
import { detectSource, isPublicFrameIoShareUrl } from "../lib/source.js";
import { extractReferenceLinks, matchTranscriptToRecords } from "./ai-matching.js";
import type { ActivityLogger } from "./activity-log.js";
import { discoverPublicFrameIoShare } from "./frameio-public-share.js";
import { discoverFrameIoArchive } from "./frameio-source.js";
import { persistIndex } from "./index-store.js";
import { discoverLocalArchive } from "./local-source.js";
import { matchReferencesToRecords } from "./reference-matching.js";
import { matchRawFilesByTranscript } from "./raw-transcript-matcher.js";
import { prepareReferenceMedia } from "./reference-media.js";
import { parseRankingTerms } from "./ranking.js";

export async function processArchive(
  request: ProcessRequest,
  rankingFileContent?: string,
  frameIoAuth?: FrameIoAuth,
  onActivity?: ActivityLogger,
): Promise<ProcessResponse> {
  const source = detectSource(request);
  onActivity?.({
    stage: "source",
    message: `Source detected: ${source.kind}`,
    detail: {
      input: source.input,
      forceRefresh: request.forceRefresh === true,
    },
  });

  onActivity?.({
    stage: "discovery",
    message: `Starting ${source.kind === "local" ? "local archive" : "Frame.io"} discovery`,
  });
  const discovery =
    source.kind === "local"
      ? await discoverLocalArchive(source, { onActivity })
      : isPublicFrameIoShareUrl(source.input)
        ? await discoverPublicFrameIoShare(source, {
            forceRefresh: request.forceRefresh === true,
            onActivity,
          })
      : await discoverFrameIoArchive(source, {
          forceRefresh: request.forceRefresh === true,
          bearerToken: frameIoAuth?.bearerToken?.trim(),
          sessionCookie: frameIoAuth?.sessionCookie?.trim(),
          onActivity,
        });

  onActivity?.({
    stage: "discovery",
    level: "success",
    message: `Discovery completed with ${discovery.fileCount} files across ${discovery.folderCount} folders`,
    detail: {
      cachePath: discovery.cachePath,
      resumed: discovery.resumed,
      warnings: discovery.warnings.length,
    },
  });

  const rankingTerms = rankingFileContent ? parseRankingTerms(rankingFileContent) : [];
  if (rankingTerms.length > 0) {
    onActivity?.({
      stage: "ranking",
      message: `Loaded ${rankingTerms.length} ranking terms`,
    });
  }

  const transcript = request.transcriptText?.trim();
  const referenceText = [transcript ?? "", rankingFileContent ?? ""].filter(Boolean).join("\n");
  const extractedReferenceLinks = transcript ? extractReferenceLinks(referenceText) : [];
  let referencesSummary: ProcessResponse["references"] | undefined;
  const matching =
    transcript && transcript.length > 0
      ? await (async () => {
          onActivity?.({
            stage: "matching",
            message: "Starting AI transcript matching",
            detail: {
              provider: request.aiProvider ?? "auto",
              model: request.aiModel?.trim() || undefined,
              candidateLimit: request.maxCandidates,
              matchLimit: request.maxMatches,
            },
          });

          if (extractedReferenceLinks.length > 0) {
            onActivity?.({
              stage: "reference.prepare",
              message: `Detected ${extractedReferenceLinks.length} reference links; starting transcript-first reference processing`,
            });
            const preparedReferences = await prepareReferenceMedia({
              requestId: request.requestId ?? source.cacheKey,
              text: referenceText,
              forceRefresh: request.forceRefresh === true,
              onActivity,
            });

            referencesSummary = {
              totalCount: preparedReferences.summary.total,
              matchedCount: 0,
              unresolvedCount: preparedReferences.summary.total,
              failedCount: preparedReferences.summary.failed,
              cachePath: `${source.cacheKey}`,
            };

            let referenceMatching: MatchingResult;

            if (source.kind === "local") {
              // Transcript overlap matching — no AI needed
              referenceMatching = await matchRawFilesByTranscript({
                requestId: request.requestId ?? source.cacheKey,
                references: preparedReferences,
                records: discovery.records,
                localPath: source.input,
                forceRefresh: request.forceRefresh === true,
                onActivity,
              });

              // Fall back to AI if nothing matched
              if (referenceMatching.matches.length === 0) {
                try {
                  const aiMatching = await matchReferencesToRecords({
                    references: preparedReferences,
                    records: discovery.records,
                    rankingTerms,
                    providerPreference: request.aiProvider,
                    modelPreference: request.aiModel,
                    maxCandidates: request.maxCandidates,
                    maxMatches: request.maxMatches,
                    onActivity,
                  });
                  referenceMatching = {
                    ...aiMatching,
                    notes: ["Transcript overlap found no matches; AI fallback used.", ...aiMatching.notes],
                  };
                } catch (fallbackError) {
                  onActivity?.({
                    stage: "reference.transcriptMatch",
                    level: "warning",
                    message: "AI fallback failed; keeping transcript overlap result",
                    detail: { error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) },
                  });
                }
              }
            } else {
              // Frame.io: unchanged AI matching
              referenceMatching = await matchReferencesToRecords({
                references: preparedReferences,
                records: discovery.records,
                rankingTerms,
                providerPreference: request.aiProvider,
                modelPreference: request.aiModel,
                maxCandidates: request.maxCandidates,
                maxMatches: request.maxMatches,
                onActivity,
              });
            }

            referencesSummary = {
              totalCount: preparedReferences.summary.total,
              matchedCount: referenceMatching.matches.length,
              unresolvedCount: Math.max(0, preparedReferences.summary.total - referenceMatching.matches.length - preparedReferences.summary.failed),
              failedCount: preparedReferences.summary.failed,
              cachePath: `${source.cacheKey}`,
            };
            return referenceMatching;
          }

          return matchTranscriptToRecords({
            transcript,
            records: discovery.records,
            rankingTerms,
            referenceText,
            onActivity,
            providerPreference: request.aiProvider,
            modelPreference: request.aiModel,
            maxCandidates: request.maxCandidates,
            maxMatches: request.maxMatches,
          });
        })()
      : undefined;
  if (transcript && transcript.length > 0) {
    onActivity?.({
      stage: "matching",
      level: matching?.status === "used" ? "success" : matching?.status === "fallback" ? "warning" : "info",
      message: matching
        ? `AI matching ${matching.status} with ${matching.matches.length} matches`
        : "AI matching skipped",
      detail: matching
        ? {
            provider: matching.provider,
            model: matching.model,
            durationMs: matching.durationMs,
          }
        : undefined,
    });
  } else {
    onActivity?.({
      stage: "matching",
      level: "warning",
      message: "Transcript missing, AI matching skipped",
    });
  }

  const index = await persistIndex(
    source,
    discovery,
    rankingTerms,
    {
      fileName: request.transcriptFileName,
      textLength: transcript?.length ?? 0,
    },
    matching,
    referencesSummary,
  );

  onActivity?.({
    stage: "index",
    level: "success",
    message: `Index persisted for job ${index.id}`,
    detail: {
      matchedCount: index.summary.matchedCount,
      indexedAt: index.summary.indexedAt,
    },
  });

  return {
    jobId: index.id,
    source,
    summary: {
      fileCount: discovery.fileCount,
      folderCount: discovery.folderCount,
      indexedAt: index.summary.indexedAt,
      resumed: discovery.resumed,
      warnings: discovery.warnings,
      cachePath: discovery.cachePath,
      matchedCount: index.summary.matchedCount,
    },
    transcript: {
      fileName: request.transcriptFileName,
      textLength: transcript?.length ?? 0,
      hasTranscript: Boolean(transcript),
    },
    rankingTerms,
    matching,
    references: referencesSummary ?? index.references,
  };
}
