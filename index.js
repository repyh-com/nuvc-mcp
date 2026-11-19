#!/usr/bin/env node

/**
 * NUVC MCP Server — stdio transport (OpenClaw, Claude Desktop local, npx)
 * Get a free API key at https://nuvc.ai/api-platform/keys
 *
 * stdio is a single-user, local process, so it reads the caller's own key from
 * NUVC_API_KEY. The HTTP transport (server.js) never does — it requires a key per request.
 */

import { SERVER_INSTRUCTIONS } from "./lib/guidance.js";
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, createHandlers, createApiCall } from "./lib/tools.js";
import { toolsFor, toolsetFromEnv, createToolsetCache, createToolsetSelector, withOutOfSetNote } from "./lib/toolsets.js";
import { cleanText } from "./lib/own-data.js";

const { version } = createRequire(import.meta.url)("./package.json");

// Mandate is stored on the firm account that owns the key (not in this process). Investor-only:
// a REPYH founder key (repyh_...) is refused at call time, before any request, and points to repyh-mcp.
const readKey = () => process.env.NUVC_API_KEY;
const HANDLERS = createHandlers(readKey);

// Which tools are listed depends on how you invest (NUVC_TOOLSET; `auto` reads your account type once, on the first
// tools/list, so a missing key still gives the usual clear error when a tool is called). Names, inputs and
// annotations never change, and a tool that is not listed can still be called by name.
const toolsets = createToolsetSelector({
  setting: toolsetFromEnv(),
  apiCall: createApiCall(readKey),
  cache: createToolsetCache({ ttlMs: Infinity }),
  cacheId: "stdio",
  announceSetting: true,
});

const server = new Server(
  { name: "nuvc", version },
  { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsFor(await toolsets.resolve(), TOOLS) }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = HANDLERS[name];
  if (!handler) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    const result = await handler(args || {});
    const note = "Set NUVC_TOOLSET=all in your server settings to list every tool.";
    return { content: [{ type: "text", text: withOutOfSetNote(result, name, toolsets.peek(), note) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${cleanText(err.message)}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
