import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DiscoveryResult, MediaRecord, SourceDescriptor } from "../models.js";
import type { ActivityLogger } from "./activity-log.js";

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".mxf",
  ".m4v",
  ".avi",
  ".mkv",
  ".wmv",
  ".webm",
]);

const pathSchema = z.string().min(1);

export async function discoverLocalArchive(
  source: SourceDescriptor,
  options?: { onActivity?: ActivityLogger },
): Promise<DiscoveryResult> {
  const rootPath = pathSchema.parse(source.input);
  const rootStats = await fs.stat(rootPath).catch(() => {
    throw new Error(`Local archive path does not exist: ${rootPath}`);
  });

  if (!rootStats.isDirectory()) {
    throw new Error(`Local archive path is not a directory: ${rootPath}`);
  }

  const records: MediaRecord[] = [];
  let folderCount = 0;
  options?.onActivity?.({
    stage: "discovery.local",
    message: `Scanning local archive at ${rootPath}`,
  });

  async function walk(dirPath: string): Promise<void> {
    folderCount += 1;
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!VIDEO_EXTENSIONS.has(extension)) {
        continue;
      }

      const stats = await fs.stat(fullPath);
      const relativePath = path.relative(rootPath, fullPath);
      records.push({
        id: `${source.cacheKey}:${relativePath}`,
        name: entry.name,
        relativePath,
        sourcePath: fullPath,
        sourceLink: `file:///${fullPath.replace(/\\/g, "/")}`,
        sourceKind: "local",
        mediaType: extension.replace(".", ""),
        extension,
        size: stats.size,
        updatedAt: stats.mtime.toISOString(),
        createdAt: stats.birthtime.toISOString(),
        metadata: {},
      });

      if (records.length % 25 === 0) {
        options?.onActivity?.({
          stage: "discovery.local",
          message: `Indexed ${records.length} local media files`,
          detail: {
            folderCount,
            latestPath: relativePath,
          },
        });
      }
    }
  }

  await walk(rootPath);

  options?.onActivity?.({
    stage: "discovery.local",
    level: "success",
    message: `Finished local scan with ${records.length} media files`,
    detail: {
      folderCount,
    },
  });

  return {
    source,
    records,
    folderCount,
    fileCount: records.length,
    resumed: false,
    warnings: [],
  };
}
