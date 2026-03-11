import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { config } from "../config.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type { DiscoveryResult, MediaRecord, SourceDescriptor } from "../models.js";
import type { ActivityLogger } from "./activity-log.js";

interface TraversalState {
  sourceUrl: string;
  resolvedUrl: string;
  shareId: string;
  status: "running" | "completed";
  updatedAt: string;
  pendingFolders: Array<{ id: string; parentPath: string }>;
  processedFolderIds: string[];
  records: MediaRecord[];
  warnings: string[];
}

interface GraphCollectionResponse {
  data?: {
    share?: {
      collectionAssets?: {
        nodes?: Array<{ id: string }>;
        totalCount?: number;
        pageInfo?: {
          endCursor?: string | null;
          hasNextPage?: boolean;
        };
      };
    };
  };
}

interface GraphAssetsResponse {
  data?: {
    assets?: GraphAsset[];
  };
}

interface GraphAsset {
  id: string;
  __typename: string;
  filetype?: string | null;
  name?: string | null;
  insertedAt?: string | null;
  parent?: {
    id?: string | null;
    name?: string | null;
  } | null;
  itemCount?: number | null;
  filesize?: number | null;
  media?: {
    filesize?: number | null;
    duration?: number | null;
    videoTranscodes?: Array<{
      key?: string | null;
      downloadUrl?: string | null;
      filesizeInBytes?: number | null;
      width?: number | null;
      height?: number | null;
      encodeStatus?: string | null;
    }> | null;
  } | null;
}

const listAssetsQuery = `
  query GetShareCollectionAssets($shareId: ID!, $folderId: ID, $assetType: ChildAssetTypeInput, $page: PageInput!) {
    share(shareId: $shareId) {
      id
      ... on Share {
        collectionAssets(page: $page, assetType: $assetType, folderId: $folderId) {
          pageInfo {
            endCursor
            hasNextPage
          }
          nodes {
            id
          }
          totalCount
        }
      }
    }
  }
`;

const hydrateAssetsQuery = `
  query HydrateAssets($ids: [ID!]!) {
    assets(assetIds: $ids) {
      id
      __typename
      filetype
      name
      insertedAt
      parent {
        id
        name
      }
      ... on FolderAsset {
        itemCount
        filesize
      }
      ... on VideoAsset {
        media {
          filesize
          duration
          videoTranscodes {
            key
            downloadUrl
            filesizeInBytes
            width
            height
            encodeStatus
          }
        }
      }
    }
  }
`;

export async function discoverPublicFrameIoShare(
  source: SourceDescriptor,
  options?: { forceRefresh?: boolean; onActivity?: ActivityLogger },
): Promise<DiscoveryResult> {
  const cachePath = path.join(config.dataDir, "cache", "frameio-public", `${source.cacheKey}.json`);
  if (options?.forceRefresh) {
    await writeJsonFile(cachePath, null);
  }

  const existing = options?.forceRefresh ? null : await readJsonFile<TraversalState>(cachePath);
  const resumed = Boolean(existing && existing.status === "running");

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const session = await initializePublicShareSession(page, source.input);
    options?.onActivity?.({
      stage: "discovery.frameio-public",
      message: "Connected to public Frame.io share",
      detail: {
        resolvedUrl: session.resolvedUrl,
        shareId: session.shareId,
      },
    });

    const state: TraversalState =
      existing && existing.sourceUrl === source.input && existing.shareId === session.shareId
        ? existing
        : {
            sourceUrl: source.input,
            resolvedUrl: session.resolvedUrl,
            shareId: session.shareId,
            status: "running",
            updatedAt: new Date().toISOString(),
            pendingFolders: [{ id: "__ROOT__", parentPath: "" }],
            processedFolderIds: [],
            records: [],
          warnings: [],
        };

    options?.onActivity?.({
      stage: "discovery.frameio-public",
      message: resumed ? "Resuming cached public share traversal" : "Starting public share traversal",
      detail: {
        cachePath,
      },
    });

    while (state.pendingFolders.length > 0) {
      const nextFolder = state.pendingFolders.shift()!;
      const folderKey = nextFolder.id === "__ROOT__" ? "__ROOT__" : nextFolder.id;
      if (state.processedFolderIds.includes(folderKey)) {
        continue;
      }

       options?.onActivity?.({
        stage: "discovery.frameio-public",
        message: `Traversing public share folder ${nextFolder.parentPath || "root"}`,
        detail: {
          folderId: nextFolder.id,
          pendingFolders: state.pendingFolders.length + 1,
        },
      });

      const folderId = nextFolder.id === "__ROOT__" ? undefined : nextFolder.id;
      const childFolders = await listAssets(page, session.headers, state.shareId, folderId, "FOLDER");
      const hydratedFolders = childFolders.length
        ? await hydrateAssets(page, session.headers, childFolders)
        : [];

      for (const folder of hydratedFolders.filter((asset) => asset.__typename === "FolderAsset")) {
        const childPath = nextFolder.parentPath
          ? `${nextFolder.parentPath}/${folder.name ?? folder.id}`
          : `${folder.name ?? folder.id}`;

        state.pendingFolders.push({
          id: folder.id,
          parentPath: childPath,
        });
      }

      const childFiles = await listAssets(page, session.headers, state.shareId, folderId, "FILE");
      const hydratedFiles = childFiles.length
        ? await hydrateAssets(page, session.headers, childFiles)
        : [];

      for (const asset of hydratedFiles.filter((entry) => entry.__typename === "VideoAsset")) {
        const fileName = asset.name?.trim() || asset.id;
        const relativePath = nextFolder.parentPath
          ? `${nextFolder.parentPath}/${fileName}`
          : fileName;
        const preferredDownload = pickBestDownload(asset);

        if (state.records.some((record) => record.id === asset.id)) {
          continue;
        }

        state.records.push({
          id: asset.id,
          name: fileName,
          relativePath,
          sourcePath: relativePath,
          sourceLink: state.resolvedUrl,
          sourceKind: "frameio",
          mediaType: asset.filetype ?? "video",
          extension: path.extname(fileName).toLowerCase(),
          size: asset.media?.filesize ?? preferredDownload?.filesizeInBytes ?? undefined,
          updatedAt: asset.insertedAt ?? undefined,
          createdAt: asset.insertedAt ?? undefined,
          durationSeconds: asset.media?.duration ?? undefined,
          downloadUrl: preferredDownload?.downloadUrl ?? undefined,
          folderId: folderId,
          metadata: {
            publicShare: true,
            shareId: state.shareId,
            resolvedUrl: state.resolvedUrl,
            transcodeKey: preferredDownload?.key ?? null,
          },
        });
      }

      options?.onActivity?.({
        stage: "discovery.frameio-public",
        message: `Public share folder processed with ${state.records.length} records discovered so far`,
        detail: {
          folderId: nextFolder.id,
          processedFolders: state.processedFolderIds.length + 1,
        },
      });

      state.processedFolderIds.push(folderKey);
      state.updatedAt = new Date().toISOString();
      await writeJsonFile(cachePath, state);
    }

    state.status = "completed";
    state.updatedAt = new Date().toISOString();
    await writeJsonFile(cachePath, state);

    options?.onActivity?.({
      stage: "discovery.frameio-public",
      level: "success",
      message: `Public share traversal finished with ${state.records.length} records`,
      detail: {
        folderCount: state.processedFolderIds.filter((id) => id !== "__ROOT__").length,
        cachePath,
      },
    });

    return {
      source,
      records: state.records.sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
      folderCount: state.processedFolderIds.filter((id) => id !== "__ROOT__").length,
      fileCount: state.records.length,
      cachePath,
      resumed,
      warnings: state.warnings,
    };
  } finally {
    await browser?.close();
  }
}

async function initializePublicShareSession(page: Page, sourceUrl: string): Promise<{
  resolvedUrl: string;
  shareId: string;
  headers: Record<string, string>;
}> {
  let capturedHeaders: Record<string, string> | undefined;
  page.on("request", (request) => {
    if (!capturedHeaders && request.url().includes("api.frame.io/graphql")) {
      capturedHeaders = request.headers();
    }
  });

  await page.goto(sourceUrl, {
    waitUntil: "networkidle",
    timeout: config.ai.requestTimeoutMs,
  });

  const resolvedUrl = page.url();
  const shareId = extractShareId(resolvedUrl);
  if (!shareId) {
    throw new Error("Could not resolve a public Frame.io share ID from the link.");
  }

  const headers = capturedHeaders ?? buildShareHeaders(shareId);
  return {
    resolvedUrl,
    shareId,
    headers: sanitizeGraphqlHeaders(headers, shareId),
  };
}

function extractShareId(url: string): string | null {
  const match = url.match(/\/share\/([0-9a-f-]+)/i);
  return match?.[1] ?? null;
}

function buildShareHeaders(shareId: string): Record<string, string> {
  return {
    accept: "*/*",
    "content-type": "application/json",
    referer: "https://next.frame.io/",
    "apollographql-client-name": "web-app",
    "apollographql-client-version": "@frameio/next-web-app@510.0",
    "x-frameio-share-authentication": Buffer.from(shareId).toString("base64"),
  };
}

function sanitizeGraphqlHeaders(headers: Record<string, string>, shareId: string): Record<string, string> {
  return {
    accept: headers.accept || "*/*",
    "content-type": "application/json",
    referer: headers.referer || "https://next.frame.io/",
    "user-agent": headers["user-agent"] || "Mozilla/5.0",
    "apollographql-client-name": headers["apollographql-client-name"] || "web-app",
    "apollographql-client-version": headers["apollographql-client-version"] || "@frameio/next-web-app@510.0",
    "x-frameio-share-authentication":
      headers["x-frameio-share-authentication"] || Buffer.from(shareId).toString("base64"),
    ...(headers["x-frameio-session-id"] ? { "x-frameio-session-id": headers["x-frameio-session-id"] } : {}),
    ...(headers["sec-ch-ua"] ? { "sec-ch-ua": headers["sec-ch-ua"] } : {}),
    ...(headers["sec-ch-ua-mobile"] ? { "sec-ch-ua-mobile": headers["sec-ch-ua-mobile"] } : {}),
    ...(headers["sec-ch-ua-platform"] ? { "sec-ch-ua-platform": headers["sec-ch-ua-platform"] } : {}),
  };
}

async function listAssets(
  page: Page,
  headers: Record<string, string>,
  shareId: string,
  folderId: string | undefined,
  assetType: "FILE" | "FOLDER",
): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;

  for (;;) {
    const response = await postGraphql<GraphCollectionResponse>(page, headers, {
      operationName: "GetShareCollectionAssets",
      query: listAssetsQuery,
      variables: {
        shareId,
        folderId,
        assetType,
        page: {
          first: 200,
          after,
        },
      },
    });

    const collection = response.data?.share?.collectionAssets;
    ids.push(...(collection?.nodes ?? []).map((node) => node.id));

    if (!collection?.pageInfo?.hasNextPage || !collection.pageInfo.endCursor) {
      break;
    }

    after = collection.pageInfo.endCursor;
  }

  return ids;
}

async function hydrateAssets(
  page: Page,
  headers: Record<string, string>,
  ids: string[],
): Promise<GraphAsset[]> {
  const response = await postGraphql<GraphAssetsResponse>(page, headers, {
    operationName: "HydrateAssets",
    query: hydrateAssetsQuery,
    variables: {
      ids,
    },
  });

  return response.data?.assets ?? [];
}

async function postGraphql<T>(
  page: Page,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await page.context().request.post("https://api.frame.io/graphql", {
    headers: {
      ...headers,
      "x-gql-op": String(body.operationName ?? "UnknownOperation"),
    },
    data: body,
    timeout: config.ai.requestTimeoutMs,
  });

  if (!response.ok()) {
    throw new Error(`Public Frame.io share query failed (${response.status()}).`);
  }

  return (await response.json()) as T;
}

function pickBestDownload(asset: GraphAsset) {
  const transcodes = asset.media?.videoTranscodes ?? [];
  return [...transcodes]
    .filter((entry) => entry.downloadUrl && entry.encodeStatus === "SUCCESS")
    .sort((left, right) => (right.filesizeInBytes ?? 0) - (left.filesizeInBytes ?? 0))[0];
}
