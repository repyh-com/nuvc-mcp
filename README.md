# nuvc-mcp: screen pitches and funds against your own mandate, inside Claude and Cursor

<!-- mcp-name: io.github.repyh-com/nuvc-mcp -->

[![npm](https://img.shields.io/npm/v/nuvc-mcp)](https://npmjs.com/package/nuvc-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

Save your mandate once. Paste a pitch and get a 0 to 10 score with a confidence level and a proceed / watch / pass read against that mandate. Screen a VC fund as an LP. Run fund and venture maths. You make every investment decision.

- Scoring, fund screening and co-investor matching use credits. Fund and venture maths do not spend score credits.
- Your key travels in a header, not in a URL, by default. Tools that spend credits are labelled, so a client can ask first.
- For investors. Version 2 removed the 1.x founder tools; founders use `repyh-mcp` (see [Migrating from 1.x](#migrating-from-1x)).

## Start in four steps

1. **Create a free API key.** Start at [nuvc.ai/developers](https://nuvc.ai/developers?utm_source=nuvc-mcp&utm_medium=readme&utm_campaign=mcp-listings-2026-11&utm_content=quickstart), which shows what a new key includes and the current credit price. Give the key the scopes for the tools you want; scoring needs `ai:score` (see [Which scopes your key needs](#which-scopes-your-key-needs)).
2. **Add the server to your assistant.** In Claude Code:

   ```bash
   claude mcp add nuvc --scope user -e NUVC_API_KEY=nuvc_your_key -- npx --yes nuvc-mcp@2.0.2
   ```

   The Claude Desktop and Cursor configuration is under [Setup](#setup).
3. **Confirm it works without spending a credit.** Ask: “Use the `nuvc_venture_math` tool: $40K MRR, $90K monthly burn, raising $1.5M seed at $8M pre. Do the numbers hold?” Your client should show a `nuvc_venture_math` call, which does not spend score credits. If it answers without one, the server is not connected.
4. **Save your mandate, then score a pitch.** Ask: “Save my mandate: seed, B2B software, ANZ, $25K to $100K cheques.” Then: “Score this pitch against my mandate: [paste text]”. Scoring uses credits.

To see your balance and what each tool costs, open [API billing](https://nuvc.ai/api-platform/billing) or ask for `nuvc_billing`.

## Confirm your connection without spending credits

After adding the server, restart your MCP client and ask the venture-maths question in step 3 above. Your client should show a `nuvc_venture_math` call; it does not spend score credits, and a result confirms that the client and key work. To see your allowance and tool costs, open [API billing](https://nuvc.ai/api-platform/billing), or ask: “Use `nuvc_billing` to check my allowance and tool costs.” That read does not run analysis or start a purchase, and it needs a server release that includes billing discovery. If the server says billing discovery is unavailable, the deployed server may be an earlier release. Do not infer a zero balance or buy access to fix a connection problem.

## Your first useful result

Choose your workflow before spending a credit:

- **New pitch:** “Show my saved mandate before screening this pitch: [paste].” Review the mandate first; saving one replaces the firm account's mandate and needs your request.
- **Allocator:** “Screen this fund using these terms, track record and LP mandate: [paste].” Use `NUVC_TOOLSET=allocator`; venture pipeline tools are for angel and VC accounts. Pass mandates inline for fund and direct-deal reviews.
- **Integrator:** use `NUVC_TOOLSET=integrator` and pass any mandate inline. Do not depend on venture workspace access.

Both transports supply the same guidance to your assistant at initialization. Following a result is your choice: no automatic scoring, matching, paid retries or account changes.

## If the investor workspace is on for your account

Three read-only tools read your own pipeline, a deal's decision brief, and how you decided on similar deals. They return only the account that owns your key, and they need the investor workspace to be enabled for it. Without it they answer that the feature is not enabled; every other tool still works.

- *"List my pipeline by stage, with the screening signal on each deal."*
- *"Open the decision brief for [company], list its open questions, then show how I decided on similar deals."*

## Check costs before acting

Ask “What is my balance, quota and the current price available to my account?” Your assistant uses `nuvc_billing`, a free read. Prices, currency, pack eligibility and per-tool costs come from your account at request time. An unavailable balance is unknown, not zero. A plan without a self-serve pack is not offered another audience’s pack. Any purchase happens only when you choose to review and confirm it in your browser; the tool never opens checkout or charges you.

## Tools for how you invest

Your assistant is shown the tools that fit how you invest, not all fourteen. Names, inputs and credit costs are the same everywhere; only the list, its order and the wording change.

**Angel or syndicate lead** (`angel`)

| Tool | What you would ask |
|---|---|
| `nuvc_my_deals` | "List my pipeline by stage with the screening score on each deal." |
| `nuvc_deal_brief` | "Open the brief for Acme and list the questions I still need to ask." |
| `nuvc_precedent` | "Have I passed on deals like this before, and why?" |
| `nuvc_score` | "Score this pitch against my saved mandate: [paste]" |
| `nuvc_venture_math` | "$40K MRR, $90K monthly burn, raising $1.5M seed at $8M pre. Do the numbers hold?" |
| `nuvc_match_investors` | "Who else backs seed-stage climate software in Australia and could join this syndicate?" |
| `nuvc_set_mandate` | "Save my mandate: seed, B2B software, ANZ, $25K to $100K cheques, no hardware." |
| `nuvc_get_mandate` | "What mandate do you have saved for me?" |

**Solo GP, emerging VC or micro-fund analyst** (`vc`): the pipeline tools, plus `nuvc_extract` and `nuvc_fund_economics`.

| Tool | What you would ask |
|---|---|
| `nuvc_my_deals`, `nuvc_deal_brief`, `nuvc_precedent` | As above. |
| `nuvc_extract` | "Extract the key metrics from this memo into a table: [paste]" |
| `nuvc_score` | "Screen this deck against our mandate: [paste]" |
| `nuvc_venture_math` | As above. |
| `nuvc_match_investors` | "Who could co-lead a $3M seed in vertical SaaS in ANZ?" |
| `nuvc_set_mandate`, `nuvc_get_mandate` | As above. |
| `nuvc_fund_economics` | "$30M Fund II, 2% fee, 20% carry, $500K average cheque. How many companies can we back?" |

**Family office or allocator** (`allocator`)

| Tool | What you would ask |
|---|---|
| `nuvc_screen_fund` | "Screen Fund IV of [GP]: 2021 vintage, $120M, 2.1x TVPI, 0.6x DPI, against ANZ early-stage venture." |
| `nuvc_fund_economics` | "$80M fund, 2.5% fee, 25% carry, 8% hurdle, 2022 vintage. What does fee drag look like?" |
| `nuvc_score` | "Score this co-investment deck against growth fintech in Asia-Pacific, $2M to $5M: [paste]" |
| `nuvc_venture_math` | "Do these metrics hold up for a Series A: [numbers]" |
| `nuvc_extract` | "Extract the key figures from this fund update: [paste]" |
| `nuvc_analyze` | "List the market risks in this fund memo: [paste]" |

Family office accounts do not get the pipeline tools (`nuvc_my_deals`, `nuvc_deal_brief`, `nuvc_precedent`), because those read the venture pipeline. They are not listed for you, and the mandate tools are left out of this set too.

**Accelerator or platform calling the API from its own code** (`integrator`)

| Tool | What you would ask |
|---|---|
| `nuvc_models` | "Which models are available right now?" |
| `nuvc_score` | "Score this pitch text and return the result as JSON I can show in my platform." |
| `nuvc_extract`, `nuvc_analyze` | "Extract the company fields from this pitch text: [paste]" |
| `nuvc_match_investors`, `nuvc_screen_fund` | "Find five seed-stage investors for this startup description: [paste]" |
| `nuvc_venture_math`, `nuvc_fund_economics` | "Run venture math on these figures and show the benchmark signals: [numbers]" |

There are no pipeline or mandate tools here; pass a mandate inline to `nuvc_score` when you want a fit check.

**How the list is chosen.** The default is `auto`: the server looks up your account type once, with your own key, and shows the matching set. It reads nothing else from your account. If the lookup is not possible (no profile yet, a key that may not read it, a slow connection, an account type with no set of its own), you get all tools. A line on stderr says which set is active, for example `nuvc-mcp toolset: vc (from your account type)`.

Override it with `NUVC_TOOLSET` set to `angel`, `vc`, `allocator`, `integrator`, `all` or `auto`. `all` shows every tool, exactly as 1.x did. A value that is not recognised falls back to `auto` with one warning.

```bash
claude mcp add nuvc -e NUVC_API_KEY=nuvc_your_key -e NUVC_TOOLSET=all -- npx -y nuvc-mcp
```

A tool that is not listed for you can still be called by name; the answer ends with a line saying which set is active and how to list everything. On the HTTP server you can also choose per request with `?toolset=<name>` on the `/mcp` address (it is not a secret, and an unknown name is refused with `400`).

## Pricing and allowance

Ask “What will this cost, and what is my current balance?” before a metered action. `nuvc_billing` reads your account's current score credits, monthly quota, eligible pack price and currency, and costs for the tools available to this audience. It spends neither credits nor quota and does not start checkout.

Prices come from the server's current catalogue, never a fixed price in this package. An unavailable balance is not zero; an unavailable quota is not unlimited. If no self-serve pack is offered, review your account allowance. An eligible purchase link opens billing for your review and confirmation in a browser. Matching can charge only when matches are returned, as shown by the billing tool; plan and key permissions still apply.

## All tools

What `NUVC_TOOLSET=all` lists.

| Tool | What it does |
|------|-------------|
| `nuvc_billing` | Current balance, quota, tool costs and eligible pack price; no purchase |
| `nuvc_score` | Screen inbound deals — score any pitch 0-10 across 5 dimensions. With a firm mandate saved, also returns a **two-way fit** (does it fit your thesis? would the founder want you?) and a proceed/watch/pass outcome that applies your own saved mandate and rules, for you to review |
| `nuvc_set_mandate` | Save your firm's mandate (sector, stage, cheque size, thesis) to the account that owns the API key — every `nuvc_score` from that account then returns a mandate↔deal fit automatically |
| `nuvc_get_mandate` | Show the mandate saved on the firm account |
| `nuvc_screen_fund` | Screen a venture fund the LP way — 6-dimension LP screen + conviction verdict + decision, optionally against your mandate |
| `nuvc_match_investors` | Find co-investors or syndicate partners for a deal |
| `nuvc_venture_math` | Validate startup financials against stage-appropriate VC benchmarks |
| `nuvc_fund_economics` | Fund economics from an LP lens — fee drag, GP alignment, J-curve, portfolio construction |
| `nuvc_analyze` | Competitive landscape or market analysis for diligence |

### Utility

| Tool | What it does |
|------|-------------|
| `nuvc_extract` | Extract structured data from any pitch, CIM, or deal memo |
| `nuvc_models` | List available AI models and provider health |

### Your workspace (read-only)

These read the pipeline and decision history of the account that owns your key. They never write, and
they return "This feature isn't enabled for your account yet" until the workspace is switched on for
your account.

| Tool | What it does |
|------|-------------|
| `nuvc_my_deals` | Your deals: company, source (upload / screened / NUVC / portfolio), stage, the 0-10 screening signal and label, and founder contact only when it is on file for you |
| `nuvc_deal_brief` | A deal's decision brief: the screening signal with confidence and a suggested next step, up to 3 signals, open questions, and your precedent |
| `nuvc_precedent` | How you decided on similar deals (same sector and stage), once you have at least 3 on record |

## Setup

### 1. Get an API key

This package takes an **investor** key (starts with `nuvc_`). A founder key (`repyh_...`) is refused
before any request. Use `repyh-mcp` for founder workflows; `nuvc-mcp@1.4.1` retains legacy behavior.

New to NUVC? Start at **[nuvc.ai/developers](https://nuvc.ai/developers?utm_source=nuvc-mcp&utm_medium=readme&utm_campaign=mcp-listings-2026-11&utm_content=setup)**, which shows what a new key includes. Already have an account? Create or review a key at [nuvc.ai/api-platform/keys](https://nuvc.ai/api-platform/keys) and check the current allowance there.

### 2. Choose the investor release

Use `nuvc-mcp@2.0.2` in the commands below. This is a breaking change from 1.x: it accepts investor keys and removes founder tools. Registry listings and third-party installers may select a different version; check the selected version before migrating a client.

### 3. Or run directly

```bash
export NUVC_API_KEY=nuvc_your_key_here
npx --yes nuvc-mcp@2.0.2
```

### 4. Claude Desktop config

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "nuvc": {
      "command": "npx",
      "args": ["--yes", "nuvc-mcp@2.0.2"],
      "env": {
        "NUVC_API_KEY": "nuvc_your_key_here"
      }
    }
  }
}
```

Cursor reads the same block from `~/.cursor/mcp.json`. If a desktop client cannot find `npx` (common when Node.js is installed with a version manager), put the full path to `npx` in `command`.

### 5. Claude Code

```bash
claude mcp add nuvc --scope user -e NUVC_API_KEY=nuvc_your_key_here -- npx --yes nuvc-mcp@2.0.2
```

## Install from a GitHub release or a local copy

npm is the usual route. Each release also attaches the same tarball on GitHub, for anyone who would rather not install from the npm registry. Both need Node.js 20 or newer (Node.js 24 LTS recommended). Configure your key locally and run:

```bash
NUVC_API_KEY='replace_with_your_existing_key' npx --yes https://github.com/repyh-com/nuvc-mcp/releases/download/v2.0.2/nuvc-mcp-2.0.2.tgz
```

To use the GitHub tarball in a client configuration, replace the `nuvc-mcp@2.0.2` argument with the asset URL above.

Before running a local source copy, use Node.js 20 or newer (Node.js 24 LTS recommended) and install its dependencies from the directory containing this package's `package.json`:

```bash
npm install --ignore-scripts
```

Then configure your key in your MCP client's environment and restart the client. Never paste a real key into a conversation.

```bash
NUVC_TOOLSET=vc node index.js  # from the local package directory; configure NUVC_API_KEY first
```

To connect a desktop MCP client to this local package, add a local server entry (replace the absolute path and placeholder locally):

```json
{
  "mcpServers": {
    "nuvc": {
      "command": "node",
      "args": ["/absolute/path/to/local-mcp/index.js"],
      "env": { "NUVC_API_KEY": "replace_with_your_key", "NUVC_TOOLSET": "vc" }
    }
  }
}
```

Keep real keys in your client configuration, never in chat or source control. Allocators should choose `allocator` instead of `vc`.

## Which scopes your key needs

| Tools | Scope on your key |
|---|---|
| `nuvc_score`, `nuvc_set_mandate`, `nuvc_get_mandate`, `nuvc_screen_fund` | `ai:score` |
| `nuvc_analyze` | `ai:analyze` |
| `nuvc_extract` | `ai:extract` |
| `nuvc_match_investors` | `ai:match` |
| `nuvc_models` | none |
| `nuvc_my_deals`, `nuvc_deal_brief`, `nuvc_precedent`, `nuvc_venture_math`, `nuvc_fund_economics` | no `ai:*` scope on an ordinary key |

A key described as read-only for an assistant can still save your mandate and spend credits through the scoring tools if it also carries a scoring scope.

## Usage Examples

Once connected, just ask your AI agent:

**Investors:**
- *"Score this pitch: [paste founder's pitch text]"*
- *"Find co-investors who do seed-stage FinTech deals in Southeast Asia"*
- *"This founder says $500K ARR, 15% MoM growth, $200K burn at Seed. Run the math."*
- *"We're raising a $30M Fund II with 2% fee, 20% carry, $500K avg check. What does portfolio construction look like?"*
- *"Evaluate this fund: $50M AUM, 2.5x TVPI, 1.2x DPI, 18% net IRR, 2020 vintage"*

## Migrating from 1.x

2.0.0 is a breaking release (investor-only, firm-bound).

| 1.x | 2.0 |
|-----|-----|
| `nuvc_roast` | **Removed.** Use `repyh-mcp` for founder workflows. A call to `nuvc_roast` returns a migration message without making a request. `nuvc-mcp@1.4.1` retains legacy behavior. |
| Mandate lived in the session, with best-effort account save | Mandate lives on the **firm account** that owns the API key. `nuvc_set_mandate` now fails loudly if it cannot be saved instead of silently applying to one session; `nuvc_get_mandate` and `nuvc_score` read the account mandate. |
| Founder-oriented tool descriptions | Investor wording; tool names, inputs and credit costs are unchanged. |

The 1.x founder-tools compatibility switch has been removed and is ignored if set (see the changelog). Pin `nuvc-mcp@1.4.1`
if you need the old behaviour unchanged.

## HTTP transport (self-hosted / Smithery)

`node server.js` serves `POST /mcp`. Every request must carry the **caller's own** NUVC key
(`Authorization: Bearer nuvc_...` or `X-API-Key`); a request without one gets `401`. The server never reads a shared key from its environment. Bodies are capped at 1 MB (`413`),
malformed JSON gets a `400` JSON-RPC parse error, and each request is bound to the calling key's firm account (no state is shared between callers).
stdio mode (`npx --yes nuvc-mcp@2.0.2`) reads `NUVC_API_KEY` from your local environment.

HTTP settings (all optional):

| Variable | Default | Effect |
|---|---|---|
| `NUVC_MCP_ALLOW_CONFIG_QUERY_KEY` | off | `1` accepts a key from a `?config=` URL parameter. Off by default because URLs are logged; send the key in a header. |
| `MCP_ALLOWED_ORIGINS` | none | Comma-separated exact origins. A request with an `Origin` header not listed gets `403`; clients that send no `Origin` are unaffected. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `60` | Per API key (hashed in memory, never logged); over the limit answers `429` with `Retry-After`. |
| `MCP_RATE_LIMIT_PER_MINUTE_IP` | `600` | Per client address on every `/mcp` request (IPv6 grouped by `/64`), so users behind a shared address are not starved by one key. |

Limits are whole numbers (`1e3` means 1000) up to 100000; any other value falls back to the default.

Each request writes one access-log line to stderr (time, method, path without query string, status, duration,
client address; never a key or body).

## Development

`npm test` runs the full suite using Node’s built-in runner.

Before publishing a reviewed commit, commit all changes and run `bash scripts/verify-before-push.sh`. It rejects a dirty worktree, runs the full suite including release checks, and records verification for that exact commit. It does not push or publish.

## Usage and recovery

Check your current credit balance and available packs in [API billing](https://nuvc.ai/api-platform/billing). Scoring, fund screening and investor matching consume credits. Analysis and extraction use quota; stored workspace reads and venture math do not spend score credits. A result suggests a next step without making another paid call.

- Key or scope error: check the configured key and required scope; never paste a key into chat.
- Credits or quota exhausted: ask for `nuvc_billing`, a free read, to see your balance, quota reset and account-specific options. A pack is offered only where your account is eligible; credits do not extend every tool’s quota.
- Rate limit: wait for the suggested retry interval; a purchase does not fix a transient limit.
- Timeout or service error: do not automatically repeat paid actions when the outcome is uncertain. Check the relevant account activity before choosing whether to retry.
- Workspace unavailable: confirm account access. You can still request a review of supplied deal or fund evidence where your key permits it.

## About NUVC

NUVC is screening and decision-support software for investors; it is not investment advice.

- **Website:** [nuvc.ai](https://nuvc.ai/?utm_source=nuvc-mcp&utm_medium=readme&utm_campaign=mcp-listings-2026-11&utm_content=about)
- **API Docs:** [nuvc.ai/api-platform/docs](https://nuvc.ai/api-platform/docs)
- **Support:** hello@nuvc.ai
