import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../config.js";
import type { ActivityLogger } from "./activity-log.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(process.cwd(), "..");
const requirementsPath = path.join(repoRoot, "scripts", "reference_media_requirements.txt");
const scriptPath = path.join(repoRoot, "scripts", "reference_media_pipeline.py");
const runtimeRoot = path.join(config.dataDir, "cache", "reference-runtime");
export const venvRoot = path.join(runtimeRoot, ".venv");
const installStampPath = path.join(runtimeRoot, "install-stamp.json");

export interface ReferenceTranscriptItem {
  id: string;
  referenceUrl: string;
  title: string;
  context: string;
  sourceText: string;
  mediaPath?: string | null;
  transcriptPath?: string | null;
  transcriptText: string;
  downloadStatus: "downloaded" | "cached" | "failed";
  transcriptStatus: "transcribed" | "cached" | "failed";
  failureMessage?: string | null;
}

export interface ReferenceMediaPipelineResult {
  summary: {
    total: number;
    downloaded: number;
    cachedMedia: number;
    transcribed: number;
    cachedTranscripts: number;
    failed: number;
  };
  references: ReferenceTranscriptItem[];
}

export async function prepareReferenceMedia(params: {
  requestId: string;
  text: string;
  forceRefresh?: boolean;
  onActivity?: ActivityLogger;
}): Promise<ReferenceMediaPipelineResult> {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const pythonExe = await ensureReferencePythonEnvironment(params.onActivity);
  const inputPath = path.join(runtimeRoot, `${params.requestId}.json`);
  const mediaCacheDir = path.join(config.dataDir, "cache", "reference-media");
  const transcriptCacheDir = path.join(config.dataDir, "cache", "reference-transcripts");

  await fs.mkdir(mediaCacheDir, { recursive: true });
  await fs.mkdir(transcriptCacheDir, { recursive: true });

  const payload = {
    requestId: params.requestId,
    text: params.text,
    forceRefresh: params.forceRefresh === true,
    model: config.reference.whisperModel,
    maxItems: config.reference.maxReferencesPerRun,
    mediaCacheDir,
    transcriptCacheDir,
  };
  await fs.writeFile(inputPath, JSON.stringify(payload), "utf8");

  params.onActivity?.({
    stage: "reference.prepare",
    message: `Preparing reference media pipeline for up to ${config.reference.maxReferencesPerRun} items`,
    detail: {
      whisperModel: config.reference.whisperModel,
    },
  });

  try {
    const { stdout, stderr } = await execFileAsync(
      pythonExe,
      [scriptPath, "--input-json", inputPath],
      {
        timeout: config.reference.pipelineTimeoutMs,
        maxBuffer: 25 * 1024 * 1024,
      },
    );

    if (!stdout.trim()) {
      throw new Error(stderr.trim() || "Reference media pipeline returned no output.");
    }

    const result = JSON.parse(stdout) as ReferenceMediaPipelineResult;
    params.onActivity?.({
      stage: "reference.prepare",
      level: result.summary.failed > 0 ? "warning" : "success",
      message: `Reference pipeline prepared ${result.summary.total} items`,
      detail: result.summary,
    });
    return result;
  } catch (error) {
    const details = error as Error & { stdout?: string; stderr?: string };
    const message = [
      error instanceof Error ? error.message : String(error),
      details.stderr?.trim(),
      details.stdout?.trim(),
    ]
      .filter(Boolean)
      .join(" | ");
    throw new Error(`Reference media pipeline failed: ${message}`);
  } finally {
    await fs.rm(inputPath, { force: true });
  }
}

export async function ensureReferencePythonEnvironment(onActivity?: ActivityLogger): Promise<string> {
  const pythonBase = await resolvePythonBase();
  const venvPython = path.join(venvRoot, "Scripts", "python.exe");
  const requirementsContent = await fs.readFile(requirementsPath, "utf8");
  const requirementsHash = hashText(requirementsContent);
  const installStamp = await readInstallStamp();

  if (!(await pathExists(venvPython))) {
    onActivity?.({
      stage: "reference.env",
      message: "Creating repo-local Python environment for reference processing",
    });
    await execFileAsync(pythonBase, ["-m", "venv", venvRoot], {
      timeout: 10 * 60 * 1000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  if (installStamp?.requirementsHash !== requirementsHash) {
    onActivity?.({
      stage: "reference.env",
      message: "Installing Python dependencies for reference download and transcription",
    });
    await execFileAsync(venvPython, ["-m", "pip", "install", "--upgrade", "pip"], {
      timeout: 15 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    await execFileAsync(venvPython, ["-m", "pip", "install", "-r", requirementsPath], {
      timeout: 60 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
    await fs.writeFile(
      installStampPath,
      JSON.stringify(
        {
          requirementsHash,
          pythonBase,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return venvPython;
}

async function resolvePythonBase(): Promise<string> {
  const candidates = [
    { command: "py", args: ["-3.12", "-c", "import sys; print(sys.executable)"] },
    { command: "python", args: ["-c", "import sys; print(sys.executable)"] },
  ];

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, {
        timeout: 20_000,
        maxBuffer: 512 * 1024,
      });
      const executable = stdout.trim();
      if (executable) {
        return executable;
      }
    } catch {
      continue;
    }
  }

  throw new Error("Python 3.12+ is required for local reference transcription.");
}

async function readInstallStamp(): Promise<{ requirementsHash: string } | null> {
  try {
    const raw = await fs.readFile(installStampPath, "utf8");
    return JSON.parse(raw) as { requirementsHash: string };
  } catch {
    return null;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function hashText(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
