// Preloaded into a child process (node --import) so a stdio test can exercise `auto` without the network.
// Answers GET /api/v3/vc/profiles from NUVC_TEST_PROFILE (a JSON body; status from NUVC_TEST_STATUS) and writes
// one "STUB-LOOKUP" line to stderr per call, so a test can count lookups. Anything else is a 404.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.nuvc.ai/")) return realFetch(url, init);
  if (init.method === "GET" && u.endsWith("/api/v3/vc/profiles")) {
    process.stderr.write(`STUB-LOOKUP ${init.method} ${u.replace("https://api.nuvc.ai", "")} body=${init.body === undefined ? "none" : "present"}\n`);
    return new Response(process.env.NUVC_TEST_PROFILE ?? "{}", {
      status: Number(process.env.NUVC_TEST_STATUS ?? 200),
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};
