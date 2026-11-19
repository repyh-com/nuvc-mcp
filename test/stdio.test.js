// stdio transport: real child process over the MCP protocol. Same 2.0 contract as HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { INVESTOR_TOOL_NAMES } from "./helpers.js";

async function listOver(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, NUVC_API_KEY: "nuvc_test_key_stdio", NUVC_TOOLSET: "all", ...env },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

test("stdio tools/list is exactly the investor surface by default", async () => {
  assert.deepEqual(await listOver({}), INVESTOR_TOOL_NAMES);
});

test("stdio: the removed legacy switch no longer adds a founder tool", async () => {
  assert.deepEqual(await listOver({ [["NUVC_MCP", "LEGACY", "FOUNDER", "TOOLS"].join("_")]: "1" }), INVESTOR_TOOL_NAMES);
});

test("stdio: a repyh_ key in NUVC_API_KEY is refused with a pointer to repyh-mcp", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, NUVC_API_KEY: "repyh_" + "c".repeat(64), NUVC_TOOLSET: "all" },
  });
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: "nuvc_models", arguments: {} });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /REPYH founder key.*repyh-mcp.*founder workflows.*nuvc-mcp@1\.4\.1/s);
  } finally {
    await client.close();
  }
});
