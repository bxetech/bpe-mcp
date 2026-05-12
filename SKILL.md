---
name: bpe-market-intelligence
version: 0.1.0
description: Cross-venue Bitcoin market intelligence — consolidated pricing, ML signals, funding-rate skew, sentiment, and natural-language briefings across 36 exchanges. Companion to single-exchange MCPs.
homepage: https://bxetech.com/agents
license: MIT
---

# BPE Market Intelligence

A skill for AI agents that need to reason about Bitcoin markets across
venues. Pairs naturally with single-exchange MCP servers (Bybit,
Coinbase, Gemini, Kraken, OKX) — those handle execution on one venue;
BPE handles cross-venue intelligence.

## When to use this skill

Reach for BPE tools when the agent's task involves any of:

- **"What's BTC doing right now?"** → call `get_market_briefing` first.
  One call replaces dozens of raw-data calls plus the synthesis work.
- **Spread / arbitrage / basis questions** → `get_funding_skew` for
  perp-perp; the briefing endpoint surfaces consolidated-vs-venue
  divergence.
- **Directional questions** ("is the market bullish?", "should I expect
  mean-reversion?") → `get_ml_signal` returns calibrated probability,
  not just direction.
- **Reconciling a position against the broader market** → if the user
  is on a single exchange and asks why their P&L looks the way it does,
  cross-check the venue's price against `get_consolidated_price`.
- **Anomaly detection** → the briefing's anomaly hint flags extreme
  funding spreads or high ML confidence regimes worth investigating.

## When NOT to use this skill

- **Order routing, fills, balances, withdrawals** → use the user's
  exchange MCP (Bybit, Coinbase, etc.). BPE is read-only and has
  no execution surface.
- **Exchange-specific account state** ("what's my Bybit balance?") →
  exchange MCP, not BPE. We don't have visibility into user accounts.
- **Wallet operations, signing, on-chain** → not this skill.

## Recommended call patterns

### Pattern 1 — orient before drilling down

For open-ended market questions, **always call `get_market_briefing`
first**. It costs ~1 rate-limit token and ~50 tokens of context, and
gives the agent enough situational awareness to decide what (if
anything) to drill into next. Avoid making the agent assemble a
briefing from individual `get_consolidated_price` / `get_funding_skew`
/ `get_ml_signal` calls — that's slower, more expensive, and what
the briefing endpoint exists to prevent.

### Pattern 2 — confidence-gated decision-making

`get_ml_signal` returns calibrated probabilities. Confidence is on a
0–1 scale where:

- **< 0.55** — treat as noise. The model has a slight edge but not
  enough to justify a thesis.
- **0.55–0.70** — directionally interesting. Worth combining with other
  signals (funding skew, sentiment, regime) before acting.
- **> 0.70** — high-conviction. Surfaced as an anomaly in the briefing.
- **> 0.85** — rare; the model is unusually confident. Worth flagging
  to the user explicitly.

Don't treat confidence as binary. Don't translate "up" / "down" into
trade signals without considering the magnitude.

### Pattern 3 — companion to an exchange MCP

When the user has both an exchange MCP and BPE installed:

- Use **the exchange MCP** for: order placement, account state, fills,
  balance queries, withdrawals.
- Use **BPE** for: pre-trade context (is the market right for this
  trade?), post-trade reconciliation (did my venue's price match
  consensus?), strategy ideation (where's funding cheapest?).
- **Never confuse the two.** A BPE call that reads `get_consolidated_price`
  doesn't reflect the price the user can actually execute at on their
  venue. Use the exchange MCP's order-book or quote tools for that.

## Tool reference

| Tool | Use when | Cost |
|---|---|---|
| `get_market_briefing` | Default first call for any open-ended market question | 1 rate-limit token |
| `get_consolidated_price` | "What's BTC at right now?" | 1 token |
| `get_funding_skew` | Perp-perp arb, basis trade ideation, positioning skew analysis | 1 token |
| `get_ml_signal` | Directional questions, regime detection | 1 token |

All tools return text content blocks designed for direct consumption
by the LLM. No JSON parsing required.

## Available time horizons

`get_ml_signal` accepts `30s`, `60s`, `5m`. Available horizons may
evolve over time — if the agent receives an "available horizons"
error, it should retry with one of the listed alternatives.

## Limitations to surface to the user

- **Read-only.** BPE cannot place orders, manage positions, or move
  funds. If the user asks the agent to act on a signal, route through
  their exchange MCP.
- **BTC-only in v0.1.** ETH, SOL, and other assets are out of scope.
  If the user asks about another asset, say so plainly.
- **ML signal is a probability, not a guarantee.** The model is well-
  calibrated but markets remain noisy. Frame predictions as "the model
  thinks X is more likely than Y", not "X will happen".

## Background

BPE (Bitcoin Pricing Engine) consolidates 36 exchanges into a single
normalised market-data feed with sub-100µs internal latency, plus
derived intelligence layers: a calibrated gradient-boosted ML model
trained on a broad engineered feature set, sentiment indicators
(Fear & Greed, news, mempool stress), and cross-venue funding /
basis analysis. Running in production for institutional users; the
MCP server exposes this as native agent tools.
