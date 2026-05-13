// MCP tool registrations.
//
// v0.1 ships 4 tools (functions 1, 2, 3, 5 from the research note's §3.1):
//   get_consolidated_price — current consolidated BTC price
//   get_market_briefing    — natural-language synthesis of 4 channels
//   get_funding_skew       — cross-venue funding rates + max-spread pair
//   get_ml_signal          — current ML prediction for a given horizon
//
// Stretch (v0.2): get_basis, get_sentiment_snapshot, subscribe_alert.

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BpeApiError,
  type BpeClient,
  type DerivativesResponse,
  type PredictionsResponse,
  type PriceResponse,
  type SentimentResponse,
} from "./client.js";
import { buildBriefing } from "./briefing.js";
import { formatAge } from "./briefing.js";

// All tools return a single text content block. Returning structured JSON
// would also work, but text is the most agent-portable shape — every model
// handles it natively, and we can always graduate to structured output later.
function asText(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function asError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

// Translate API errors into actionable messages a calling agent (or human
// reading the agent's transcript) can act on. Recognises the common HTTP
// status codes and emits an upgrade / retry / config hint instead of a raw
// stack-trace-shaped string.
function friendlyError(err: unknown, channel?: string): string {
  if (err instanceof BpeApiError) {
    if (err.status === 401) {
      return "Invalid or missing API key. Set BPE_API_KEY in your MCP client config (see https://github.com/bxetech/bpe-mcp#install) or request one at https://bxetech.com/contact.";
    }
    if (err.status === 403) {
      const ch = channel ? ` (requires the '${channel}' channel)` : "";
      return `This tool needs Agent tier or higher${ch}. Free tier does not include it — see https://bxetech.com/agents for plans, or contact contact@bxetech.com to upgrade.`;
    }
    if (err.status === 429) {
      return "Rate limit exceeded. Wait a few seconds and retry, or upgrade your tier at https://bxetech.com/agents for higher limits.";
    }
    if (err.status && err.status >= 500) {
      return `BPE backend error (${err.status}). Try again in a moment. If this persists, email contact@bxetech.com.`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export function registerTools(server: McpServer, client: BpeClient): void {
  // ── 1. get_consolidated_price ────────────────────────────────────────────
  server.tool(
    "get_consolidated_price",
    "Get the current consolidated Bitcoin price aggregated across the BPE exchange network. Returns price in USD, the number of contributing exchanges, and freshness in milliseconds. Use this when an agent or user asks 'what's the BTC price right now?' — it's faster and more authoritative than calling any individual exchange.",
    {
      symbol: z
        .enum(["BTC-USD"])
        .default("BTC-USD")
        .describe("Trading pair. Currently only BTC-USD is supported."),
    },
    async ({ symbol }) => {
      try {
        const r = await client.get<PriceResponse>("price");
        const venues = r.exchange_count ?? "?";
        const ageMs = r.timestamp_ms != null ? Math.max(0, Date.now() - r.timestamp_ms) : null;
        const ageStr = formatAge(ageMs);
        const lines = [`${symbol}: $${formatPrice(r.price)}`];
        if (r.best_bid != null && r.best_ask != null) {
          lines.push(`Bid/Ask: $${formatPrice(r.best_bid)} / $${formatPrice(r.best_ask)}` +
            (r.spread_bps != null ? ` (${r.spread_bps.toFixed(1)} bps spread)` : ""));
        }
        lines.push(`Source: ${venues} exchanges contributing, ${ageStr}` +
          (r.confidence != null ? `, confidence ${(r.confidence * 100).toFixed(0)}%` : "") + ".");
        return asText(lines.join("\n"));
      } catch (err) {
        return asError(`Failed to fetch consolidated price: ${friendlyError(err, "price")}`);
      }
    },
  );

  // ── 2. get_market_briefing ───────────────────────────────────────────────
  server.tool(
    "get_market_briefing",
    "Get a concise natural-language summary of the current Bitcoin market state. Synthesises consolidated price, funding-rate skew across major perpetual venues, current ML prediction, and sentiment indicators. 'brief' mode returns roughly 4 lines (price, funding skew, ML signal, sentiment); 'detailed' adds per-venue funding breakdown and ML sub-model details — typically 6-8 lines. This is the most token-efficient way for an agent to get the 'what's happening right now' picture — replaces 4-5 raw data calls plus the reasoning to summarise them.",
    {
      verbosity: z
        .enum(["brief", "detailed"])
        .default("brief")
        .describe("'brief' returns a 5-line headline summary; 'detailed' adds per-venue and multi-horizon breakdowns."),
    },
    async ({ verbosity }) => {
      try {
        const briefing = await buildBriefing(client, verbosity);
        return asText(briefing);
      } catch (err) {
        return asError(`Failed to build market briefing: ${friendlyError(err, "predictions+sentiment+derivatives")}`);
      }
    },
  );

  // ── 3. get_funding_skew ──────────────────────────────────────────────────
  server.tool(
    "get_funding_skew",
    "Get current perpetual-futures funding rates across major venues, plus the max-spread pair. Annualised. Useful for assessing perp-perp arbitrage conditions, basis trades, and overall positioning skew — high spread = stretched positioning on one side. Returns a sorted table.",
    {},
    async () => {
      try {
        const r = await client.get<DerivativesResponse>("derivatives");
        const rates = (r.funding_rates ?? [])
          .map((f) => ({
            ex: f.exchange,
            ann: f.annualized_rate ?? f.funding_rate * 3 * 365,
          }))
          .filter((r) => Number.isFinite(r.ann))
          .sort((a, b) => b.ann - a.ann);

        if (!rates.length) {
          return asError("No funding rate data available right now.");
        }

        const top = rates[0]!;
        const bot = rates[rates.length - 1]!;
        const spread = top.ann - bot.ann;

        const lines: string[] = [];
        lines.push(`Funding spread: ${formatPct(spread)} APR (${top.ex} ↔ ${bot.ex})`);
        lines.push("");
        lines.push("Per-venue annualised funding rates:");
        for (const r of rates) {
          lines.push(`  ${r.ex.padEnd(20)} ${formatPct(r.ann)}`);
        }
        return asText(lines.join("\n"));
      } catch (err) {
        return asError(`Failed to fetch funding skew: ${friendlyError(err, "derivatives")}`);
      }
    },
  );

  // ── 4. get_ml_signal ─────────────────────────────────────────────────────
  server.tool(
    "get_ml_signal",
    "Get the current ML prediction for a specified time horizon. Returns direction (up/down/flat), confidence (0-1), and detected market regime (low/medium/high volatility). The model is a calibrated gradient-boosted classifier trained on a broad feature set including order book imbalance, cross-exchange spreads, sentiment, derivatives, and momentum.",
    {
      horizon: z
        .enum(["30s", "60s", "5m"])
        .default("30s")
        .describe("Prediction horizon. Shorter horizons are more reactive; longer horizons are more stable. Available horizons may evolve over time — the tool will report which horizons are currently served if a requested one is unavailable."),
    },
    async ({ horizon }) => {
      try {
        const requestedSecs = horizon === "30s" ? 30 : horizon === "60s" ? 60 : 300;
        const r = await client.get<PredictionsResponse>("predictions");

        if (r.direction == null && r.signal == null) {
          return asError("No ML prediction currently available — try again in a few seconds.");
        }

        const lines: string[] = [];
        const servedSecs = r.horizon_secs ?? null;
        if (servedSecs != null && servedSecs !== requestedSecs) {
          lines.push(`Note: requested ${horizon} horizon, server returned ${servedSecs}s (only one horizon is cached at a time in v0.1).`);
        }
        lines.push(`Horizon: ${servedSecs != null ? servedSecs + "s" : horizon}`);
        if (r.direction) lines.push(`Direction: ${r.direction}`);
        if (r.probability != null) {
          lines.push(`Probability: ${(r.probability * 100).toFixed(1)}%`);
        }
        if (r.confidence != null) {
          lines.push(`Confidence: ${(r.confidence * 100).toFixed(1)}%`);
        }
        if (r.signal != null) lines.push(`Signal: ${r.signal.toFixed(4)}`);
        if (r.risk_adjusted_signal != null) {
          lines.push(`Risk-adjusted signal: ${r.risk_adjusted_signal.toFixed(4)}`);
        }
        if (r.position_scale != null) {
          lines.push(`Position scale: ${r.position_scale.toFixed(2)}`);
        }
        if (r.volatility_forecast != null) {
          lines.push(`Volatility forecast: ${r.volatility_forecast.toFixed(4)}`);
        }
        if (r.models?.length) {
          const summaries = r.models.map((m) =>
            `${m.name}=${m.signal != null ? m.signal.toFixed(3) : "?"}` +
            (m.confidence != null ? `@${(m.confidence * 100).toFixed(0)}%` : ""),
          );
          lines.push(`Sub-models: ${summaries.join(", ")}`);
        }
        return asText(lines.join("\n"));
      } catch (err) {
        return asError(`Failed to fetch ML signal: ${friendlyError(err, "predictions")}`);
      }
    },
  );

  // ── 5. get_sentiment_snapshot ───────────────────────────────────────────
  server.tool(
    "get_sentiment_snapshot",
    "Get current Bitcoin market sentiment indicators: Crypto Fear & Greed index (0-100, with label like 'Fear' / 'Neutral' / 'Greed'), news sentiment (-1 most bearish to +1 most bullish), and mempool stress (0 calm to 1 highly congested). Useful for contextualising price action, detecting positioning extremes that may precede reversals, and as a coarse macro filter for shorter-horizon ML signals.",
    {},
    async () => {
      try {
        const r = await client.get<SentimentResponse>("sentiment");
        const lines: string[] = [];
        if (r.fear_greed_index != null) {
          lines.push(
            `Fear & Greed: ${r.fear_greed_index}/100` +
              (r.fear_greed_label ? ` (${r.fear_greed_label})` : ""),
          );
        }
        if (r.news_sentiment != null) {
          const sign = r.news_sentiment > 0 ? "+" : "";
          lines.push(`News sentiment: ${sign}${r.news_sentiment.toFixed(2)} (range -1 to +1)`);
        }
        if (r.mempool_stress != null) {
          lines.push(`Mempool stress: ${r.mempool_stress.toFixed(2)} (range 0 to 1)`);
        }
        if (!lines.length) {
          return asError("No sentiment data currently available — try again in a few seconds.");
        }
        return asText(lines.join("\n"));
      } catch (err) {
        return asError(`Failed to fetch sentiment: ${friendlyError(err, "sentiment")}`);
      }
    },
  );
}

function formatPrice(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

function formatPct(frac: number): string {
  return `${(frac * 100).toFixed(2)}%`;
}
