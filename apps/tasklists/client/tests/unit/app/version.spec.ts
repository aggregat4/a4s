import test from "node:test";
import assert from "node:assert/strict";
import { APP_VERSION, fetchServerVersion } from "../../../src/app/version.js";

test("client version falls back to dev when not injected at build time", () => {
  assert.equal(APP_VERSION, "dev");
});

test("fetchServerVersion returns the reported service version", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ version: "v1.2.3" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    assert.equal(await fetchServerVersion(), "v1.2.3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchServerVersion returns null for non-ok responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("unauthorized", { status: 401 })) as typeof fetch;
  try {
    assert.equal(await fetchServerVersion(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchServerVersion returns null when the request throws", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network unavailable");
  }) as typeof fetch;
  try {
    assert.equal(await fetchServerVersion(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
