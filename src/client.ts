// Thin HTTP client for the BPE api-gateway. One file, no class hierarchy —
// each tool calls the channel it needs.
//
// Backend lives at the api-gateway (port 8082 in dev, https://mcp.bxetech.com
// in prod). Auth is an `X-API-Key` header — same key the dashboard / portal
// uses, supplied by the user via env or MCP server config.
//
// Why mcp.bxetech.com (not api.bxetech.com): the agent-facing endpoint is
// brand-separated from the (future) human-facing API SKU. Same backend
// today; lets us diverge later (dedicated MCP-shaped service, different
// rate-limit policy, etc.) without forcing customers to migrate.

const DEFAULT_BASE_URL = "https://mcp.bxetech.com";

export class BpeApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly endpoint?: string,
  ) {
    super(message);
    this.name = "BpeApiError";
  }
}

export class BpeClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: { baseUrl?: string; apiKey: string; timeoutMs?: number }) {
    this.baseUrl = (opts.baseUrl ?? process.env.BPE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  // GET /api/v1/<path>. Returns the unwrapped `data` payload from the
  // gateway's ApiEnvelope ({channel, seq, timestamp, snapshot, data}).
  // Throws BpeApiError on non-2xx, network failure, or timeout.
  async get<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}/api/v1/${path.replace(/^\//, "")}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { "X-API-Key": this.apiKey, Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new BpeApiError(
          `BPE API ${res.status} on /${path}: ${body.slice(0, 200)}`,
          res.status,
          path,
        );
      }
      const json = (await res.json()) as Record<string, unknown>;
      // Every gateway endpoint wraps in an ApiEnvelope. Unwrap `data` so
      // callers receive the channel-specific payload directly.
      if (json && typeof json === "object" && "data" in json) {
        return json.data as T;
      }
      return json as T;
    } catch (err) {
      if (err instanceof BpeApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new BpeApiError(`BPE API request failed on /${path}: ${msg}`, undefined, path);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Loose typings for the channels we touch in v0.1. Intentionally permissive —
// the api-gateway can add fields without breaking us.

// Fields match the api-gateway's /price channel. timestamp_ms is the
// upstream pricing-service tick time; age can be derived as
// `Date.now() - timestamp_ms`. exchange_count is the number of
// venues currently contributing to the consolidated price.
export interface PriceResponse {
  price: number;
  best_bid?: number;
  best_ask?: number;
  spread_bps?: number;
  confidence?: number;
  exchange_count?: number;
  sequence?: number;
  timestamp_ms?: number;
  symbol?: string;
}

export interface FundingRateEntry {
  exchange: string;
  funding_rate: number;
  next_funding_time?: number;
  annualized_rate?: number;
}

export interface DerivativesResponse {
  funding_rates?: FundingRateEntry[];
  open_interest?: Array<{ exchange: string; oi_btc: number; oi_usd?: number }>;
  timestamp_ms?: number;
}

// The /predictions endpoint and the briefing.predictions sub-key both
// return a single snapshot of the most recent prediction — whatever
// horizon the upstream pricing-service most recently emitted. Multi-
// horizon support would require the api-gateway to maintain separate
// cache slots per horizon, which it doesn't today. Until then, agents
// asking for a specific horizon may get back a different one; we
// surface that explicitly in the tool response.
export interface PredictionsResponse {
  horizon_secs?: number;
  direction?: "up" | "down" | "flat";
  probability?: number;
  confidence?: number;
  signal?: number;
  risk_adjusted_signal?: number;
  position_scale?: number;
  volatility_forecast?: number;
  models?: Array<{ name: string; signal?: number; confidence?: number }>;
  timestamp_ms?: number;
}

// Mirrors the api-gateway SentimentUpdate wire format. Only
// fear_greed_{index,label} are guaranteed; the rest are populated by the
// FinBERT + Google Trends scheduler tasks and may be absent ("collector
// hasn't run yet") rather than zero ("genuinely neutral"). The composite
// is only emitted by the server when BOTH FinBERT and Trends are
// present, so a partial weighting doesn't masquerade as a complete one.
export interface SentimentResponse {
  fear_greed_index?: number;
  fear_greed_label?: string;
  finbert_score?: number;        // -1 to +1, FinBERT on news/social text
  finbert_label?: string;        // "Bearish" | "Neutral" | "Bullish"
  google_trends?: number;        // 0-100, Google Trends interest for "bitcoin"
  composite_score?: number;      // -1 to +1, 40% FGI + 40% FinBERT + 20% trends
  timestamp_ms?: number;
}
