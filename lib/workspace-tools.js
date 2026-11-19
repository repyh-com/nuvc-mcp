// Investor-workspace read tools: the key owner's own deal library, a deal's
// decision brief, and their own decision precedent. Read-only: no tool here writes, previews or
// applies anything.
//
// Wire format: unlike the /ai/* routes the rest of this package calls, /vc/* is NOT exempt from the
// response middleware, so bodies arrive wrapped as {success, data, message} with camelCased keys.
// Every response is unwrapped, converted to snake_case, then passed through an allow-list (`pick`),
// so only reviewed fields reach the assistant.
//
// Kept out of lib/tools.js on purpose: the backend contract test pins every
// top-level `handle*` in tools.js to a backend producer, and these routes are not pinned there yet.

import { OwnDataError, assertDeckId, assertNoForeignIdentityArgs, pick, withUntrustedNotice } from "./own-data.js";

const SOURCES = ["upload", "screened", "nuvc", "portfolio"];
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 50;

export const NOT_ENABLED = "This feature isn't enabled for your account yet.";
export const NO_ACCESS =
  "Your NUVC key does not have access to the investor workspace. Use a key from an onboarded VC account " +
  "(https://nuvc.ai/api-platform/keys).";
export const FAMILY_OFFICE_REFUSAL =
  "These pipeline tools read the venture pipeline, which family office accounts do not have. " +
  "Your fund screening and fund economics tools still work.";
export const RATE_LIMITED = "Rate limit reached. Wait a moment and retry.";
export const NO_PRECEDENT = "Fewer than 3 similar decisions on record, so there is no precedent to show yet.";

// ---------------------------------------------------------------------------
// Response allow-lists (snake_case, the documented wire format)
// ---------------------------------------------------------------------------

const DEAL_ITEM = {
  deck_id: true,
  evaluation_id: true,
  source: true,
  company: true,
  stage: true,
  score: { value: true, scale: true, lens_adjusted: true, label: true },
  founder: { name: true, credential: true },
  contact_state: true,
  contact: { email: true, linkedin_url: true },
  last_activity: true,
  also_portfolio: true,
};

const DEAL_LIBRARY = {
  items: [DEAL_ITEM],
  total: true,
  page: true,
  limit: true,
  has_more: true,
  truncated: true,
  partial: true,
  counts_by_source: { "*": true },
};

const PRECEDENT = {
  available: true,
  reason: true,
  n: true,
  decision_counts: { "*": true },
  top_reasons: [{ id: true, label: true, count: true }],
  items: [
    {
      deck_id: true,
      company_name: true,
      decision: true,
      reasons: [true],
      score_at_decision: true,
      decided_at: true,
    },
  ],
  basis: true,
};

const BRIEF = {
  verdict: {
    available: true,
    reason: true,
    sentence: true,
    action: true,
    score: true,
    confidence_label: true,
    basis: true,
  },
  signals: [{ text: true, source_key: true, polarity: true }],
  open_questions: [{ text: true, source_key: true }],
  precedent: PRECEDENT,
  thesis_fit: {
    available: true,
    reason: true,
    pct: true,
    confidence_label: true,
    aligned: [true],
    misaligned: [true],
  },
  comps: {
    available: true,
    reason: true,
    label: true,
    items: [
      { name: true, outcome: true, one_liner: true, founded_year: true, cohort_year: true, source_url: true },
    ],
  },
};

const PRECEDENT_RESPONSE = { precedent: PRECEDENT, reason: true };

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const WORKSPACE_TOOLS = [
  {
    name: "nuvc_my_deals",
    description:
      "List the deals in your own NUVC pipeline, read-only: company, where it came from (your uploads, deals you " +
      "screened, deals from NUVC, portfolio), stage, the 0-10 screening signal with its label, and whether founder " +
      "contact details are on file. Only your account's deals; nothing is changed.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: SOURCES, description: "Only deals from this source" },
        limit: { type: "number", description: `How many deals to return (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})` },
      },
    },
  },
  {
    name: "nuvc_deal_brief",
    description:
      "The one-screen decision brief for a deal in your pipeline, read-only: the screening signal with its " +
      "confidence and a suggested next step, up to 3 supporting and risk signals, the open questions to ask, and " +
      "how you decided on similar deals. Paid plans also get mandate fit and comparable outcomes.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string", description: "The deal's deck_id (UUID) from nuvc_my_deals" },
      },
      required: ["deck_id"],
    },
  },
  {
    name: "nuvc_precedent",
    description:
      "Your own decision history on deals like this one (same sector and stage), read-only: how many similar " +
      "deals you passed on, your most common reasons, and the score each had when you decided. Shown only when " +
      "you have at least 3 similar decisions on record.",
    inputSchema: {
      type: "object",
      properties: {
        deck_id: { type: "string", description: "The deal's deck_id (UUID) from nuvc_my_deals" },
      },
      required: ["deck_id"],
    },
  },
];

export const WORKSPACE_TOOL_NAMES = WORKSPACE_TOOLS.map((t) => t.name);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function clampLimit(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) throw new OwnDataError(`limit must be a number from 1 to ${MAX_LIMIT}.`);
  return Math.min(n, MAX_LIMIT);
}

/** Contact details travel only when the API says they are available, even if a body carries them. */
function stripUnavailableContact(item) {
  if (item.contact_state !== "available") delete item.contact;
  return item;
}

// Results carry company, founder and deck-derived text, so each is prefixed with the data-not-instructions line.
const json = (heading, payload) =>
  withUntrustedNotice(`${heading}\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``);

/** `deps` = { apiCall, unwrap, snakeKeys } from lib/tools.js. */
export function createWorkspaceHandlers({ apiCall, unwrap, snakeKeys }) {
  async function read(path, { deckScoped = false } = {}) {
    try {
      return snakeKeys(unwrap(await apiCall("GET", path)));
    } catch (err) {
      if (err?.status === 404) {
        throw new Error(deckScoped ? `${NOT_ENABLED} (Or that deal is not one your account can read.)` : NOT_ENABLED);
      }
      // A 401 (expired or wrong key) falls through to the shared handling, which says so.
      if (err?.status === 403) {
        if (err.code === "product_scope_mismatch") throw new Error(FAMILY_OFFICE_REFUSAL);
        // An account with no investor profile yet: the API's own message says to finish onboarding.
        if (err.code === "investor_profile_required" && err.apiMessage) throw new Error(err.apiMessage);
        throw new Error(NO_ACCESS);
      }
      // A per-route rate limit is not a quota: no pack to buy, just wait. A spent quota keeps its own message.
      if (err?.status === 429 && err.code !== "QUOTA_EXCEEDED") throw new Error(RATE_LIMITED);
      throw err;
    }
  }

  return {
    nuvc_my_deals: async (args = {}) => {
      assertNoForeignIdentityArgs(args);
      const limit = clampLimit(args.limit);
      const qs = new URLSearchParams({ page: "1", limit: String(limit) });
      if (args.source !== undefined && args.source !== null && args.source !== "") {
        if (!SOURCES.includes(args.source)) throw new OwnDataError(`source must be one of: ${SOURCES.join(", ")}.`);
        qs.set("source", args.source);
      }
      const data = pick(await read(`/vc/deal-library?${qs}`), DEAL_LIBRARY) || {};
      const items = (data.items || []).map(stripUnavailableContact);
      if (!items.length) return "No deals in your pipeline" + (args.source ? ` from source '${args.source}'.` : ".");
      const notes = [];
      if (data.has_more) notes.push(`showing ${items.length} of ${data.total ?? "more"}`);
      if (data.partial || data.truncated) notes.push("partial list: some sources could not be read in full");
      const heading = `## Your deals (read-only)${notes.length ? ` (${notes.join("; ")})` : ""}`;
      return json(heading, { ...data, items });
    },

    nuvc_deal_brief: async (args = {}) => {
      assertNoForeignIdentityArgs(args);
      const deckId = assertDeckId(args);
      const brief = pick(await read(`/vc/deals/${deckId}/brief`, { deckScoped: true }), BRIEF) || {};
      if (Array.isArray(brief.signals)) brief.signals = brief.signals.slice(0, 3);
      // The verdict sentence is deck-derived: it stays inside the JSON block (brief.verdict), never in the heading.
      return json("## Decision brief (read-only)", brief);
    },

    nuvc_precedent: async (args = {}) => {
      assertNoForeignIdentityArgs(args);
      const deckId = assertDeckId(args);
      const data = pick(await read(`/vc/deals/${deckId}/precedent`, { deckScoped: true }), PRECEDENT_RESPONSE) || {};
      if (!data.precedent) return NO_PRECEDENT;
      return json("## Your precedent on similar deals (read-only)", data.precedent);
    },
  };
}
