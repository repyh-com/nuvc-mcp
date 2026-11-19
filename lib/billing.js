// Display only reviewed billing fields; account and payment data never become instructions.
const get = (o, key) => o?.[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? o?.[key];
const count = (v) => Number.isSafeInteger(v) && v >= 0;

export function billingUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (u.origin !== "https://nuvc.ai" || u.pathname !== "/api-platform/billing") return null;
    // Never echo server-supplied query values (they may contain credentials).
    return `${u.origin}${u.pathname}`;
  } catch { return null; }
}

export function renderBilling(response, knownTools) {
  const d = response?.data ?? response;
  if (!d || typeof d !== "object" || response?.success === false) throw new Error("Billing details are unavailable. Try again later; do not assume your balance is zero.");
  const balance = get(d, "balance");
  const available = get(d, "balance_available") === true && count(balance);
  const lines = ["## NUVC billing", available ? `Score-credit balance: ${balance}` : "Score-credit balance: unavailable (not a measured zero)."];
  const quota = get(d, "quota");
  if (!quota || !count(quota.used) || !(quota.limit === null || count(quota.limit))) {
    lines.push("Monthly quota: unavailable.");
  } else {
    lines.push(quota.limit === null ? `Monthly quota: ${quota.used} used; unlimited.` : `Monthly quota: ${quota.used} used of ${quota.limit}.`);
    if (count(quota.remaining)) lines.push(`Quota remaining: ${quota.remaining}.`);
    const reset = get(quota, "resets_at");
    if (typeof reset === "string" && /^\d{4}-\d{2}-\d{2}T/.test(reset) && Number.isFinite(Date.parse(reset))) lines.push(`Quota resets: ${new Date(reset).toISOString()}.`);
  }
  const pack = d.pack;
  const cents = get(pack, "unit_amount_cents");
  const currency = typeof pack?.currency === "string" && /^[a-z]{3}$/i.test(pack.currency) ? pack.currency.toUpperCase() : null;
  const ownPack = d.audience === "investor" && get(pack, "pack_id") === "investor_starter_50";
  const quote = ownPack && count(cents) && cents > 0 && count(pack?.credits) && pack.credits > 0 && currency;
  const purchase = get(d, "purchase_available") === true && quote;
  if (quote) {
    lines.push(`Available pack: ${pack.credits} score credits for ${currency} ${(cents / 100).toFixed(2)} (${cents} cents); ${currency} ${(cents / 100 / pack.credits).toFixed(4)} per credit.`);
    if (!purchase) lines.push("This is a configured pack quote; purchasing is not available here. It does not activate access or grant credits.");
  } else {
    lines.push("No self-serve credit pack is currently offered here. Check your account allowance; do not assume another plan's pack applies.");
  }
  const costs = get(d, "tool_costs");
  if (Array.isArray(costs)) {
    const rows = costs.filter((c) => knownTools.has(c?.tool) && count(get(c, "credit_cost")) && count(get(c, "quota_cost")));
    if (rows.length) {
      const table = ["| Tool | Score credits | Quota calls | Monthly quota applies | Access | Charge condition |", "|---|---:|---:|---|---|---|"];
      for (const c of rows) {
        const access = { __proto__: null, included: "Included", scope_required: "Key scope required", plan_required: "Plan access required", workspace_required: "Workspace access required" }[c.access] ?? "Account access applies";
        const condition = { __proto__: null, successful_result: "Successful result", matches_returned: "Only when matches are returned", not_metered: "No credit charge" }[get(c, "charge_condition")] ?? "Check account terms";
        const monthly = get(c, "monthly_quota_applies");
        table.push(`| ${c.tool} | ${get(c, "credit_cost")} | ${get(c, "quota_cost")} | ${monthly === true ? "Yes" : monthly === false ? "No" : "Unknown"} | ${access} | ${condition} |`);
      }
      lines.push(table.join("\n"));
      lines.push("Tool and plan access still apply; listed costs do not grant access.");
    }
  }
  lines.push(get(d, "credit_actions_bypass_quota") === true ? "Your paid credit balance allows credit-metered actions to bypass the free quota cap." : "Credit-metered actions may also be subject to your monthly quota.");
  const url = billingUrl(get(d, "billing_url"));
  if (purchase && url) lines.push(`Next: review billing in your browser at ${url}. Choose and confirm any purchase there; this tool does not start checkout or charge you.`);
  else if (url) lines.push(`Next: review account access at ${url}. Purchasing is not available here; this tool does not start checkout or charge you.`);
  else lines.push("Next: review billing and allowance in your account. This tool does not start checkout or charge you.");
  return lines.join("\n\n");
}

export async function readBilling(apiCall, path, knownTools) {
  try { return renderBilling(await apiCall("GET", path), knownTools); }
  catch (err) {
    if (err?.status === 404 || /error 404|\(404\)/i.test(err?.message ?? "")) throw new Error("Billing discovery is not available on this server yet. Update the server or try again later; no prices or balance have been assumed.");
    const status = err?.status;
    if (status === 401) throw new Error("Billing could not authenticate your key. Check NUVC_API_KEY in your client settings; never paste it into chat.");
    if (status === 403) throw new Error("This key cannot read billing. Check its account audience and read permissions in your account.");
    if (status === 429) throw new Error("Billing is temporarily rate limited. Wait before trying again; no purchase is needed.");
    if (/^Request timed out/.test(err?.message ?? "")) throw new Error("Billing timed out. Try this read again later; no checkout or paid action was started.");
    throw new Error("Billing details could not be read. Check your client key configuration and connection, then try again later; no prices or balance have been assumed.");
  }
}
