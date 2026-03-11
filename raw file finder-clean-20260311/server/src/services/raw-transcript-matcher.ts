import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { MatchingResult, MediaRecord, TranscriptMatch } from "../models.js";
import type { ActivityLogger } from "./activity-log.js";
import type { ReferenceMediaPipelineResult } from "./reference-media.js";
import { ensureReferencePythonEnvironment } from "./reference-media.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "..");
const rawMatcherScriptPath = path.join(repoRoot, "scripts", "raw_transcript_matcher.py");
const rawTranscriptCacheDir = path.join(config.dataDir, "cache", "raw-transcripts");

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

function compactPreview(text: string, maxLength = 240): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength)}...`;
}

interface RawMatcherOutput {
  summary: {
    rawFilesFound: number;
    rawFilesTranscribed: number;
    rawFilesCached: number;
    rawFilesFailed: number;
  };
  referenceMatches: Array<{
    referenceId: string;
    referenceUrl: string;
    referenceTitle: string;
    matches: Array<{
      rawFilePath: string;
      confidence: number;
      matchedTokens: string[];
      evidenceSnippet: string;
    }>;
    skipped?: boolean;
    skipReason?: string;
  }>;
}

export async function matchRawFilesByTranscript(params: {
  requestId: string;
  references: ReferenceMediaPipelineResult;
  records: MediaRecord[];
  localPath: string;
  forceRefresh?: boolean;
  onActivity?: ActivityLogger;
}): Promise<MatchingResult> {
  const startedAt = Date.now();

  await fs.mkdir(rawTranscriptCacheDir, { recursive: true });
  const pythonExe = await ensureReferencePythonEnvironment(params.onActivity);
  const inputPath = path.join(rawTranscriptCacheDir, `${params.requestId}-raw-matcher.json`);

  const payload = {
    references: params.references.references.map((r) => ({
      id: r.id,
      referenceUrl: r.referenceUrl,
      title: r.title,
      transcriptText: r.transcriptText,
      transcriptStatus: r.transcriptStatus,
    })),
    rawFolderPath: params.localPath,
    rawTranscriptCacheDir,
    model: config.reference.whisperModel,
    forceRefresh: params.forceRefresh === true,
    matchThreshold: 0.35,
    maxMatchesPerReference: 3,
  };

  await fs.writeFile(inputPath, JSON.stringify(payload), "utf8");

  params.onActivity?.({
    stage: "reference.transcriptMatch",
    message: `Starting raw file transcript matching for ${params.references.references.length} references`,
    detail: { localPath: params.localPath, whisperModel: config.reference.whisperModel },
  });

  let output: RawMatcherOutput;
  try {
    const { stdout, stderr } = await execFileAsync(
      pythonExe,
      [rawMatcherScriptPath, "--input-json", inputPath],
      {
        timeout: config.reference.pipelineTimeoutMs,
        maxBuffer: 25 * 1024 * 1024,
      },
    );

    if (!stdout.trim()) {
      throw new Error(stderr.trim() || "Raw transcript matcher returned no output.");
    }

    output = JSON.parse(stdout) as RawMatcherOutput;
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };
    const message = [
      error instanceof Error ? error.message : String(error),
      details.stderr?.trim(),
      details.stdout?.trim(),
    ]
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Raw transcript matcher failed: ${message}`);
  } finally {
    await fs.rm(inputPath, { force: true });
  }

  params.onActivity?.({
    stage: "reference.transcriptMatch",
    level: output.summary.rawFilesFailed > 0 ? "warning" : "success",
    message: `Raw transcript scan: ${output.summary.rawFilesFound} files found, ${output.summary.rawFilesTranscribed} transcribed, ${output.summary.rawFilesCached} cached`,
    detail: output.summary,
  });

  // Build lookups for matching output paths back to MediaRecords and reference items
  const recordByPath = new Map<string, MediaRecord>();
  for (const record of params.records) {
    recordByPath.set(normalizePath(record.sourcePath), record);
  }

  const refById = new Map<string, ReferenceMediaPipelineResult["references"][number]>();
  for (const ref of params.references.references) {
    refById.set(ref.id, ref);
  }

  const matches: TranscriptMatch[] = [];
  const unresolvedNotes: string[] = [];

  for (const refMatch of output.referenceMatches) {
    if (refMatch.skipped) {
      unresolvedNotes.push(`Unresolved: ${refMatch.referenceTitle} (${refMatch.skipReason ?? "skipped"})`);
      continue;
    }

    const refItem = refById.get(refMatch.referenceId);

    for (const m of refMatch.matches) {
      const record = recordByPath.get(normalizePath(m.rawFilePath));
      if (!record) continue;

      matches.push({
        recordId: record.id,
        confidence: m.confidence,
        rationale: `Transcript overlap match: ${m.matchedTokens.length} shared content words between short and raw file`,
        transcriptEvidence: m.evidenceSnippet,
        matchedTerms: m.matchedTokens,
        referenceUrl: refMatch.referenceUrl,
        referenceTitle: refMatch.referenceTitle,
        referenceTranscriptPreview: refItem?.transcriptText
          ? compactPreview(refItem.transcriptText)
          : "",
        referenceReason: "Matched via Whisper transcript overlap",
        referenceMatchStatus: "matched",
        record,
        directLink: `file:///${m.rawFilePath}`,
      } satisfies TranscriptMatch);
    }

    if (refMatch.matches.length === 0) {
      unresolvedNotes.push(
        `Unresolved: ${refMatch.referenceTitle} (no raw file matched above threshold)`,
      );
    }
  }

  const resolvedCount = output.referenceMatches.filter((r) => !r.skipped && r.matches.length > 0).length;
  const summaryLine = `Raw transcript scan: ${output.summary.rawFilesFound} files, ${matches.length} matches across ${resolvedCount} references.`;

  return {
    provider: "ollama",
    model: "whisper-transcript-overlap",
    status: matches.length > 0 ? "used" : "failed",
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    transcriptPreview: `Transcript overlap matching across ${params.references.references.length} shorts`,
    transcriptLength: params.references.references.reduce((sum, r) => sum + r.transcriptText.length, 0),
    candidateCount: params.records.length,
    matches,
    notes: [summaryLine, ...unresolvedNotes],
  };
}
