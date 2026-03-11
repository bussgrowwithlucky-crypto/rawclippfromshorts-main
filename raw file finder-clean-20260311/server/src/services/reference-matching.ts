import { config } from "../config.js";
import type { MatchingResult, MediaRecord, RankingTerm, TranscriptMatch } from "../models.js";
import type { ActivityLogger } from "./activity-log.js";
import { matchTranscriptToRecords } from "./ai-matching.js";
import type { ReferenceMediaPipelineResult } from "./reference-media.js";

function compactText(text: string, maxLength = 180): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength)}...`;
}

function buildReferenceTranscript(reference: ReferenceMediaPipelineResult["references"][number]): string {
  return [
    reference.title,
    reference.context,
    reference.transcriptText,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildReferenceSourceText(reference: ReferenceMediaPipelineResult["references"][number]): string {
  return [
    reference.title,
    reference.referenceUrl,
    reference.context,
    reference.transcriptText,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function matchReferencesToRecords(params: {
  references: ReferenceMediaPipelineResult;
  records: MediaRecord[];
  rankingTerms: RankingTerm[];
  providerPreference?: "auto" | "ollama" | "gemini-cli" | "nvidia" | "openrouter";
  modelPreference?: string;
  maxCandidates?: number;
  maxMatches?: number;
  onActivity?: ActivityLogger;
}): Promise<MatchingResult> {
  const startedAt = Date.now();
  const resolvedNotes: string[] = [];
  const aggregatedMatches: TranscriptMatch[] = [];
  let provider: MatchingResult["provider"] =
    params.providerPreference === "ollama"
      ? "ollama"
      : params.providerPreference === "nvidia"
        ? "nvidia"
        : params.providerPreference === "openrouter"
          ? "openrouter"
          : "gemini-cli";
  let model = params.modelPreference?.trim() || "";
  let successfulReferenceMatches = 0;

  for (const reference of params.references.references) {
    params.onActivity?.({
      stage: "reference.match",
      message: `Matching reference: ${reference.title}`,
      detail: {
        referenceUrl: reference.referenceUrl,
        transcriptStatus: reference.transcriptStatus,
      },
    });

    if (reference.transcriptStatus === "failed" || !reference.transcriptText.trim()) {
      resolvedNotes.push(`Unresolved reference: ${reference.title} (${reference.failureMessage ?? "No transcript available."})`);
      params.onActivity?.({
        stage: "reference.match",
        level: "warning",
        message: `Skipped reference without transcript: ${reference.title}`,
      });
      continue;
    }

    const matching = await matchTranscriptToRecords({
      transcript: buildReferenceTranscript(reference),
      records: params.records,
      rankingTerms: params.rankingTerms,
      referenceText: buildReferenceSourceText(reference),
      providerPreference: params.providerPreference,
      modelPreference: params.modelPreference,
      maxCandidates: params.maxCandidates,
      maxMatches: 1,
      onActivity: params.onActivity,
    });

    provider = matching.provider;
    model = matching.model;

    const bestMatch = matching.matches[0];
    if (matching.status !== "used" || !bestMatch || bestMatch.confidence < config.reference.matchMinConfidence) {
      resolvedNotes.push(
        `Unresolved reference: ${reference.title} (${matching.status}${bestMatch ? `, confidence ${bestMatch.confidence.toFixed(2)}` : ""})`,
      );
      params.onActivity?.({
        stage: "reference.match",
        level: "warning",
        message: `Reference left unresolved: ${reference.title}`,
        detail: {
          status: matching.status,
          confidence: bestMatch?.confidence,
          referenceUrl: reference.referenceUrl,
        },
      });
      continue;
    }

    successfulReferenceMatches += 1;
    aggregatedMatches.push({
      ...bestMatch,
      referenceUrl: reference.referenceUrl,
      referenceTitle: reference.title,
      referenceTranscriptPreview: compactText(reference.transcriptText, 240),
      referenceReason: `Matched from downloaded reference transcript for ${reference.title}`,
      referenceMatchStatus: "matched",
      transcriptEvidence: bestMatch.transcriptEvidence || compactText(reference.transcriptText, 220),
    });
    params.onActivity?.({
      stage: "reference.match",
      level: "success",
      message: `Matched ${reference.title} to ${bestMatch.record.relativePath}`,
      detail: {
        confidence: bestMatch.confidence,
        referenceUrl: reference.referenceUrl,
      },
    });
  }

  const matches = aggregatedMatches;
  const unmatchedCount = params.references.summary.total - successfulReferenceMatches;
  const notes = [
    `Reference pipeline processed ${params.references.summary.total} shorts, matched ${successfulReferenceMatches}, unresolved ${Math.max(0, unmatchedCount)}.`,
    ...resolvedNotes,
  ];

  return {
    provider,
    model,
    status: matches.length > 0 ? "used" : "failed",
    durationMs: Date.now() - startedAt,
    generatedAt: new Date().toISOString(),
    transcriptPreview: `Reference-driven run across ${params.references.summary.total} short clips`,
    transcriptLength: params.references.references.reduce((sum, reference) => sum + reference.transcriptText.length, 0),
    candidateCount: params.records.length,
    matches,
    notes,
  };
}
