// Briefing endpoint synthesiser.
//
// v0.1 strategy: call the api-gateway's bundled /briefing endpoint, which
// returns price + derivatives + predictions + sentiment in a single
// envelope. Fold into a deterministic natural-language template. No LLM
// involved — that's a v0.2 upgrade if we want richer summaries.
//
// Why deterministic first:
//  - zero per-call cost, no LLM dependency
//  - predictable output shape (easier for downstream agents to parse)
//  - we can A/B against an LLM-rendered version later
//
// Why the bundled endpoint vs 4 separate calls:
//  - 1 rate-limit token per briefing (was 4)
//  - 1 HTTP round-trip (was 4)
//  - server filters by tier permissions, so Free callers receive a
//    partial bundle (graceful degradation) rather than 4× 403s
//  - underlying channels are read from the gateway's in-memory cache,
//    so freshness is identical to the per-channel endpoints

import type {
  BpeClient,
  DerivativesResponse,
  PredictionsResponse,
  PriceResponse,
  SentimentResponse,
} from "./client.js";

interface BriefingBundle {
  price?: PriceResponse;
  derivatives?: DerivativesResponse;
  predictions?: PredictionsResponse;
  sentiment?: SentimentResponse;
  _included_channels?: string[];
}

export type BriefingVerbosity = "brief" | "detailed";

export async function buildBriefing(
  client: BpeClient,
  verbosity: BriefingVerbosity,
): Promise<string> {
  // Single bundled call — replaces the 4-channel fan-out.
  let bundle: BriefingBundle;
  try {
    bundle = await client.get<BriefingBundle>("briefing");
  } catch {
    bundle = {};
  }
  // Re-pack as Promise.allSettled-shaped results so the rest of the
  // synthesis code can stay unchanged.
  const wrap = <T>(v: T | undefined): PromiseSettledResult<T> =>
    v != null
      ? { status: "fulfilled", value: v }
      : { status: "rejected", reason: new Error("not in bundle") };
  const price = wrap(bundle.price);
  const derivs = wrap(bundle.derivatives);
  const preds = wrap(bundle.predictions);
  const sent = wrap(bundle.sentiment);

  const lines: string[] = [];

  // Price line
  if (price.status === "fulfilled" && price.value?.price) {
    const p = price.value;
    const venues = p.exchange_count ?? "?";
    const ageMs = p.timestamp_ms != null ? Math.max(0, Date.now() - p.timestamp_ms) : null;
    const ageStr = ageMs == null ? "fresh" : ageMs < 1000 ? `${ageMs} ms old` : `${(ageMs / 1000).toFixed(1)}s old`;
    lines.push(`BTC: $${formatPrice(p.price)} (consolidated across ${venues} exchanges, ${ageStr}).`);
  } else {
    lines.push("BTC price: unavailable.");
  }

  // Funding skew
  if (derivs.status === "fulfilled" && derivs.value?.funding_rates?.length) {
    const rates = derivs.value.funding_rates
      .filter((r) => Number.isFinite(r.annualized_rate ?? r.funding_rate * 3 * 365))
      .map((r) => ({
        ex: r.exchange,
        ann: r.annualized_rate ?? r.funding_rate * 3 * 365,
      }));
    if (rates.length >= 2) {
      rates.sort((a, b) => b.ann - a.ann);
      const top = rates[0]!;
      const bot = rates[rates.length - 1]!;
      const spread = top.ann - bot.ann;
      lines.push(
        `Funding skew: ${top.ex} ${formatPct(top.ann)} APR vs ${bot.ex} ${formatPct(bot.ann)} APR — spread ${formatPct(spread)} APR.`,
      );
      if (verbosity === "detailed") {
        const detail = rates
          .slice(0, 6)
          .map((r) => `${r.ex} ${formatPct(r.ann)}`)
          .join(", ");
        lines.push(`  All venues: ${detail}.`);
      }
    }
  }

  // ML signal — server returns a single prediction snapshot (whichever
  // horizon the upstream pricing-service most recently emitted).
  if (preds.status === "fulfilled" && preds.value?.direction) {
    const p = preds.value;
    const horizon = p.horizon_secs != null ? `${p.horizon_secs}s` : "?";
    const conf = p.confidence != null ? ` (${(p.confidence * 100).toFixed(0)}% confidence)` : "";
    const prob = p.probability != null ? `, p=${(p.probability * 100).toFixed(0)}%` : "";
    lines.push(`ML ${horizon}: ${p.direction}${conf}${prob}.`);
    if (verbosity === "detailed" && p.models?.length) {
      const detail = p.models
        .map((m) => `${m.name}${m.signal != null ? `=${m.signal.toFixed(3)}` : ""}`)
        .join(", ");
      lines.push(`  Sub-models: ${detail}.`);
    }
  }

  // Sentiment
  if (sent.status === "fulfilled") {
    const s = sent.value;
    const parts: string[] = [];
    if (s?.fear_greed_index != null) {
      parts.push(`F&G ${s.fear_greed_index}${s.fear_greed_label ? ` (${s.fear_greed_label})` : ""}`);
    }
    if (s?.news_sentiment != null) parts.push(`news ${s.news_sentiment.toFixed(2)}`);
    if (s?.mempool_stress != null) parts.push(`mempool ${s.mempool_stress.toFixed(2)}`);
    if (parts.length) lines.push(`Sentiment: ${parts.join(", ")}.`);
  }

  // Anomaly hint — only thing computed locally (over the data we just pulled)
  const anomaly = detectAnomaly(derivs, preds);
  if (anomaly) lines.push(`Anomaly: ${anomaly}`);

  return lines.join("\n");
}

// Cheap heuristics — flag obvious abnormalities so the agent doesn't have to
// reason them out.
function detectAnomaly(
  derivs: PromiseSettledResult<DerivativesResponse>,
  preds: PromiseSettledResult<PredictionsResponse>,
): string | null {
  if (derivs.status === "fulfilled" && derivs.value?.funding_rates) {
    const ann = derivs.value.funding_rates
      .map((r) => r.annualized_rate ?? r.funding_rate * 3 * 365)
      .filter((x) => Number.isFinite(x));
    const max = ann.length ? Math.max(...ann) : 0;
    const min = ann.length ? Math.min(...ann) : 0;
    if (max - min > 0.25) return `funding spread ${formatPct(max - min)} APR (>25% — basis or perp-perp arb opportunity).`;
    if (Math.abs(max) > 0.5) return `extreme funding ${formatPct(max)} APR — perp positioning stretched.`;
  }
  if (preds.status === "fulfilled" && preds.value?.direction) {
    const p = preds.value;
    if ((p.confidence ?? 0) > 0.85) {
      const horizon = p.horizon_secs != null ? `${p.horizon_secs}s` : "current";
      return `ML confidence ${(p.confidence! * 100).toFixed(0)}% on ${horizon} horizon (${p.direction}).`;
    }
  }
  return null;
}

function formatPrice(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

function formatPct(frac: number): string {
  return `${(frac * 100).toFixed(2)}%`;
}
