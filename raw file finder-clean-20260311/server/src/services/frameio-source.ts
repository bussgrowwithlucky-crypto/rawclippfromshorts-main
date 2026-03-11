import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { DiscoveryResult, FrameIoAuth, MediaRecord, SourceDescriptor } from "../models.js";
import type { ActivityLogger } from "./activity-log.js";

interface FrameIoTraversalState {
  sourceUrl: string;
  rootAssetId: string;
  status: "running" | "completed";
  updatedAt: string;
  pendingFolderIds: string[];
  visitedFolderIds: string[];
  pageByFolderId: Record<string, number>;
  records: MediaRecord[];
  warnings: string[];
}

interface FrameIoAsset {
  id?: string;
  name?: string;
  type?: string;
  asset_type?: string;
  filetype?: string;
  filesize?: number;
  created_at?: string;
  updated_at?: string;
  duration?: number;
  duration_seconds?: number;
  download_url?: string;
  parent_id?: string;
  path?: string;
  [key: string]: unknown;
}

interface FrameIoChildrenResponse {
  items?: FrameIoAsset[];
  next_page?: number | null;
}

const VIDEO_TYPES = new Set(["video", "video/mp4", "video/quicktime", "mp4", "mov", "mxf"]);

export async function discoverFrameIoArchive(
  source: SourceDescriptor,
  options?: { forceRefresh?: boolean; onActivity?: ActivityLogger } & FrameIoAuth,
): Promise<DiscoveryResult> {
  const cachePath = path.join(config.dataDir, "cache", "frameio", `${source.cacheKey}.json`);
  if (options?.forceRefresh) {
    await fs.rm(cachePath, { force: true });
  }

  const existing = options?.forceRefresh ? null : await readJsonFile<FrameIoTraversalState>(cachePath);
  const resumed = Boolean(existing && existing.status === "running");
  const state: FrameIoTraversalState =
    existing && existing.sourceUrl === source.input
      ? existing
      : {
          sourceUrl: source.input,
          rootAssetId: "",
          status: "running",
          updatedAt: new Date().toISOString(),
          pendingFolderIds: [],
          visitedFolderIds: [],
          pageByFolderId: {},
          records: [],
          warnings: [],
        };

  options?.onActivity?.({
    stage: "discovery.frameio",
    message: resumed ? "Resuming cached Frame.io traversal" : "Starting Frame.io traversal",
    detail: {
      cachePath,
    },
  });

  if (!state.rootAssetId) {
    state.rootAssetId = await resolveRootAssetId(source.input, options);
    state.pendingFolderIds = [state.rootAssetId];
    await writeJsonFile(cachePath, state);
    options?.onActivity?.({
      stage: "discovery.frameio",
      message: `Resolved Frame.io root asset ${state.rootAssetId}`,
    });
  }

  while (state.pendingFolderIds.length > 0) {
    const folderId = state.pendingFolderIds[0];
    options?.onActivity?.({
      stage: "discovery.frameio",
      message: `Traversing Frame.io folder ${state.visitedFolderIds.length + 1}`,
      detail: {
        folderId,
        pendingFolders: state.pendingFolderIds.length,
      },
    });
    let page = state.pageByFolderId[folderId] ?? 1;
    let nextPage: number | null = page;

    while (nextPage) {
      const payload = await requestJson<FrameIoChildrenResponse | FrameIoAsset[]>(
        `/v2/assets/${folderId}/children?page=${page}&per_page=100`,
        options,
      );
      const normalized = normalizeChildrenPayload(payload);

      for (const item of normalized.items) {
        const itemType = String(item.type ?? item.asset_type ?? "").toLowerCase();
        if (isFolderType(itemType)) {
          if (item.id && !state.visitedFolderIds.includes(item.id) && !state.pendingFolderIds.includes(item.id)) {
            state.pendingFolderIds.push(item.id);
          }
          continue;
        }

        if (!isVideoAsset(item)) {
          continue;
        }

        const record = toMediaRecord(source, item);
        if (!state.records.some((existingRecord) => existingRecord.id === record.id)) {
          state.records.push(record);
        }
      }

      options?.onActivity?.({
        stage: "discovery.frameio",
        message: `Frame.io page ${page} processed`,
        detail: {
          folderId,
          recordsDiscovered: state.records.length,
          nextPage: normalized.nextPage,
        },
      });

      nextPage = normalized.nextPage;
      if (nextPage) {
        page = nextPage;
        state.pageByFolderId[folderId] = page;
      } else {
        delete state.pageByFolderId[folderId];
      }

      state.updatedAt = new Date().toISOString();
      await writeJsonFile(cachePath, state);
    }

    state.pendingFolderIds.shift();
    state.visitedFolderIds.push(folderId);
    state.updatedAt = new Date().toISOString();
    await writeJsonFile(cachePath, state);
  }

  state.status = "completed";
  state.updatedAt = new Date().toISOString();
  await writeJsonFile(cachePath, state);

  options?.onActivity?.({
    stage: "discovery.frameio",
    level: "success",
    message: `Frame.io traversal finished with ${state.records.length} records`,
    detail: {
      folderCount: state.visitedFolderIds.length,
      cachePath,
    },
  });

  return {
    source,
    records: state.records,
    folderCount: state.visitedFolderIds.length,
    fileCount: state.records.length,
    cachePath,
    resumed,
    warnings: state.warnings,
  };
}

async function resolveRootAssetId(sourceUrl: string, authOverrides?: FrameIoAuth): Promise<string> {
  const directId = extractIdFromUrl(sourceUrl);
  if (directId) {
    return directId;
  }

  const response = await fetch(sourceUrl, { headers: buildHeaders(authOverrides) });
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error(
        "Frame.io returned 401 Unauthorized while resolving the link. Add a valid Frame.io bearer token or session cookie in the app. The local AI model does not authenticate Frame.io for you.",
      );
    }

    throw new Error(`Unable to resolve Frame.io link (${response.status}).`);
  }

  const html = await response.text();
  const htmlMatch =
    html.match(/"root_asset_id":"([^"]+)"/) ??
    html.match(/"asset_id":"([^"]+)"/) ??
    html.match(/"id":"([a-f0-9-]{8,})"/i);

  if (htmlMatch?.[1]) {
    return htmlMatch[1];
  }

  throw new Error(
    "Unable to resolve a Frame.io root asset from the link. Provide a direct folder URL or configure authenticated access.",
  );
}

function extractIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (/^[a-f0-9-]{8,}$/i.test(segments[index])) {
        return segments[index];
      }
    }
  } catch {
    return null;
  }

  return null;
}

function isFolderType(itemType: string): boolean {
  return itemType.includes("folder");
}

function isVideoAsset(item: FrameIoAsset): boolean {
  const itemType = String(item.type ?? item.asset_type ?? "").toLowerCase();
  const fileType = String(item.filetype ?? "").toLowerCase();
  return VIDEO_TYPES.has(itemType) || VIDEO_TYPES.has(fileType) || fileType.startsWith("video/");
}

function toMediaRecord(source: SourceDescriptor, item: FrameIoAsset): MediaRecord {
  const relativePath = String(item.path ?? item.name ?? item.id ?? "unknown");
  const extensionMatch = String(item.name ?? "").match(/\.[^.]+$/);
  return {
    id: String(item.id ?? `${source.cacheKey}:${relativePath}`),
    name: String(item.name ?? relativePath),
    relativePath,
    sourcePath: relativePath,
    sourceLink: source.input,
    sourceKind: "frameio",
    mediaType: String(item.filetype ?? item.asset_type ?? "video"),
    extension: extensionMatch?.[0]?.toLowerCase() ?? "",
    size: typeof item.filesize === "number" ? item.filesize : undefined,
    updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
    createdAt: typeof item.created_at === "string" ? item.created_at : undefined,
    durationSeconds:
      typeof item.duration_seconds === "number"
        ? item.duration_seconds
        : typeof item.duration === "number"
          ? item.duration
          : undefined,
    downloadUrl: typeof item.download_url === "string" ? item.download_url : undefined,
    folderId: typeof item.parent_id === "string" ? item.parent_id : undefined,
    metadata: item as Record<string, unknown>,
  };
}

function normalizeChildrenPayload(
  payload: FrameIoChildrenResponse | FrameIoAsset[],
): { items: FrameIoAsset[]; nextPage: number | null } {
  if (Array.isArray(payload)) {
    return { items: payload, nextPage: null };
  }

  return {
    items: payload.items ?? [],
    nextPage: typeof payload.next_page === "number" ? payload.next_page : null,
  };
}

async function requestJson<T>(requestPath: string, authOverrides?: FrameIoAuth): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.frameio.requestTimeoutMs);

  try {
    const response = await fetch(`${config.frameio.apiBaseUrl}${requestPath}`, {
      headers: buildHeaders(authOverrides),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await response.text();
      if (response.status === 401) {
        throw new Error(
          "Frame.io request failed with 401 Unauthorized. Add a valid Frame.io bearer token or session cookie in the UI before processing this link.",
        );
      }
      throw new Error(`Frame.io request failed (${response.status}): ${message.slice(0, 240)}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildHeaders(authOverrides?: FrameIoAuth): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
  };

  const bearerToken = authOverrides?.bearerToken || config.frameio.bearerToken;
  const sessionCookie = authOverrides?.sessionCookie || config.frameio.sessionCookie;

  if (bearerToken) {
    headers.authorization = `Bearer ${bearerToken}`;
  }

  if (sessionCookie) {
    headers.cookie = sessionCookie;
  }

  return headers;
}
