export type SourceKind = "local" | "frameio";
export type AiProviderKind = "auto" | "ollama" | "gemini-cli" | "nvidia" | "openrouter";

export interface RankingTerm {
  term: string;
  weight: number;
}

export interface SourceRequest {
  localPath?: string;
  frameioLink?: string;
  forceRefresh?: boolean;
}

export interface ProcessRequest extends SourceRequest {
  requestId?: string;
  transcriptText?: string;
  transcriptFileName?: string;
  aiProvider?: AiProviderKind;
  aiModel?: string;
  maxCandidates?: number;
  maxMatches?: number;
}

export interface FrameIoAuth {
  bearerToken?: string;
  sessionCookie?: string;
}

export interface SourceDescriptor {
  kind: SourceKind;
  input: string;
  cacheKey: string;
}

export interface MediaRecord {
  id: string;
  name: string;
  relativePath: string;
  sourcePath: string;
  sourceLink?: string;
  sourceKind: SourceKind;
  mediaType: string;
  extension: string;
  size?: number;
  updatedAt?: string;
  createdAt?: string;
  durationSeconds?: number;
  downloadUrl?: string;
  folderId?: string;
  metadata: Record<string, unknown>;
}

export interface DiscoveryResult {
  source: SourceDescriptor;
  records: MediaRecord[];
  folderCount: number;
  fileCount: number;
  cachePath?: string;
  resumed: boolean;
  warnings: string[];
}

export interface SearchIndexDocument {
  record: MediaRecord;
  searchText: string;
}

export interface MatchCandidate {
  record: MediaRecord;
  heuristicScore: number;
  rankingBoost: number;
  keywordOverlap: number;
}

export interface TranscriptMatch {
  recordId: string;
  confidence: number;
  rationale: string;
  transcriptEvidence: string;
  matchedTerms: string[];
  referenceUrl?: string;
  referenceTitle?: string;
  referenceTranscriptPreview?: string;
  referenceReason?: string;
  referenceMatchStatus?: "matched" | "unresolved" | "failed";
  record: MediaRecord;
  sourceLink?: string;
  directLink?: string;
}

export interface MatchingResult {
  provider: Exclude<AiProviderKind, "auto">;
  model: string;
  status: "used" | "fallback" | "skipped" | "failed";
  generatedAt: string;
  durationMs: number;
  transcriptPreview: string;
  transcriptLength: number;
  candidateCount: number;
  matches: TranscriptMatch[];
  notes: string[];
}

export interface IndexState {
  id: string;
  source: SourceDescriptor;
  createdAt: string;
  rankingTerms: RankingTerm[];
  transcript: {
    fileName?: string;
    textLength: number;
  };
  references?: {
    totalCount: number;
    matchedCount: number;
    unresolvedCount: number;
    failedCount: number;
    cachePath?: string;
  };
  documents: SearchIndexDocument[];
  matching?: MatchingResult;
  summary: {
    fileCount: number;
    folderCount: number;
    indexedAt: string;
    matchedCount: number;
  };
}

export interface SearchResult {
  score: number;
  rankingBoost: number;
  record: MediaRecord;
}

export interface ProcessResponse {
  jobId: string;
  source: SourceDescriptor;
  summary: {
    fileCount: number;
    folderCount: number;
    indexedAt: string;
    resumed: boolean;
    warnings: string[];
    cachePath?: string;
    matchedCount: number;
  };
  transcript: {
    fileName?: string;
    textLength: number;
    hasTranscript: boolean;
  };
  rankingTerms: RankingTerm[];
  matching?: MatchingResult;
  references?: {
    totalCount: number;
    matchedCount: number;
    unresolvedCount: number;
    failedCount: number;
    cachePath?: string;
  };
}

export interface AiProviderStatus {
  available: boolean;
  defaultModel: string;
  installedModels: string[];
}

export interface AiRuntimeSettings {
  ollamaBaseUrl: string;
  ollamaModel: string;
  openRouterBaseUrl: string;
  openRouterModel: string;
  hasOverrides: boolean;
  usesRemoteOllama: boolean;
  hasOpenRouterApiKey: boolean;
}

export interface ClientConfigResponse {
  frameio: {
    hasEnvBearerToken: boolean;
    hasEnvSessionCookie: boolean;
    hasSessionBearerToken: boolean;
    hasSessionSessionCookie: boolean;
  };
  ai: {
    defaultProvider: Exclude<AiProviderKind, "auto"> | null;
    runtime: AiRuntimeSettings;
    ollama: AiProviderStatus;
    geminiCli: AiProviderStatus;
    nvidia: AiProviderStatus;
    openRouter: AiProviderStatus;
  };
}
