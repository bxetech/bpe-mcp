#!/usr/bin/env node
// BPE MCP server — entry point.
//
// Boots a stdio-transport MCP server that exposes the BPE market-data API
// to MCP-enabled agents (Claude Desktop, Cursor, Goose, etc.). All real
// work happens in tools.ts; this file just wires transport + lifecycle.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BpeClient } from "./client.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const apiKey = process.env.BPE_API_KEY;
  if (!apiKey) {
    // We can't write to stdout (it's the MCP transport), so log to stderr —
    // Claude Desktop surfaces stderr in the MCP server logs panel.
    process.stderr.write(
      "Error: BPE_API_KEY environment variable is required.\n" +
        "Get a key at https://bxetech.com/contact and set it in your\n" +
        "MCP server config under `env.BPE_API_KEY`.\n",
    );
    process.exit(1);
  }

  const client = new BpeClient({
    apiKey,
    baseUrl: process.env.BPE_BASE_URL,
    timeoutMs: process.env.BPE_TIMEOUT_MS ? Number(process.env.BPE_TIMEOUT_MS) : undefined,
  });

  const server = new McpServer(
    { name: "bpe", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  registerTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Don't log on successful boot — Claude Desktop only shows stderr if it
  // looks like an error, and a routine "started" line trips false-positive
  // warnings in the UI.
}

main().catch((err) => {
  process.stderr.write(`bpe-mcp fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
