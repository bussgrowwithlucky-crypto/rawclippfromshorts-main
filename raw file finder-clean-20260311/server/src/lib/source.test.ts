import assert from "node:assert/strict";
import test from "node:test";
import { detectSource, isFrameIoUrl, isPublicFrameIoShareUrl } from "./source.js";

test("isFrameIoUrl detects Frame.io domains", () => {
  assert.equal(isFrameIoUrl("https://app.frame.io/projects/123"), true);
  assert.equal(isFrameIoUrl("https://f.io/s/abc"), true);
  assert.equal(isFrameIoUrl("https://example.com/frame.io"), false);
});

test("detectSource chooses local path when present", () => {
  const source = detectSource({ localPath: "D:\\archive" });
  assert.equal(source.kind, "local");
});

test("detectSource chooses frameio url when present", () => {
  const source = detectSource({ frameioLink: "https://app.frame.io/folders/12345678" });
  assert.equal(source.kind, "frameio");
});

test("isPublicFrameIoShareUrl detects public share URLs", () => {
  assert.equal(isPublicFrameIoShareUrl("https://next.frame.io/share/17cf2164-6f5c-46d3-9674-034c10a7adb1/"), true);
  assert.equal(isPublicFrameIoShareUrl("https://f.io/abc123"), true);
  assert.equal(isPublicFrameIoShareUrl("https://app.frame.io/projects/123"), false);
});
