import { test } from "node:test";
import assert from "node:assert/strict";
import { createHandlers, createApiCall } from "../lib/tools.js";
import { stubApi, KEY_A } from "./helpers.js";
import * as F from "./fixtures.js";

test("score suggests evidence review without triggering further paid actions", async () => {
  const api = stubApi(() => F.SCORE);
  try {
    const out = await createHandlers(KEY_A).nuvc_score({ text: "Pitch evidence" });
    assert.match(out, /Next: identify the evidence/);
    assert.match(out, /You retain the investment decision/);
    assert.equal(api.calls.length, 1);
  } finally { api.restore(); }
});

test("an empty co-investor search does not invite automatic paid retries", async () => {
  const api = stubApi(() => ({ data: { matches: [] } }));
  try {
    const out = await createHandlers(KEY_A).nuvc_match_investors({ text: "Pitch evidence" });
    assert.match(out, /Another search uses a credit; do not retry automatically/);
    assert.equal(api.calls.length, 1);
  } finally { api.restore(); }
});

test("transient rate limiting suggests patience, never purchasing a pack", async () => {
  const api = stubApi(() => ({ status: 429, body: { detail: "slow down" } }));
  try {
    await assert.rejects(createHandlers(KEY_A).nuvc_score({ text: "Pitch" }), (err) => {
      assert.match(err.message, /Wait a moment/);
      assert.doesNotMatch(err.message, /buy|billing|pack|upgrade/i);
      return true;
    });
    assert.equal(api.calls.length, 1);
  } finally { api.restore(); }
});

test("rate limit respects bounded Retry-After seconds without echoing arbitrary header text", async () => {
  const real = globalThis.fetch;
  try {
    for (const [header, expected] of [["45", /at least 45 seconds/], ["secret arbitrary text", /Wait a moment/]]) {
      globalThis.fetch = async () => new Response("{}", { status: 429, headers: { "Retry-After": header } });
      await assert.rejects(createApiCall(KEY_A)("GET", "/ai/models"), (err) => {
        assert.match(err.message, expected);
        assert.doesNotMatch(err.message, /secret/);
        return true;
      });
    }
  } finally { globalThis.fetch = real; }
});
