import assert from "node:assert/strict";
import test from "node:test";
import { buildHeaders } from "./frameio-source.js";

test("buildHeaders applies request-scoped Frame.io auth", () => {
  const headers = buildHeaders({
    bearerToken: "override-token",
    sessionCookie: "frameio_session=abc123",
  }) as Record<string, string>;

  assert.equal(headers.accept, "application/json");
  assert.equal(headers.authorization, "Bearer override-token");
  assert.equal(headers.cookie, "frameio_session=abc123");
});
