import assert from "node:assert/strict";
import test from "node:test";
import type { MediaRecord } from "../models.js";
import { matchReferencesToRecords } from "./reference-matching.js";
import type { ReferenceMediaPipelineResult } from "./reference-media.js";

test("matchReferencesToRecords keeps separate reference clips even when they map to the same raw file", async () => {
  const originalFetch = globalThis.fetch;
  let generateResponses = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return jsonResponse({
        models: [{ name: "qwen3.5:latest" }],
      });
    }

    if (url.endsWith("/api/generate")) {
      const body = String(init?.body ?? "");
      if (body.includes('"prompt":"OK"')) {
        return jsonResponse({ response: "OK" });
      }

      generateResponses += 1;
      return jsonResponse({
        response: JSON.stringify({
          matches: [
            {
              recordId: "alpha",
              confidence: 0.95,
              rationale: `match ${generateResponses}`,
              matchedTerms: ["money"],
            },
          ],
          notes: ["ok"],
        }),
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await matchReferencesToRecords({
      references: buildReferenceResult(),
      records: [buildRecord("alpha", "clip_11.mp4", "A. Start Here/19-Year-Old? Learn AI Coding Now/clip_11.mp4")],
      rankingTerms: [],
      providerPreference: "ollama",
      modelPreference: "qwen3.5:latest",
    });

    assert.equal(result.status, "used");
    assert.equal(result.matches.length, 2);
    assert.equal(result.matches[0]?.recordId, "alpha");
    assert.equal(result.matches[1]?.recordId, "alpha");
    assert.equal(result.matches[0]?.referenceUrl, "https://www.youtube.com/shorts/ref-one");
    assert.equal(result.matches[1]?.referenceUrl, "https://www.youtube.com/shorts/ref-two");
    assert.match(result.notes[0] ?? "", /processed 2 shorts, matched 2, unresolved 0/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function buildReferenceResult(): ReferenceMediaPipelineResult {
  return {
    summary: {
      total: 2,
      downloaded: 2,
      cachedMedia: 0,
      transcribed: 2,
      cachedTranscripts: 0,
      failed: 0,
    },
    references: [
      {
        id: "ref-one",
        referenceUrl: "https://www.youtube.com/shorts/ref-one",
        title: "The fastest way to make $1m today",
        context: "Finance clip one",
        sourceText: "source one",
        mediaPath: null,
        transcriptPath: null,
        transcriptText: "The fastest way to make $1m today is to learn AI coding now.",
        downloadStatus: "downloaded",
        transcriptStatus: "transcribed",
        failureMessage: null,
      },
      {
        id: "ref-two",
        referenceUrl: "https://www.youtube.com/shorts/ref-two",
        title: "The fastest way to make your first $1M",
        context: "Finance clip two",
        sourceText: "source two",
        mediaPath: null,
        transcriptPath: null,
        transcriptText: "The fastest way to make your first $1M is also to learn AI coding now.",
        downloadStatus: "downloaded",
        transcriptStatus: "transcribed",
        failureMessage: null,
      },
    ],
  };
}

function buildRecord(
  id: string,
  name: string,
  relativePath: string,
  overrides: Partial<MediaRecord> = {},
): MediaRecord {
  return {
    id,
    name,
    relativePath,
    sourcePath: overrides.sourcePath ?? relativePath,
    sourceLink: overrides.sourceLink,
    sourceKind: overrides.sourceKind ?? "local",
    mediaType: overrides.mediaType ?? "video/mp4",
    extension: overrides.extension ?? ".mp4",
    size: overrides.size,
    updatedAt: overrides.updatedAt,
    createdAt: overrides.createdAt,
    durationSeconds: overrides.durationSeconds,
    downloadUrl: overrides.downloadUrl,
    folderId: overrides.folderId,
    metadata: overrides.metadata ?? {},
  };
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}
