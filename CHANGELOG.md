# Changelog

## 2.0.2 — a shorter path to a first result, and safer output

### For a new user
- The README opens with four steps that work once a key exists: create a key, add the server, confirm the
  connection with a `nuvc_venture_math` call (no credits), then save a mandate and score a pitch. The pipeline tools, which need
  the investor workspace to be enabled, have their own section. Cursor and Claude Code setup are spelled out.
- Install commands name this version, and a release check fails if the README pins any other 2.x version.
- The listing description leads with what every key can do: score against your mandate, screen funds, run the maths.

### Clearer recovery
- Any `401` now says that a key which used to work may have expired or been revoked, and where to create a new
  one. The earlier hint waited for the word "expired", which the API does not send.
- An out-of-credits (`402`) or spent-quota (`429`) message names the billing page, so you can act on it without
  another tool call. The package still never starts a checkout.
- "Not enabled for your account" now says which tools still work and how to ask for access.

### Safer output
- Results that carry deck, investor or mandate text (scoring, analysis, extraction, matching, fund screening, the
  saved mandate and the workspace tools) have invisible characters removed: the zero-width space, bidirectional
  marks and overrides, Unicode tag characters, and control characters other than tab and newline. Markdown image
  syntax in them is escaped. Joiners that emoji and Persian or Indic text need are kept. Headings and line breaks
  in returned text are not altered, so the data notice at the top of each result remains the guard for those.
- A decision or verdict that arrives as something other than text is left out; it can no longer raise an error
  after a credit was spent or print as `[object Object]`.

### Less detail about the service
- `nuvc_models` now answers one question: is the scoring service available right now. It no longer lists what sits
  behind the API.
- A match result, and the description of the matching tool, no longer say how the shortlist is computed or how
  long it took.
- The fund-name example in `nuvc_screen_fund` is a made-up name.
- If an analysis or extraction comes back in an unexpected shape, the result says so; the raw body is no longer
  printed.

### Measurement
- Links to nuvc.ai from the README, the npm homepage field and the registry listing carry a source tag, so a visit
  can be traced to the listing it came from. No key, prompt or usage data is attached to a link.
- The request `User-Agent` names the exact package version.

No change to tool names, input schemas or credit costs. The output of `nuvc_models` and the first line of a match
result are shorter, as described above.

## 2.0.1 — listed in the official MCP Registry

- Adds `mcpName` (`io.github.repyh-com/nuvc-mcp`) to `package.json`, a matching `mcp-name` line in the README and a
  `server.json`, so the package can be published to the official MCP Registry (registry.modelcontextprotocol.io).
  Directories that read from the registry pick it up from there.
- No change to tools, schemas, credit costs or behaviour.

## 2.0.0 — investor-only, firm-bound

### Breaking
- **The default tool list now depends on your account type.** Instead of all thirteen tools, an assistant is shown the
  set for how you invest (`angel`, `vc`, `allocator` or `integrator`), chosen with `NUVC_TOOLSET=auto`, which is the
  default. An account type with no set of its own, and any lookup that fails, still gets every tool. Set
  `NUVC_TOOLSET=all` to restore the full list. Nothing is removed: tool names, input schemas, annotations and credit
  costs are unchanged, and a tool that is not listed can still be called by name.
- **Founder tools are removed.** `nuvc_roast` is no longer listed, and calling it answers with a migration
  message directing founder workflows to `repyh-mcp`; it makes no request. `nuvc-mcp@1.4.1` retains
  legacy behavior. No founder tool is advertised under any environment.
- **`NUVC_MCP_LEGACY_FOUNDER_TOOLS` is removed.** Setting it no longer re-advertises `nuvc_roast` (stdio or HTTP);
  it is ignored.
- **The mandate is bound to the firm account, not the session.** The package keeps no mandate state.
  `nuvc_set_mandate` saves to the account that owns the API key and **errors** if it cannot (1.x silently fell back
  to a session-only mandate). `nuvc_get_mandate` and `nuvc_score` read the account's saved mandate, and
  `nuvc_get_mandate` now surfaces API and auth errors instead of reporting "No mandate set".
- Tool descriptions are rewritten for investors. Tool names, input schemas (other than the removed tool) and credit
  costs are unchanged.
- **A key in the URL is no longer accepted by default.** The `?config=` parameter is ignored unless
  `NUVC_MCP_ALLOW_CONFIG_QUERY_KEY=1` is set; a request that sends its key only that way gets a `401` asking for the
  `Authorization` header. URLs are logged by proxies and clients. `Authorization: Bearer` and `X-API-Key` are
  unchanged, as is stdio.

### Recovery and setup
- Payment-required and quota-exhausted errors point to the free account billing read before any purchase or retry. Recovery copy does not repeat backend offers or imply a pack is available to every account.
- Local-source setup includes dependency installation and a free billing connection check before a metered action.

### Added
- **Toolsets.** `NUVC_TOOLSET` takes `angel`, `vc`, `allocator`, `integrator`, `all` or `auto` (the default). Each set
  lists only the tools that kind of investor uses, in the order they are used, with wording and one example prompt
  written for them. `auto` reads your account type once with your own key (stdio: once per process; HTTP: once per key,
  kept ten minutes under a hash of the key) and reads nothing else from your account. A value that is not recognised
  falls back to `auto` with one warning. One line on stderr says which set is active and why, with no key in it. On
  the HTTP server, `?toolset=<name>` on `/mcp` overrides the setting for that request (an unknown name is a `400`).
  A tool called by name that is outside the active set still runs, and its answer ends with a line on how to list
  every tool.
- **Read-only workspace tools** for the account that owns the key: `nuvc_my_deals`, `nuvc_deal_brief` and
  `nuvc_precedent`. No write, preview or apply. Arguments naming an investor, user, owner, firm or profile id are
  rejected, `deck_id` must be a UUID, and every response passes an allow-list so a new backend field cannot reach the
  assistant until it is reviewed. Founder contact details appear only when the API reports they are available. A 404
  reads "This feature isn't enabled for your account yet"; 401 and 403 read "your NUVC key does not have access to
  the investor workspace".
- A REPYH founder key (`repyh_...`) is refused before any request, on stdio and on every HTTP request, with a message
  directing founder workflows to `repyh-mcp`; `nuvc-mcp@1.4.1` retains legacy behavior. Investor keys (`nuvc_...`,
  including keys minted before keys carried an audience) work unchanged.
- The whole key must be letters, digits and underscores after `nuvc_`. Anything else is refused before any request
  and is never echoed in an error.
- **Origin check.** A request that carries an `Origin` header not listed in `MCP_ALLOWED_ORIGINS` (comma-separated,
  exact match; empty by default) gets `403`. MCP clients that send no `Origin` are unaffected.
- **Rate limits and access log.** `/mcp` is limited per API key (default 60 requests a minute,
  `MCP_RATE_LIMIT_PER_MINUTE`, keyed on a hash of the key) and per client address (default 600 a minute,
  `MCP_RATE_LIMIT_PER_MINUTE_IP`, IPv6 grouped by `/64`); over a limit answers `429` with `Retry-After`. One
  access-log line per request (not the health check) goes to stderr: time, method, path without the query string,
  status (`499` if the client left early), duration and client address. Never a key or body.
- **Tool annotations.** Every tool declares them. Only tools that read and spend nothing are `readOnlyHint: true`;
  tools that spend credits or quota (`nuvc_score`, `nuvc_analyze`, `nuvc_extract`, `nuvc_match_investors`,
  `nuvc_screen_fund`) are not, so a client that auto-approves read-only tools will still ask. `nuvc_set_mandate` is
  `readOnlyHint: false, destructiveHint: true, idempotentHint: true`.
- **Returned content is marked as data.** Results that carry text derived from decks, investor profiles or analysis,
  and the saved mandate, start with one line saying the content below is data returned by the API, not instructions.

### Changed
- `nuvc_fund_economics` honours a management fee or carry of exactly 0 (a no-fee SPV, a zero-carry fund) instead of assuming 2% or 20%. Only an omitted or `null` value is assumed. The notes follow the server's `fee_economics.terms_assumed` when it is sent, with a fallback for older servers, the `/portfolio` follow-up now sends the 0 you gave, and the Fee Drag label says "assumed" only when the term really was assumed. The "treated as not given" notes are gone. Needs the matching backend change (an explicit 0 is honoured there too), so ship them together.
- **Error bodies are read in either shape.** Routes behind the response middleware send an error as
  `{success: false, error: {detail: ...}}`; the plain `{detail}` shape still works. A 422, 500 or 503 now shows its
  message, and an expired key on a pipeline tool says the key expired instead of "no access to the investor workspace"
  (only a 403 says that). A family office account is told the pipeline tools read the venture pipeline, an account
  with no investor profile gets the API's own onboarding message, and a per-route rate limit says wait and retry
  (no pack to buy).
- Errors are readable: a validation failure lists each field and message, a spent monthly quota shows its own message
  instead of "wait and retry", and a credits error shows the service's message with the billing link. Tool inputs now
  state the limits the service enforces.
- `nuvc_score` prints a confidence level (High, Medium, Low or Uncertain) beside the 0 to 10 score. `nuvc_screen_fund`,
  `nuvc_extract`, `nuvc_venture_math` and `nuvc_fund_economics` no longer print blank, `null` or `[object Object]`
  output, and say when a benchmark or portfolio section was skipped. `nuvc_set_mandate` accepts a single sector or
  stage as text, and its description says it replaces the saved mandate. `nuvc_match_investors` no longer prints a
  database size.
- The `nuvc_deal_brief` verdict sentence now appears only inside the JSON block, no longer in the heading.
- The User-Agent is `nuvc-mcp/2.0`.
- Responses are read tolerantly of camelCase and snake_case field names. HTTP is per-caller keyed with isolated
  state, and request bodies are limited.
- Upstream error text is stripped of control characters before it is shown.
- Dependency advisories on `hono` (pulled in by the MCP SDK) are cleared in the lockfile.
