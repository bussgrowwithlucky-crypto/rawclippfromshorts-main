import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import type { AiRuntimeSettings } from "../models.js";

interface PersistedAiRuntimeSettings {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openRouterBaseUrl?: string;
  openRouterModel?: string;
  openRouterApiKey?: string;
}

const settingsPath = path.join(config.dataDir, "settings", "ai-runtime.json");
let cachedSettings: PersistedAiRuntimeSettings | null | undefined;

function normalizeBaseUrl(value: string | undefined, label: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid http or https URL.`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }

  return trimmed.replace(/\/+$/, "");
}

function normalizeModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeSecret(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRemoteOllamaUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1";
  } catch {
    return false;
  }
}

async function readPersistedSettings(): Promise<PersistedAiRuntimeSettings> {
  if (cachedSettings !== undefined) {
    return cachedSettings ?? {};
  }

  try {
    const raw = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedAiRuntimeSettings;
    cachedSettings = parsed;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      cachedSettings = null;
      return {};
    }

    throw error;
  }
}

async function writePersistedSettings(input: PersistedAiRuntimeSettings): Promise<void> {
  const payload: PersistedAiRuntimeSettings = {};

  if (input.ollamaBaseUrl) {
    payload.ollamaBaseUrl = input.ollamaBaseUrl;
  }

  if (input.ollamaModel) {
    payload.ollamaModel = input.ollamaModel;
  }

  if (input.openRouterBaseUrl) {
    payload.openRouterBaseUrl = input.openRouterBaseUrl;
  }

  if (input.openRouterModel) {
    payload.openRouterModel = input.openRouterModel;
  }

  if (input.openRouterApiKey) {
    payload.openRouterApiKey = input.openRouterApiKey;
  }

  cachedSettings = Object.keys(payload).length > 0 ? payload : null;

  if (Object.keys(payload).length === 0) {
    await fs.rm(settingsPath, { force: true });
    return;
  }

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(payload, null, 2), "utf8");
}

export async function getEffectiveAiRuntimeSettings(): Promise<AiRuntimeSettings> {
  const persisted = await readPersistedSettings();
  const ollamaBaseUrl = normalizeBaseUrl(persisted.ollamaBaseUrl, "Ollama endpoint") ?? config.ai.ollamaBaseUrl;
  const ollamaModel = normalizeModel(persisted.ollamaModel) ?? config.ai.defaultOllamaModel;
  const openRouterBaseUrl =
    normalizeBaseUrl(persisted.openRouterBaseUrl, "OpenRouter endpoint") ?? config.ai.openRouterBaseUrl;
  const openRouterModel = normalizeModel(persisted.openRouterModel) ?? config.ai.defaultOpenRouterModel;
  const openRouterApiKey = normalizeSecret(persisted.openRouterApiKey) ?? normalizeSecret(config.ai.openRouterApiKey);

  return {
    ollamaBaseUrl,
    ollamaModel,
    openRouterBaseUrl,
    openRouterModel,
    hasOverrides: Boolean(
      persisted.ollamaBaseUrl ||
      persisted.ollamaModel ||
      persisted.openRouterBaseUrl ||
      persisted.openRouterModel ||
      persisted.openRouterApiKey,
    ),
    usesRemoteOllama: isRemoteOllamaUrl(ollamaBaseUrl),
    hasOpenRouterApiKey: Boolean(openRouterApiKey),
  };
}

export async function getEffectiveOpenRouterApiKey(): Promise<string> {
  const persisted = await readPersistedSettings();
  return normalizeSecret(persisted.openRouterApiKey) ?? normalizeSecret(config.ai.openRouterApiKey) ?? "";
}

export async function saveAiRuntimeSettings(input: {
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  openRouterBaseUrl?: string;
  openRouterModel?: string;
  openRouterApiKey?: string;
}): Promise<AiRuntimeSettings> {
  const existing = await readPersistedSettings();
  await writePersistedSettings({
    ollamaBaseUrl: normalizeBaseUrl(input.ollamaBaseUrl, "Ollama endpoint"),
    ollamaModel: normalizeModel(input.ollamaModel),
    openRouterBaseUrl: normalizeBaseUrl(input.openRouterBaseUrl, "OpenRouter endpoint"),
    openRouterModel: normalizeModel(input.openRouterModel),
    openRouterApiKey: normalizeSecret(input.openRouterApiKey) ?? existing.openRouterApiKey,
  });

  return getEffectiveAiRuntimeSettings();
}

export async function clearAiRuntimeSettings(): Promise<AiRuntimeSettings> {
  await writePersistedSettings({});
  return getEffectiveAiRuntimeSettings();
}
