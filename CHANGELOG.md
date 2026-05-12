# Changelog

All notable changes to `@bxetech/bpe-mcp` are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — initial public release

First public release of the BPE MCP server. Four tools shipping in v0.1:

- `get_consolidated_price` — current consolidated BTC price across the BPE
  exchange network
- `get_market_briefing` — natural-language synthesis of price, funding skew,
  ML signal, and sentiment in one tool call
- `get_funding_skew` — per-venue annualised funding rates + max-spread pair
- `get_ml_signal` — current ML prediction with confidence and sub-model
  breakdown

Auth: `X-API-Key` header, same key as the BPE web portal.
Default backend: `https://mcp.bxetech.com` (override via `BPE_BASE_URL`).
Transport: stdio (Model Context Protocol).
