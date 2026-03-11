import path from "node:path";
import Fuse from "fuse.js";
import { config } from "../config.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import type {
  DiscoveryResult,
  IndexState,
  MatchingResult,
  MediaRecord,
  RankingTerm,
  SearchResult,
  SourceDescriptor,
} from "../models.js";
import { computeRankingBoost } from "./ranking.js";

function buildSearchText(record: MediaRecord): string {
  return [
    record.name,
    record.relativePath,
    record.sourcePath,
    record.mediaType,
    JSON.stringify(record.metadata),
  ]
    .filter(Boolean)
    .join(" ");
}

export async function persistIndex(
  source: SourceDescriptor,
  discovery: DiscoveryResult,
  rankingTerms: RankingTerm[],
  transcript: { fileName?: string; textLength: number },
  matching?: MatchingResult,
  references?: IndexState["references"],
): Promise<IndexState> {
  const indexState: IndexState = {
    id: source.cacheKey,
    source,
    createdAt: new Date().toISOString(),
    rankingTerms,
    transcript,
    references,
    matching,
    documents: discovery.records.map((record) => ({
      record,
      searchText: buildSearchText(record),
    })),
    summary: {
      fileCount: discovery.fileCount,
      folderCount: discovery.folderCount,
      indexedAt: new Date().toISOString(),
      matchedCount: matching?.matches.length ?? 0,
    },
  };

  await writeJsonFile(getIndexPath(source.cacheKey), indexState);
  return indexState;
}

export async function loadIndex(jobId: string): Promise<IndexState | null> {
  return readJsonFile<IndexState>(getIndexPath(jobId));
}

export async function searchIndex(jobId: string, query: string): Promise<SearchResult[]> {
  const indexState = await loadIndex(jobId);
  if (!indexState) {
    throw new Error(`Index not found for job ${jobId}.`);
  }

  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return indexState.documents.slice(0, 100).map((document) => ({
      score: 1,
      rankingBoost: 0,
      record: document.record,
    }));
  }

  const fuse = new Fuse(indexState.documents, {
    includeScore: true,
    threshold: 0.35,
    ignoreLocation: true,
    keys: [
      { name: "record.name", weight: 0.45 },
      { name: "record.relativePath", weight: 0.3 },
      { name: "searchText", weight: 0.25 },
    ],
  });

  return fuse
    .search(normalizedQuery, { limit: 100 })
    .map((entry) => {
      const rankingBoost = computeRankingBoost(entry.item.searchText, indexState.rankingTerms);
      const baseScore = 1 - (entry.score ?? 0);
      return {
        score: baseScore + rankingBoost,
        rankingBoost,
        record: entry.item.record,
      };
    })
    .sort((left, right) => right.score - left.score);
}

function getIndexPath(jobId: string): string {
  return path.join(config.dataDir, "indexes", `${jobId}.json`);
}
