import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../config.js";
import type { MediaRecord } from "../models.js";
import { extractJsonObject, extractKeywords, extractReferenceLinks, matchTranscriptToRecords, pickReferenceUrl } from "./ai-matching.js";

test("extractJsonObject supports fenced json blocks", () => {
  const raw = '```json\n{"matches":[{"recordId":"abc"}]}\n```';
  assert.equal(extractJsonObject(raw), '{"matches":[{"recordId":"abc"}]}');
});

test("extractJsonObject supports plain wrapped output", () => {
  const raw = 'Model output:\n{"matches":[{"recordId":"abc"}],"notes":["ok"]}\nDone.';
  assert.equal(
    extractJsonObject(raw),
    '{"matches":[{"recordId":"abc"}],"notes":["ok"]}',
  );
});

test("extractKeywords ignores url tokens and ranking boilerplate", () => {
  const keywords = extractKeywords(`
    https://www.youtube.com/shorts/example123
    YOUTUBE SHORTS - RANKED BY VIEWS (highest first)
    How banks actually make money in 3 ways
  `);

  assert.equal(keywords.includes("https"), false);
  assert.equal(keywords.includes("youtube"), false);
  assert.equal(keywords.includes("ranked"), false);
  assert.deepEqual(keywords.slice(0, 5), ["how", "banks", "actually", "make", "money"]);
});

test("extractReferenceLinks keeps the whole numbered item context around a short url", () => {
  const references = extractReferenceLinks(`
    1. Multi-Million Dollar CEO explains why 8hr sleep is important @SlashFinancial
    https://www.youtube.com/shorts/sleep123

    2. Kanye West Accidentally Made This Founder a Millionaire
    https://www.youtube.com/shorts/kanye456
  `);

  assert.equal(references.length, 2);
  assert.equal(references[0]?.url, "https://www.youtube.com/shorts/sleep123");
  assert.match(references[0]?.context ?? "", /8hr sleep/i);
  assert.match(references[1]?.context ?? "", /Kanye West/i);
});

test("pickReferenceUrl selects the short link whose title matches the raw folder context", () => {
  const referenceUrl = pickReferenceUrl(
    {
      record: buildRecord(
        "sleep-raw",
        "13.mp4",
        "A. Start Here/$370M CEO: I Sleep 8 Hours Daily/13.mp4",
        {
          sourceKind: "frameio",
          sourceLink: "https://next.frame.io/share/example/",
        },
      ),
      heuristicScore: 18,
      matchedTerms: ["CEO", "8hr", "sleep", "8 Hours Daily"],
      directLink: undefined,
      sourceLink: "https://next.frame.io/share/example/",
    },
    extractReferenceLinks(`
      1. Multi-Million Dollar CEO explains why 8hr sleep is important @SlashFinancial
      https://www.youtube.com/shorts/sleep123

      2. Kanye West Accidentally Made This Founder a Millionaire
      https://www.youtube.com/shorts/kanye456
    `),
  );

  assert.equal(referenceUrl, "https://www.youtube.com/shorts/sleep123");
});

test("pickReferenceUrl can use transcript evidence when the raw filename is generic", () => {
  const referenceUrl = pickReferenceUrl(
    {
      record: buildRecord(
        "generic-raw",
        "13.mp4",
        "A. Start Here/Generic Folder/13.mp4",
        {
          sourceKind: "frameio",
          sourceLink: "https://next.frame.io/share/example/",
        },
      ),
      heuristicScore: 11,
      matchedTerms: ["ceo"],
      directLink: undefined,
      sourceLink: "https://next.frame.io/share/example/",
    },
    extractReferenceLinks(`
      1. Multi-Million Dollar CEO explains why 8hr sleep is important @SlashFinancial
      https://www.youtube.com/shorts/sleep123

      2. Kanye West Accidentally Made This Founder a Millionaire
      https://www.youtube.com/shorts/kanye456
    `),
    "Multi-Million Dollar CEO explains why 8hr sleep is important @SlashFinancial",
  );

  assert.equal(referenceUrl, "https://www.youtube.com/shorts/sleep123");
});

test("matchTranscriptToRecords sends think false and uses Ollama JSON response", async () => {
  const originalFetch = globalThis.fetch;
  const seenBodies: string[] = [];
  let generateCalls = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return jsonResponse({
        models: [{ name: "qwen3.5:latest" }],
      });
    }

    if (url.endsWith("/api/generate")) {
      const body = String(init?.body ?? "");
      seenBodies.push(body);
      generateCalls += 1;

      if (generateCalls === 1) {
        return jsonResponse({ response: "OK" });
      }

      return jsonResponse({
        response:
          '{"matches":[{"recordId":"alpha","confidence":0.92,"rationale":"name match","matchedTerms":["money"]}],"notes":["ok"]}',
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await matchTranscriptToRecords({
      transcript: "How to make money fast",
      records: [buildRecord("alpha", "How to make money.mp4", "A/How to make money.mp4")],
      rankingTerms: [],
      providerPreference: "ollama",
      modelPreference: "qwen3.5:latest",
    });

    assert.equal(result.status, "used");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.recordId, "alpha");

    const requestBody = JSON.parse(seenBodies[1] ?? "{}") as { think?: boolean };
    assert.equal(requestBody.think, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matchTranscriptToRecords dedupes fallback candidates by logical file path", async () => {
  const originalFetch = globalThis.fetch;
  let generateCalls = 0;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return jsonResponse({
        models: [{ name: "qwen3.5:latest" }],
      });
    }

    if (url.endsWith("/api/generate")) {
      generateCalls += 1;
      if (generateCalls === 1) {
        return jsonResponse({ response: "OK" });
      }

      throw new Error("fetch failed");
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await matchTranscriptToRecords({
      transcript: "how banks make money",
      referenceText: "https://youtube.com/shorts/example",
      records: [
        buildRecord("older", "14.mp4", "A/How Banks Actually Make Money/14.mp4", {
          size: 10,
          updatedAt: "2026-03-01T00:00:00.000Z",
          sourceLink: "https://next.frame.io/share/example/",
          sourceKind: "frameio",
        }),
        buildRecord("newer", "14.mp4", "A/How Banks Actually Make Money/14.mp4", {
          size: 20,
          updatedAt: "2026-03-02T00:00:00.000Z",
          sourceLink: "https://next.frame.io/share/example/",
          sourceKind: "frameio",
        }),
      ],
      rankingTerms: [],
      providerPreference: "ollama",
      modelPreference: "qwen3.5:latest",
      maxMatches: 8,
    });

    assert.equal(result.status, "fallback");
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.recordId, "newer");
    assert.equal(result.matches[0]?.referenceUrl, undefined);
    assert.match(result.notes[0] ?? "", /Ollama request for qwen3\.5:latest failed: fetch failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("matchTranscriptToRecords sends OpenRouter auth and chat payload", async () => {
  const originalFetch = globalThis.fetch;
  const restoreConfig = withAiConfig({
    geminiCliCommand: "missing-openrouter-gemini",
    nvidiaApiKey: "",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    openRouterApiKey: "openrouter-key",
    defaultOpenRouterModel: "openrouter/auto",
  });
  const seenRequests: Array<{ url: string; headers: HeadersInit | undefined; body: string }> = [];

  globalThis.fetch = (async (input, init) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return errorResponse(503, { models: [] });
    }

    if (url.endsWith("/models")) {
      return jsonResponse({
        data: [{ id: "openrouter/sonoma" }],
      });
    }

    if (url.endsWith("/chat/completions")) {
      seenRequests.push({
        url,
        headers: init?.headers,
        body: String(init?.body ?? ""),
      });

      return jsonResponse({
        choices: [
          {
            message: {
              content:
                '{"matches":[{"recordId":"alpha","confidence":0.91,"rationale":"name match","matchedTerms":["money"]}],"notes":["ok"]}',
            },
          },
        ],
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await matchTranscriptToRecords({
      transcript: "How to make money fast",
      records: [buildRecord("alpha", "How to make money.mp4", "A/How to make money.mp4")],
      rankingTerms: [],
      providerPreference: "openrouter",
      modelPreference: "openrouter/sonoma",
    });

    assert.equal(result.provider, "openrouter");
    assert.equal(result.status, "used");
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0]?.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(getHeaderValue(seenRequests[0]?.headers, "authorization"), "Bearer openrouter-key");
    assert.equal(getHeaderValue(seenRequests[0]?.headers, "content-type"), "application/json");

    const requestBody = JSON.parse(seenRequests[0]?.body ?? "{}") as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
    };
    assert.equal(requestBody.model, "openrouter/sonoma");
    assert.equal(requestBody.messages?.[0]?.role, "user");
    assert.match(requestBody.messages?.[0]?.content ?? "", /make money/i);
  } finally {
    globalThis.fetch = originalFetch;
    restoreConfig();
  }
});

test("matchTranscriptToRecords auto-selects OpenRouter when it is the default available provider", async () => {
  const originalFetch = globalThis.fetch;
  const restoreConfig = withAiConfig({
    defaultProvider: "openrouter",
    geminiCliCommand: "missing-openrouter-gemini",
    nvidiaApiKey: "",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    openRouterApiKey: "openrouter-key",
    defaultOpenRouterModel: "openrouter/auto",
  });
  const seenUrls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    seenUrls.push(url);

    if (url.endsWith("/api/tags")) {
      return errorResponse(503, { models: [] });
    }

    if (url.endsWith("/models")) {
      return jsonResponse({
        data: [{ id: "openrouter/auto" }],
      });
    }

    if (url.endsWith("/chat/completions")) {
      return jsonResponse({
        choices: [
          {
            message: {
              content:
                '{"matches":[{"recordId":"alpha","confidence":0.88,"rationale":"name match","matchedTerms":["money"]}],"notes":["ok"]}',
            },
          },
        ],
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    const result = await matchTranscriptToRecords({
      transcript: "How to make money fast",
      records: [buildRecord("alpha", "How to make money.mp4", "A/How to make money.mp4")],
      rankingTerms: [],
      providerPreference: "auto",
    });

    assert.equal(result.provider, "openrouter");
    assert.equal(result.status, "used");
    assert.equal(seenUrls.includes("https://openrouter.ai/api/v1/chat/completions"), true);
  } finally {
    globalThis.fetch = originalFetch;
    restoreConfig();
  }
});

test("matchTranscriptToRecords rejects explicit OpenRouter requests when auth is missing", async () => {
  const originalFetch = globalThis.fetch;
  const restoreConfig = withAiConfig({
    geminiCliCommand: "missing-openrouter-gemini",
    nvidiaApiKey: "",
    openRouterApiKey: "",
  });

  globalThis.fetch = (async (input) => {
    const url = String(input);

    if (url.endsWith("/api/tags")) {
      return errorResponse(503, { models: [] });
    }

    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => matchTranscriptToRecords({
        transcript: "How to make money fast",
        records: [buildRecord("alpha", "How to make money.mp4", "A/How to make money.mp4")],
        rankingTerms: [],
        providerPreference: "openrouter",
      }),
      /OpenRouter.*not available/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreConfig();
  }
});

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

function errorResponse(status: number, payload: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as Response;
}

function getHeaderValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return entry?.[1];
  }

  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

type AiConfigWithOpenRouter = typeof config.ai & {
  defaultProvider: typeof config.ai.defaultProvider | "openrouter";
  openRouterBaseUrl: string;
  openRouterApiKey: string;
  defaultOpenRouterModel: string;
};

function withAiConfig(overrides: Partial<AiConfigWithOpenRouter>): () => void {
  const ai = config.ai as AiConfigWithOpenRouter;
  const snapshot = {
    defaultProvider: ai.defaultProvider,
    geminiCliCommand: ai.geminiCliCommand,
    nvidiaApiKey: ai.nvidiaApiKey,
    openRouterBaseUrl: ai.openRouterBaseUrl,
    openRouterApiKey: ai.openRouterApiKey,
    defaultOpenRouterModel: ai.defaultOpenRouterModel,
  };

  Object.assign(ai, overrides);

  return () => {
    ai.defaultProvider = snapshot.defaultProvider;
    ai.geminiCliCommand = snapshot.geminiCliCommand;
    ai.nvidiaApiKey = snapshot.nvidiaApiKey;
    ai.openRouterBaseUrl = snapshot.openRouterBaseUrl;
    ai.openRouterApiKey = snapshot.openRouterApiKey;
    ai.defaultOpenRouterModel = snapshot.defaultOpenRouterModel;
  };
}
