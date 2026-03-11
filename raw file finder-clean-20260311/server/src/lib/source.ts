import { stableHash } from "./hash.js";
import type { SourceDescriptor, SourceRequest } from "../models.js";

export function isFrameIoUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)frame\.io$/i.test(url.hostname) || /(^|\.)f\.io$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function isPublicFrameIoShareUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase() === "f.io" ||
      /(^|\.)frame\.io$/i.test(url.hostname) && /\/share\//i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function detectSource(request: SourceRequest): SourceDescriptor {
  const localPath = request.localPath?.trim();
  const frameioLink = request.frameioLink?.trim();

  if (localPath && frameioLink) {
    throw new Error("Provide either a local archive path or a Frame.io link, not both.");
  }

  if (frameioLink) {
    if (!isFrameIoUrl(frameioLink)) {
      throw new Error("Frame.io input must be a valid Frame.io or f.io URL.");
    }

    return {
      kind: "frameio",
      input: frameioLink,
      cacheKey: stableHash(`frameio:${frameioLink}`),
    };
  }

  if (localPath) {
    return {
      kind: "local",
      input: localPath,
      cacheKey: stableHash(`local:${localPath}`),
    };
  }

  throw new Error("A local archive path or Frame.io link is required.");
}
