# BPE MCP Server

Model Context Protocol server for the [BPE](https://bxetech.com) market-data
API. Lets Claude Desktop, Cursor, Goose, and other MCP-enabled agents query
consolidated Bitcoin pricing, ML signals, funding-rate skew, and
natural-language market briefings — without writing any HTTP boilerplate.

> **Status:** v0.2 — five tools, local stdio transport, no LLM
> calls inside the briefing endpoint (template-rendered). API key required.

Listed in the [official MCP Server Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.bxetech/bpe-mcp) as `io.github.bxetech/bpe-mcp`. Install via `npm install -g @bxetech/bpe-mcp` or `npx -y @bxetech/bpe-mcp`.

## Why use it

If you're building an agent that touches Bitcoin markets, you have two
options today:

1. **Talk to 36 different exchange APIs directly.** Each has a different
   schema, different auth, different rate limits, different reliability.
   Your agent burns tokens reasoning over inconsistent payloads.
2. **Use one consolidated source.** BPE aggregates all 36 venues into a
   single normalised feed with derived signals (ML predictions,
   sentiment, funding skew, basis). One auth, one schema, one tool call.

This MCP server is option 2 dressed up as native tools your agent can
discover and call.

## Tools (v0.2)

| Tool | What it does |
|---|---|
| `get_consolidated_price` | Current BTC price aggregated across the BPE network |
| `get_market_briefing` | ~4 lines (brief) or 6–8 (detailed) natural-language summary — price, funding skew, ML signal, sentiment, anomalies |
| `get_funding_skew` | Per-venue annualised funding rates + max-spread pair |
| `get_ml_signal` | Current ML prediction (direction, probability, confidence) at the requested horizon |
| `get_sentiment_snapshot` | Crypto Fear & Greed index, news sentiment, mempool stress |

## Install

```bash
npm install -g @bxetech/bpe-mcp
```

Or use `npx` with no install (recommended for Claude Desktop):

```jsonc
// ~/Library/Application Support/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "bpe": {
      "command": "npx",
      "args": ["-y", "@bxetech/bpe-mcp"],
      "env": {
        "BPE_API_KEY": "bpe_..."
      }
    }
  }
}
```

Restart Claude Desktop. The five tools appear under the MCP server picker.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `BPE_API_KEY` | *(required)* | Get one at https://bxetech.com/contact |
| `BPE_BASE_URL` | `https://mcp.bxetech.com` | Override for self-hosted / local dev |
| `BPE_TIMEOUT_MS` | `5000` | Per-request timeout |

## Local development

```bash
git clone https://github.com/bxetech/bpe-mcp
cd bpe-mcp
npm install
npm run build
BPE_API_KEY=... npm run dev
```

To dogfood in Claude Desktop while iterating, point at the local build:

```jsonc
{
  "mcpServers": {
    "bpe-dev": {
      "command": "node",
      "args": ["/abs/path/to/mcp-server/dist/index.js"],
      "env": {
        "BPE_API_KEY": "...",
        "BPE_BASE_URL": "http://localhost:8082"
      }
    }
  }
}
```

## Roadmap

- **v0.2** — `get_sentiment_snapshot` ✅, friendly tier-aware errors ✅, timestamped briefings ✅
- **v0.3** — `get_basis`, `subscribe_alert` (webhook subscription), hosted HTTP transport for non-developer install (Cursor extension, ChatGPT Desktop)
- **v0.4** — Optional LLM-rendered briefing via Haiku (richer prose, with per-call cost)

See [`docs/research/AGENT_INTEGRATION_AND_MONETISATION_2026-04-27.md`](../docs/research/AGENT_INTEGRATION_AND_MONETISATION_2026-04-27.md) for the broader product / monetisation plan.

## License

MIT — see [`LICENSE`](./LICENSE).
