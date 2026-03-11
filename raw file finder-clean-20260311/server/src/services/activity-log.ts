import type { Response } from "express";

export type ActivityLogLevel = "info" | "success" | "warning" | "error";

export interface ActivityLogEntry {
  id: string;
  requestId: string;
  timestamp: string;
  stage: string;
  level: ActivityLogLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export interface ActivityLogEvent {
  stage: string;
  level?: ActivityLogLevel;
  message: string;
  detail?: Record<string, unknown>;
}

export type ActivityLogger = (event: ActivityLogEvent) => void;

const MAX_ENTRIES_PER_REQUEST = 250;
const HEARTBEAT_MS = 15_000;

const entriesByRequestId = new Map<string, ActivityLogEntry[]>();
const subscribersByRequestId = new Map<string, Set<(entry: ActivityLogEntry) => void>>();

export function createActivityLogger(requestId: string): ActivityLogger {
  return (event) => {
    appendActivityLog(requestId, event);
  };
}

export function clearActivityLog(requestId: string): void {
  entriesByRequestId.delete(requestId);
}

export function appendActivityLog(requestId: string, event: ActivityLogEvent): ActivityLogEntry {
  const entry: ActivityLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    requestId,
    timestamp: new Date().toISOString(),
    stage: event.stage,
    level: event.level ?? "info",
    message: event.message,
    detail: event.detail,
  };

  const existing = entriesByRequestId.get(requestId) ?? [];
  existing.push(entry);
  if (existing.length > MAX_ENTRIES_PER_REQUEST) {
    existing.splice(0, existing.length - MAX_ENTRIES_PER_REQUEST);
  }
  entriesByRequestId.set(requestId, existing);

  const subscribers = subscribersByRequestId.get(requestId);
  if (subscribers) {
    for (const subscriber of subscribers) {
      subscriber(entry);
    }
  }

  return entry;
}

export function listActivityLogEntries(requestId: string): ActivityLogEntry[] {
  return [...(entriesByRequestId.get(requestId) ?? [])];
}

export function streamActivityLog(requestId: string, response: Response): () => void {
  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.write("retry: 2000\n\n");

  const writeEntry = (entry: ActivityLogEntry) => {
    response.write(`event: activity\n`);
    response.write(`data: ${JSON.stringify(entry)}\n\n`);
  };

  for (const entry of listActivityLogEntries(requestId)) {
    writeEntry(entry);
  }

  const subscribers = subscribersByRequestId.get(requestId) ?? new Set<(entry: ActivityLogEntry) => void>();
  subscribers.add(writeEntry);
  subscribersByRequestId.set(requestId, subscribers);

  const heartbeat = setInterval(() => {
    response.write(": keep-alive\n\n");
  }, HEARTBEAT_MS);

  return () => {
    clearInterval(heartbeat);
    const currentSubscribers = subscribersByRequestId.get(requestId);
    if (!currentSubscribers) {
      return;
    }

    currentSubscribers.delete(writeEntry);
    if (currentSubscribers.size === 0) {
      subscribersByRequestId.delete(requestId);
    }
  };
}
