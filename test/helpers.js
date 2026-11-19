// Shared test helpers: a fake NUVC API (global fetch stub) that records every upstream call.
import { camel } from "../lib/tools.js";

export const KEY_A = "nuvc_test_key_alice";
export const KEY_B = "nuvc_test_key_bob";

/** Deep-camelCase object keys the way ResponseStandardizationMiddleware does. */
export function camelKeys(v) {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]));
  }
  return v;
}

/**
 * Install a fetch stub for https://api.nuvc.ai/*. `respond(call)` returns the JSON body (or a
 * {status, body}). Requests to anything else (the test's own local server) go to real fetch.
 * Returns { calls, restore }.
 */
export function stubApi(respond) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://api.nuvc.ai/")) return realFetch(url, init);
    const call = {
      method: init.method,
      path: u.replace("https://api.nuvc.ai/api/v3", ""),
      key: (init.headers?.Authorization || "").replace(/^Bearer /, ""),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const out = (await respond(call)) ?? {};
    const status = out.status ?? 200;
    return new Response(JSON.stringify(out.body ?? out), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, restore: () => (globalThis.fetch = realFetch) };
}

/** The exact tool list nuvc-mcp 2.0 advertises (sorted). Changing it is a contract change. */
export const INVESTOR_TOOL_NAMES = [
  "nuvc_analyze",
  "nuvc_billing",
  "nuvc_deal_brief",
  "nuvc_extract",
  "nuvc_fund_economics",
  "nuvc_get_mandate",
  "nuvc_match_investors",
  "nuvc_models",
  "nuvc_my_deals",
  "nuvc_precedent",
  "nuvc_score",
  "nuvc_screen_fund",
  "nuvc_set_mandate",
  "nuvc_venture_math",
];
