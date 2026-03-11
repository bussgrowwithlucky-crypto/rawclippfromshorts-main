import path from "node:path";

const rootDir = path.resolve(process.cwd(), "..");
const dataDir = path.join(rootDir, "data");

export const config = {
  port: Number.parseInt(process.env.PORT ?? "4000", 10),
  dataDir,
  frameio: {
    apiBaseUrl: (process.env.FRAMEIO_API_BASE_URL ?? "https://api.frame.io").replace(/\/+$/, ""),
    bearerToken: process.env.FRAMEIO_BEARER_TOKEN ?? "",
    sessionCookie: process.env.FRAMEIO_SESSION_COOKIE ?? "",
    requestTimeoutMs: Number.parseInt(process.env.FRAMEIO_REQUEST_TIMEOUT_MS ?? "20000", 10),
  },
  ai: {
    ollamaBaseUrl: (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    nvidiaBaseUrl: (process.env.NVIDIA_API_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
    nvidiaApiKey: process.env.NVIDIA_API_KEY ?? "",
    openRouterBaseUrl: (process.env.OPENROUTER_API_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
    openRouterAppName: process.env.OPENROUTER_APP_NAME ?? "Raw File Finder",
    openRouterSiteUrl: (process.env.OPENROUTER_SITE_URL ?? "").replace(/\/+$/, ""),
    requestTimeoutMs: Number.parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "120000", 10),
    ollamaRequestTimeoutMs: Number.parseInt(
      process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? process.env.AI_REQUEST_TIMEOUT_MS ?? "900000",
      10,
    ),
    defaultProvider: (process.env.AI_PROVIDER ?? "gemini-cli") as "ollama" | "gemini-cli" | "nvidia" | "openrouter",
    defaultModel: process.env.AI_MODEL ?? "qwen3.5:latest",
    defaultOllamaModel: process.env.OLLAMA_MODEL ?? "qwen3.5:latest",
    defaultGeminiModel: process.env.GEMINI_MODEL ?? "gemini-3.1-pro-preview",
    defaultNvidiaModel: process.env.NVIDIA_MODEL ?? "qwen/qwen3.5-122b-a10b",
    defaultOpenRouterModel: process.env.OPENROUTER_MODEL ?? "z-ai/glm-4.5-air:free",
    geminiCliCommand: process.env.GEMINI_CLI_COMMAND ?? "gemini",
  },
  reference: {
    whisperModel: process.env.REFERENCE_WHISPER_MODEL ?? "base",
    pipelineTimeoutMs: Number.parseInt(process.env.REFERENCE_PIPELINE_TIMEOUT_MS ?? "7200000", 10),
    matchMinConfidence: Number.parseFloat(process.env.REFERENCE_MATCH_MIN_CONFIDENCE ?? "0.78"),
    maxReferencesPerRun: Number.parseInt(process.env.REFERENCE_MAX_ITEMS ?? "40", 10),
  },
  sessionSecret: process.env.SESSION_SECRET ?? "raw-file-finder-local-session",
};
