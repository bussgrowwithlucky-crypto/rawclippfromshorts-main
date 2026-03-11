export type AiProviderKind = 'auto' | 'ollama' | 'gemini-cli' | 'nvidia' | 'openrouter'

export interface RankingTerm {
  term: string
  weight: number
}

export interface MediaRecord {
  id: string
  name: string
  relativePath: string
  sourcePath: string
  sourceLink?: string
  sourceKind: 'local' | 'frameio'
  mediaType: string
  extension: string
  size?: number
  updatedAt?: string
  createdAt?: string
  durationSeconds?: number
  downloadUrl?: string
}

export interface TranscriptMatch {
  recordId: string
  confidence: number
  rationale: string
  transcriptEvidence: string
  matchedTerms: string[]
  referenceUrl?: string
  referenceTitle?: string
  referenceTranscriptPreview?: string
  referenceReason?: string
  referenceMatchStatus?: 'matched' | 'unresolved' | 'failed'
  sourceLink?: string
  directLink?: string
  record: MediaRecord
}

export interface MatchingResult {
  provider: 'ollama' | 'gemini-cli' | 'nvidia' | 'openrouter'
  model: string
  status: 'used' | 'fallback' | 'skipped' | 'failed'
  generatedAt: string
  durationMs: number
  transcriptPreview: string
  transcriptLength: number
  candidateCount: number
  matches: TranscriptMatch[]
  notes: string[]
}

export interface ActivityLogEntry {
  id: string
  requestId: string
  timestamp: string
  level: 'info' | 'warning' | 'error' | 'success'
  stage: string
  message: string
  detail?: Record<string, unknown>
}

export interface AiProviderStatus {
  available: boolean
  defaultModel: string
  installedModels: string[]
}

export interface AiRuntimeSettings {
  ollamaBaseUrl: string
  ollamaModel: string
  openRouterBaseUrl: string
  openRouterModel: string
  hasOverrides: boolean
  usesRemoteOllama: boolean
  hasOpenRouterApiKey: boolean
}

export interface ClientConfigResponse {
  frameio: {
    hasEnvBearerToken: boolean
    hasEnvSessionCookie: boolean
    hasSessionBearerToken: boolean
    hasSessionSessionCookie: boolean
  }
  ai: {
    defaultProvider: 'ollama' | 'gemini-cli' | 'nvidia' | 'openrouter' | null
    runtime: AiRuntimeSettings
    ollama: AiProviderStatus
    geminiCli: AiProviderStatus
    nvidia: AiProviderStatus
    openRouter: AiProviderStatus
  }
}

export interface ProcessResponse {
  jobId: string
  source: {
    kind: 'local' | 'frameio'
    input: string
  }
  summary: {
    fileCount: number
    folderCount: number
    indexedAt: string
    resumed: boolean
    warnings: string[]
    cachePath?: string
    matchedCount: number
  }
  transcript: {
    fileName?: string
    textLength: number
    hasTranscript: boolean
  }
  rankingTerms: RankingTerm[]
  matching?: MatchingResult
  references?: {
    totalCount: number
    matchedCount: number
    unresolvedCount: number
    failedCount: number
    cachePath?: string
  }
}

export interface SearchResult {
  score: number
  rankingBoost: number
  record: MediaRecord
}
