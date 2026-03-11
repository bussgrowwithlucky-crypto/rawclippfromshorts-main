import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type {
  AiProviderKind,
  AiRuntimeSettings,
  ClientConfigResponse,
  MatchingResult,
  MediaRecord,
  RankingTerm,
  TranscriptMatch,
} from "../models.js";
import type { ActivityLogger } from "./activity-log.js";
import { getEffectiveAiRuntimeSettings, getEffectiveOpenRouterApiKey } from "./ai-runtime-settings.js";
import { computeRankingBoost } from "./ranking.js";

const execFileAsync = promisify(execFile);
type ConcreteAiProvider = Exclude<AiProviderKind, "auto">;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "along",
  "also",
  "because",
  "being",
  "between",
  "could",
  "every",
  "first",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "other",
  "over",
  "said",
  "same",
  "some",
  "than",
  "that",
  "them",
  "then",
  "there",
  "they",
  "this",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "would",
  "com",
  "generated",
  "highest",
  "http",
  "https",
  "ranked",
  "shorts",
  "total",
  "url",
  "views",
  "watch",
  "www",
  "youtube",
  "youtu",
]);

interface CandidateRecord {
  record: MediaRecord;
  heuristicScore: number;
  directLink?: string;
  sourceLink?: string;
  matchedTerms: string[];
}

interface ReferenceLink {
  url: string;
  context: string;
}

interface AiMatchPayload {
  recordId: string;
  id?: string;
  confidence: number;
  rationale: string;
  reason?: string;
  transcriptEvidence?: string;
  matchedTerms?: string[];
  referenceUrl?: string;
}

interface AiResponsePayload {
  matches?: AiMatchPayload[];
  notes?: string[] | string;
}

interface OllamaGeneratePayload {
  response?: string;
  thinking?: string;
}

interface NvidiaChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface OpenRouterChatCompletionPayload {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

function buildSearchText(record: MediaRecord): string {
  return [
    record.name,
    record.relativePath,
    record.sourcePath,
    record.mediaType,
    JSON.stringify(record.metadata),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) ?? [];
}

function buildDirectLink(record: MediaRecord): string | undefined {
  if (record.sourceKind === "frameio") {
    return record.downloadUrl;
  }

  const normalized = record.sourcePath.replace(/\\/g, "/");
  return `file:///${normalized}`;
}

function buildSourceLink(record: MediaRecord): string | undefined {
  if (record.sourceLink) {
    return record.sourceLink;
  }

  if (record.sourceKind === "local") {
    const normalized = record.sourcePath.replace(/\\/g, "/");
    return `file:///${normalized}`;
  }

  return undefined;
}

function compactTranscript(text: string, maxLength = 12000): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  return `${cleaned.slice(0, maxLength)}...`;
}

export function extractKeywords(text: string): string[] {
  const counts = new Map<string, number>();
  const sanitized = text.replace(/https?:\/\/[^\s)]+/gi, " ");

  for (const token of tokenize(sanitized)) {
    if (STOP_WORDS.has(token)) {
      continue;
    }

    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 32)
    .map(([token]) => token);
}

function scoreCandidate(record: MediaRecord, keywords: string[], rankingTerms: RankingTerm[]): number {
  const searchText = buildSearchText(record);
  let score = computeRankingBoost(searchText, rankingTerms) * 3;

  for (const keyword of keywords) {
    if (searchText.includes(keyword)) {
      score += keyword.length > 6 ? 3 : 2;
    }
  }

  if ([".mov", ".mxf", ".mp4"].includes(record.extension)) {
    score += 1;
  }

  return score;
}

function normalizePathLike(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").toLowerCase();
}

function buildLogicalRecordKey(record: MediaRecord): string {
  if (record.sourceKind === "local") {
    return `local:${normalizePathLike(record.sourcePath)}`;
  }

  return `frameio:${normalizePathLike(record.sourceLink)}:${normalizePathLike(record.relativePath)}`;
}

function compareCandidateQuality(left: CandidateRecord, right: CandidateRecord): number {
  const scoreDiff = left.heuristicScore - right.heuristicScore;
  if (scoreDiff !== 0) {
    return scoreDiff;
  }

  const termDiff = left.matchedTerms.length - right.matchedTerms.length;
  if (termDiff !== 0) {
    return termDiff;
  }

  const updatedDiff =
    (Date.parse(left.record.updatedAt ?? "") || 0) -
    (Date.parse(right.record.updatedAt ?? "") || 0);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }

  const sizeDiff = (left.record.size ?? 0) - (right.record.size ?? 0);
  if (sizeDiff !== 0) {
    return sizeDiff;
  }

  return left.record.id.localeCompare(right.record.id);
}

function dedupeCandidates(candidates: CandidateRecord[]): CandidateRecord[] {
  const bestByKey = new Map<string, CandidateRecord>();

  for (const candidate of candidates) {
    const key = buildLogicalRecordKey(candidate.record);
    const existing = bestByKey.get(key);
    if (!existing || compareCandidateQuality(candidate, existing) > 0) {
      bestByKey.set(key, candidate);
    }
  }

  return [...bestByKey.values()];
}

function selectCandidateRecords(
  records: MediaRecord[],
  transcript: string,
  rankingTerms: RankingTerm[],
  limit = 24,
): CandidateRecord[] {
  const keywords = extractKeywords(transcript);

  return dedupeCandidates(
    records
    .map((record) => ({
      record,
      heuristicScore: scoreCandidate(record, keywords, rankingTerms),
      directLink: buildDirectLink(record),
      sourceLink: buildSourceLink(record),
      matchedTerms: keywords.filter((keyword) => buildSearchText(record).includes(keyword)).slice(0, 8),
    }))
  )
    .sort((left, right) => right.heuristicScore - left.heuristicScore)
    .slice(0, limit);
}

function buildPrompt(transcript: string, candidates: CandidateRecord[], maxMatches: number): string {
  const references = extractReferenceLinks(transcript);
  const candidateLines = candidates
    .map((candidate, index) => {
      const { record } = candidate;
      return [
        `Candidate ${index + 1}:`,
        `recordId=${record.id}`,
        `name=${record.name}`,
        `relativePath=${record.relativePath}`,
        `sourceKind=${record.sourceKind}`,
        `sourceLink=${candidate.sourceLink ?? "none"}`,
        `rawLink=${candidate.directLink ?? "none"}`,
        `extension=${record.extension || "unknown"}`,
        `durationSeconds=${record.durationSeconds ?? "unknown"}`,
        `metadata=${JSON.stringify(record.metadata)}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "You are matching a transcript to the most likely raw source files in an archive.",
    "Use only the transcript and candidate metadata below.",
    "Return strict JSON with this shape:",
    '{"matches":[{"recordId":"string","confidence":0.0,"rationale":"string","transcriptEvidence":"string","matchedTerms":["string"]}],"notes":["string"]}',
    `Choose up to ${maxMatches} matches. Use confidence between 0 and 1.`,
    "If the evidence is weak, return fewer matches and explain why in notes.",
    "Prefer matches with clear transcript evidence in the filename, folder path, source context, or metadata.",
    "Do not guess. If a candidate does not have evidence, leave it out.",
    references.length > 0 ? "Return `referenceUrl` when one of the provided reference links clearly matches the selected raw file." : "",
    "",
    "Transcript:",
    compactTranscript(transcript),
    references.length > 0
      ? ["", "Reference links:", ...references.map((reference) => `${reference.url} | ${reference.context}`)].join("\n")
      : "",
    "",
    "Candidates:",
    candidateLines,
  ]
    .filter(Boolean)
    .join("\n");
}

export function extractJsonObject(rawText: string): string {
  const fencedMatch = rawText.match(/```json\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return rawText.slice(firstBrace, lastBrace + 1);
  }

  throw new Error("The AI provider did not return JSON.");
}

async function runOllama(prompt: string, model: string, runtime: AiRuntimeSettings): Promise<string> {
  const availableModels = (await getOllamaStatus(runtime)).installedModels;
  const tried = new Set<string>();
  const candidates = [model, ...buildOllamaFallbackOrder(availableModels, runtime.ollamaModel)].filter((value) => {
    if (!value || tried.has(value)) {
      return false;
    }
    tried.add(value);
    return true;
  });

  let lastError: Error | undefined;
  for (const candidateModel of candidates) {
    try {
      await warmOllamaModel(candidateModel, runtime);
      const response = await fetchWithTimeout(
        `${runtime.ollamaBaseUrl}/api/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: candidateModel,
            prompt,
            stream: false,
            format: "json",
            think: false,
            keep_alive: "30m",
            options: {
              temperature: 0.1,
            },
          }),
        },
        `Ollama request for ${candidateModel}`,
        config.ai.ollamaRequestTimeoutMs,
      );

      if (!response.ok) {
        throw new Error(`Ollama request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
      }

      const payload = (await response.json()) as OllamaGeneratePayload;
      const output = extractOllamaResponseText(payload);
      if (!output) {
        throw new Error("Ollama returned an empty response.");
      }

      return output;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("Ollama request failed.");
}

async function runGeminiCli(prompt: string, model: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        config.ai.geminiCliCommand,
        "-m",
        model,
        "-p",
        ".",
        "--output-format",
        "text",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = 4 * 1024 * 1024;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      child.kill();
      reject(new Error(`Gemini CLI timed out after ${config.ai.requestTimeoutMs}ms.`));
    }, config.ai.requestTimeoutMs);

    function finishWithError(message: string): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      child.kill();
      reject(new Error(message));
    }

    child.on("error", (error) => {
      finishWithError(`Gemini CLI failed: ${error.message}`);
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        finishWithError("Gemini CLI output exceeded 4194304 bytes.");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        finishWithError("Gemini CLI output exceeded 4194304 bytes.");
      }
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Gemini CLI exited with code ${code}.`));
        return;
      }

      if (!stdout.trim() && stderr.trim()) {
        reject(new Error(stderr.trim()));
        return;
      }

      resolve(stdout);
    });

    child.stdin.end(prompt);
  });
}

async function runNvidiaChat(prompt: string, model: string): Promise<string> {
  const response = await fetchWithTimeout(
    `${config.ai.nvidiaBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.ai.nvidiaApiKey}`,
        Accept: "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 16384,
        temperature: 0.2,
        top_p: 0.95,
        stream: false,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      }),
    },
    `NVIDIA request for ${model}`,
    config.ai.requestTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`NVIDIA request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  }

  const payload = (await response.json()) as NvidiaChatCompletionPayload;
  const content = extractChatCompletionText(payload);
  if (content) {
    return content;
  }

  throw new Error("NVIDIA returned an empty response.");
}

async function runOpenRouterChat(prompt: string, model: string, runtime: AiRuntimeSettings): Promise<string> {
  const apiKey = await getEffectiveOpenRouterApiKey();
  if (!apiKey) {
    throw new Error("OpenRouter API key is not configured.");
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };

  if (config.ai.openRouterSiteUrl) {
    headers["HTTP-Referer"] = config.ai.openRouterSiteUrl;
  }

  if (config.ai.openRouterAppName) {
    headers["X-Title"] = config.ai.openRouterAppName;
  }

  const response = await fetchWithTimeout(
    `${runtime.openRouterBaseUrl}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        top_p: 0.95,
      }),
    },
    `OpenRouter request for ${model}`,
    config.ai.requestTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`OpenRouter request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  }

  const payload = (await response.json()) as OpenRouterChatCompletionPayload;
  const content = extractChatCompletionText(payload);
  if (content) {
    return content;
  }

  throw new Error("OpenRouter returned an empty response.");
}

async function resolveProviderAvailability(runtime: AiRuntimeSettings): Promise<ClientConfigResponse["ai"]> {
  const [ollama, geminiCli, nvidia, openRouter] = await Promise.all([
    getOllamaStatus(runtime),
    getGeminiStatus(),
    getNvidiaStatus(),
    getOpenRouterStatus(runtime),
  ]);
  const providerStatus: Record<ConcreteAiProvider, { available: boolean }> = {
    ollama,
    "gemini-cli": geminiCli,
    nvidia,
    openrouter: openRouter,
  };
  const providerOrder = buildProviderOrder(config.ai.defaultProvider);
  const defaultProvider = providerOrder.find((provider) => providerStatus[provider].available) ?? null;

  return {
    defaultProvider,
    runtime,
    ollama,
    geminiCli,
    nvidia,
    openRouter,
  };
}

async function getOllamaStatus(runtime: AiRuntimeSettings): Promise<ClientConfigResponse["ai"]["ollama"]> {
  try {
    const response = await fetchWithTimeout(
      `${runtime.ollamaBaseUrl}/api/tags`,
      {},
      "Ollama status request",
      config.ai.ollamaRequestTimeoutMs,
    );
    if (!response.ok) {
      return {
        available: false,
        defaultModel: runtime.ollamaModel,
        installedModels: [],
      };
    }

    const payload = (await response.json()) as { models?: Array<{ name?: string }> };
    const installedModels = (payload.models ?? []).map((model) => model.name ?? "").filter(Boolean);
    return {
      available: true,
      defaultModel: choosePreferredOllamaModel(installedModels, runtime.ollamaModel),
      installedModels,
    };
  } catch {
    return {
      available: false,
      defaultModel: runtime.ollamaModel,
      installedModels: [],
    };
  }
}

function dedupeMatches(matches: TranscriptMatch[]): TranscriptMatch[] {
  const bestByKey = new Map<string, TranscriptMatch>();

  for (const match of matches) {
    const key = buildLogicalRecordKey(match.record);
    const existing = bestByKey.get(key);
    if (!existing || match.confidence > existing.confidence) {
      bestByKey.set(key, match);
    }
  }

  return [...bestByKey.values()];
}

async function getGeminiStatus(): Promise<ClientConfigResponse["ai"]["geminiCli"]> {
  try {
    await execFileAsync("cmd.exe", ["/c", config.ai.geminiCliCommand, "--version"], {
      timeout: 10_000,
      maxBuffer: 256 * 1024,
    });

    return {
      available: true,
      defaultModel: config.ai.defaultGeminiModel,
      installedModels: [],
    };
  } catch {
    return {
      available: false,
      defaultModel: config.ai.defaultGeminiModel,
      installedModels: [],
    };
  }
}

async function getNvidiaStatus(): Promise<ClientConfigResponse["ai"]["nvidia"]> {
  return {
    available: Boolean(config.ai.nvidiaApiKey.trim()),
    defaultModel: config.ai.defaultNvidiaModel,
    installedModels: config.ai.nvidiaApiKey.trim() ? [config.ai.defaultNvidiaModel] : [],
  };
}

async function getOpenRouterStatus(runtime: AiRuntimeSettings): Promise<ClientConfigResponse["ai"]["openRouter"]> {
  const apiKey = await getEffectiveOpenRouterApiKey();
  return {
    available: Boolean(apiKey.trim()),
    defaultModel: runtime.openRouterModel,
    installedModels: apiKey.trim() ? [runtime.openRouterModel] : [],
  };
}

function buildProviderOrder(defaultProvider: ConcreteAiProvider): ConcreteAiProvider[] {
  if (defaultProvider === "openrouter") {
    return ["openrouter", "nvidia", "gemini-cli", "ollama"];
  }

  if (defaultProvider === "nvidia") {
    return ["nvidia", "openrouter", "gemini-cli", "ollama"];
  }

  if (defaultProvider === "gemini-cli") {
    return ["gemini-cli", "openrouter", "nvidia", "ollama"];
  }

  return ["ollama", "openrouter", "nvidia", "gemini-cli"];
}

function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

export async function getAiRuntimeStatus(): Promise<ClientConfigResponse["ai"]> {
  const runtime = await getEffectiveAiRuntimeSettings();
  return resolveProviderAvailability(runtime);
}

export async function matchTranscriptToRecords(params: {
  transcript: string;
  records: MediaRecord[];
  rankingTerms: RankingTerm[];
  referenceText?: string;
  onActivity?: ActivityLogger;
  providerPreference?: AiProviderKind;
  modelPreference?: string;
  maxCandidates?: number;
  maxMatches?: number;
}): Promise<MatchingResult> {
  const startedAt = Date.now();
  const runtime = await getEffectiveAiRuntimeSettings();
  const availability = await resolveProviderAvailability(runtime);
  const providerPreference = params.providerPreference ?? "auto";
  const provider =
    providerPreference === "auto"
      ? availability.defaultProvider
      : providerPreference;

  if (!provider) {
    throw new Error("No AI provider is available. Start Ollama, configure Gemini CLI, or save NVIDIA/OpenRouter API access.");
  }

  if (provider === "ollama" && !availability.ollama.available) {
    throw new Error(`Ollama is not available at ${runtime.ollamaBaseUrl}.`);
  }

  if (provider === "gemini-cli" && !availability.geminiCli.available) {
    throw new Error("Gemini CLI is not available.");
  }

  if (provider === "nvidia" && !availability.nvidia.available) {
    throw new Error("NVIDIA API is not available.");
  }

  if (provider === "openrouter" && !availability.openRouter.available) {
    throw new Error("OpenRouter API is not available.");
  }

  const model =
    params.modelPreference?.trim() ||
    (provider === "ollama"
      ? availability.ollama.defaultModel
      : provider === "gemini-cli"
        ? config.ai.defaultGeminiModel
        : provider === "nvidia"
          ? config.ai.defaultNvidiaModel
          : availability.openRouter.defaultModel);

  const references = extractReferenceLinks(params.referenceText ?? params.transcript);
  const maxCandidates = Math.max(10, Math.min(100, params.maxCandidates ?? 24));
  const maxMatches = Math.max(1, Math.min(20, params.maxMatches ?? 8));
  const candidates = selectCandidateRecords(params.records, params.transcript, params.rankingTerms, maxCandidates);
  params.onActivity?.({
    stage: "matching.prepare",
    message: `Prepared ${candidates.length} unique candidate files`,
      detail: {
        provider,
        model,
        ollamaBaseUrl: provider === "ollama" ? runtime.ollamaBaseUrl : undefined,
        openRouterBaseUrl: provider === "openrouter" ? runtime.openRouterBaseUrl : undefined,
        referenceLinks: references.length,
        maxCandidates,
        maxMatches,
    },
  });
  params.onActivity?.({
    stage: "matching.references",
    level: references.length > 0 ? "info" : "warning",
    message:
      references.length > 0
        ? `Extracted ${references.length} reference links from the transcript input`
        : "No reference links found in transcript or ranking input",
  });
  if (candidates.length === 0) {
    return {
      provider,
      model,
      status: "fallback",
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      transcriptPreview: compactTranscript(params.transcript, 280),
      transcriptLength: params.transcript.length,
      candidateCount: 0,
      matches: [],
      notes: ["No candidate records were available to match against the transcript."],
    };
  }

  try {
    const prompt = buildPrompt(params.transcript, candidates, maxMatches);
    params.onActivity?.({
      stage: "matching.provider",
      message: `Running ${provider} with model ${model}`,
      detail:
        provider === "ollama"
          ? { ollamaBaseUrl: runtime.ollamaBaseUrl }
          : provider === "openrouter"
            ? { openRouterBaseUrl: runtime.openRouterBaseUrl }
            : undefined,
    });
    const rawResponse =
      provider === "ollama"
        ? await runOllama(prompt, model, runtime)
        : provider === "gemini-cli"
          ? await runGeminiCli(prompt, model)
          : provider === "nvidia"
            ? await runNvidiaChat(prompt, model)
            : await runOpenRouterChat(prompt, model, runtime);
    const payload = JSON.parse(extractJsonObject(rawResponse)) as AiResponsePayload;

    const byId = new Map(candidates.map((candidate) => [candidate.record.id, candidate]));
    const matches = dedupeMatches((payload.matches ?? [])
      .map((match): TranscriptMatch | null => {
        const candidate = byId.get(match.recordId || match.id || "");
        if (!candidate) {
          return null;
        }

        return {
          recordId: candidate.record.id,
          confidence: normalizeConfidence(match.confidence),
          rationale: match.rationale?.trim() || match.reason?.trim() || "No rationale provided.",
          transcriptEvidence: match.transcriptEvidence?.trim() || "",
          matchedTerms: ((match.matchedTerms ?? []).filter(Boolean).length > 0
            ? (match.matchedTerms ?? []).filter(Boolean)
            : candidate.matchedTerms),
          referenceUrl: match.referenceUrl?.trim() || pickReferenceUrl(candidate, references, match.transcriptEvidence),
          record: candidate.record,
          directLink: candidate.directLink,
          sourceLink: candidate.sourceLink,
        };
      })
      .filter((match): match is TranscriptMatch => Boolean(match))
    )
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, maxMatches);

    return {
      provider,
      model,
      status: "used",
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      transcriptPreview: compactTranscript(params.transcript, 280),
      transcriptLength: params.transcript.length,
      candidateCount: candidates.length,
      matches,
      notes: normalizeNotes(payload.notes),
    };
  } catch (error) {
    params.onActivity?.({
      stage: "matching.provider",
      level: "warning",
      message: error instanceof Error ? error.message : String(error),
    });
    const fallbackCandidates = dedupeCandidates(candidates
      .filter((candidate) => candidate.matchedTerms.length > 0 && candidate.heuristicScore >= 2)
    )
      .slice(0, maxMatches);

    return {
      provider,
      model,
      status: "fallback",
      durationMs: Date.now() - startedAt,
      generatedAt: new Date().toISOString(),
      transcriptPreview: compactTranscript(params.transcript, 280),
      transcriptLength: params.transcript.length,
      candidateCount: candidates.length,
      matches: fallbackCandidates.map((candidate) => ({
        recordId: candidate.record.id,
        confidence: normalizeConfidence(Math.min(0.98, Math.max(0.12, candidate.heuristicScore / 20))),
        rationale: "Fallback heuristic ranking based on transcript keyword overlap and ranked terms.",
        transcriptEvidence: compactTranscript(params.transcript, 180),
        matchedTerms: candidate.matchedTerms,
        referenceUrl: pickReferenceUrl(candidate, references),
        record: candidate.record,
        directLink: candidate.directLink,
        sourceLink: candidate.sourceLink,
      })),
      notes: [
        error instanceof Error ? error.message : String(error),
        ...(fallbackCandidates.length === 0 ? ["No high-confidence fallback candidates were found."] : []),
      ],
    };
  }
}
function normalizeNotes(notes: AiResponsePayload["notes"]): string[] {
  if (Array.isArray(notes)) {
    return notes.filter(Boolean);
  }

  if (typeof notes === "string" && notes.trim()) {
    return [notes.trim()];
  }

  return [];
}

function choosePreferredOllamaModel(installedModels: string[], preferredModel?: string): string {
  if (preferredModel?.trim()) {
    const exactMatch = installedModels.find((model) => model === preferredModel);
    if (exactMatch) {
      return exactMatch;
    }
  }

  const preferredPatterns = [
    /^qwen3\.5:latest$/i,
    /qwen3\.5/i,
    /qwen3\.5.*9b/i,
    /unsloth\/qwen3\.5-9b/i,
    /qwen2\.5.*7b/i,
    /qwen2\.5:3b/i,
  ];

  for (const pattern of preferredPatterns) {
    const hit = installedModels.find((model) => pattern.test(model));
    if (hit) {
      return hit;
    }
  }

  return installedModels[0] || preferredModel?.trim() || config.ai.defaultOllamaModel;
}

function buildOllamaFallbackOrder(installedModels: string[], preferredModel?: string): string[] {
  const preferredInstalledModel = preferredModel?.trim()
    ? installedModels.find((model) => model === preferredModel)
    : undefined;
  const preferred = [
    preferredInstalledModel,
    choosePreferredOllamaModel(installedModels, preferredModel),
    installedModels.find((model) => /^qwen3\.5:latest$/i.test(model)),
    installedModels.find((model) => /^qwen3\.5:9b$/i.test(model)),
    installedModels.find((model) => /qwen3\.5/i.test(model)),
    installedModels.find((model) => /qwen2\.5:3b/i.test(model)),
  ];

  return preferred.filter((value): value is string => Boolean(value));
}

export async function warmDefaultLocalModel(): Promise<void> {
  const runtime = await getEffectiveAiRuntimeSettings();
  const ollama = await getOllamaStatus(runtime);
  if (!ollama.available) {
    return;
  }

  await warmOllamaModel(ollama.defaultModel, runtime);
}

async function warmOllamaModel(model: string, runtime: AiRuntimeSettings): Promise<void> {
  const response = await fetchWithTimeout(
    `${runtime.ollamaBaseUrl}/api/generate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt: "OK",
        stream: false,
        think: false,
        options: {
          num_predict: 1,
          temperature: 0,
        },
        keep_alive: "30m",
      }),
    },
    `Ollama warmup for ${model}`,
    config.ai.ollamaRequestTimeoutMs,
  );

  if (!response.ok) {
    throw new Error(`Ollama warmup failed for ${model}: ${(await response.text()).slice(0, 240)}`);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = config.ai.requestTimeoutMs,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function extractReferenceLinks(text: string): ReferenceLink[] {
  const lines = text.split(/\r?\n/);
  const groups: string[] = [];
  let currentGroup: string[] = [];

  function flushGroup(): void {
    if (currentGroup.length === 0) {
      return;
    }

    groups.push(currentGroup.join(" ").trim());
    currentGroup = [];
  }

  for (const line of lines) {
    const trimmed = line.trim();
    const startsNewItem = /^(\d+\.\s+|[-*]\s+)/.test(trimmed);

    if (!trimmed) {
      flushGroup();
      continue;
    }

    if (startsNewItem && currentGroup.length > 0) {
      flushGroup();
    }

    currentGroup.push(trimmed);
  }

  flushGroup();

  const results = groups.flatMap((group) => {
    const urls = group.match(/https?:\/\/[^\s)]+/gi) ?? [];
    return urls.map((url) => ({
      url,
      context: group.slice(0, 480),
    }));
  });

  if (results.length > 0) {
    return results;
  }

  return lines.flatMap((line, index) => {
    const urls = line.match(/https?:\/\/[^\s)]+/gi) ?? [];
    return urls.map((url) => ({
      url,
      context: [lines[index - 2], lines[index - 1], line, lines[index + 1], lines[index + 2]]
        .filter(Boolean)
        .join(" ")
        .slice(0, 480),
    }));
  });
}

export function pickReferenceUrl(
  candidate: CandidateRecord,
  references: ReferenceLink[],
  transcriptEvidence?: string,
): string | undefined {
  if (references.length === 0) {
    return undefined;
  }

  const candidateTerms = new Set([
    ...candidate.matchedTerms.filter((term) => !STOP_WORDS.has(term)),
    ...tokenize(candidate.record.name),
    ...tokenize(candidate.record.relativePath),
    ...tokenize(transcriptEvidence ?? "").filter((term) => !STOP_WORDS.has(term)),
  ]);

  const scored = references
    .map((reference) => ({
      reference,
      score: tokenize(`${reference.url} ${reference.context}`).reduce(
        (sum, token) => sum + (candidateTerms.has(token) ? 1 : 0),
        0,
      ),
    }))
    .sort((left, right) => right.score - left.score);

  return scored[0]?.score ? scored[0].reference.url : undefined;
}

function extractOllamaResponseText(payload: OllamaGeneratePayload): string {
  if (payload.response?.trim()) {
    return payload.response.trim();
  }

  const thinking = payload.thinking?.trim();
  if (!thinking) {
    return "";
  }

  try {
    const parsed = JSON.parse(thinking) as {
      matches?: unknown[];
      output?: string;
      response?: string;
    };

    if (Array.isArray(parsed.matches)) {
      return JSON.stringify(parsed);
    }

    if (typeof parsed.output === "string" && parsed.output.trim()) {
      return parsed.output.trim();
    }

    if (typeof parsed.response === "string" && parsed.response.trim()) {
      return parsed.response.trim();
    }
  } catch {
    return "";
  }

  return "";
}

function extractChatCompletionText(payload: NvidiaChatCompletionPayload | OpenRouterChatCompletionPayload): string {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content.map((part) => part.text ?? "").join("").trim();
    if (text) {
      return text;
    }
  }

  return "";
}
