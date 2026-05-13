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

  // Header: explicit UTC timestamp so the caller can reason about staleness
  // and distinguish two briefings taken seconds apart.
  const ts = price.status === "fulfilled" && price.value?.timestamp_ms
    ? price.value.timestamp_ms
    : Date.now();
  lines.push(`As of ${formatIsoUtc(ts)}.`);

  // Price line
  if (price.status === "fulfilled" && price.value?.price) {
    const p = price.value;
    const venues = p.exchange_count ?? "?";
    const ageMs = p.timestamp_ms != null ? Math.max(0, Date.now() - p.timestamp_ms) : null;
    const ageStr = formatAge(ageMs);
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
  // In brief mode, show probability only (less confusing than dual
  // probability + confidence). In detailed mode, expose both labelled
  // for the quant-minded reader.
  if (preds.status === "fulfilled" && preds.value?.direction) {
    const p = preds.value;
    const horizon = p.horizon_secs != null ? `${p.horizon_secs}s` : "?";
    if (verbosity === "detailed") {
      const conf = p.confidence != null ? `, ${(p.confidence * 100).toFixed(0)}% model confidence` : "";
      const prob = p.probability != null ? `${(p.probability * 100).toFixed(0)}% probability` : "no probability";
      lines.push(`ML ${horizon}: ${p.direction} (${prob}${conf}).`);
      if (p.models?.length) {
        const detail = p.models
          .map((m) => `${m.name}${m.signal != null ? `=${m.signal.toFixed(3)}` : ""}`)
          .join(", ");
        lines.push(`  Sub-models: ${detail}.`);
      }
    } else {
      // Brief: pick the single most informative number (probability if
      // available, else confidence). Skip both labels to keep the line
      // short — agents can re-read the description if they want the math.
      const pct = p.probability ?? p.confidence;
      const pctStr = pct != null ? ` (${(pct * 100).toFixed(0)}% probability)` : "";
      lines.push(`ML ${horizon}: ${p.direction}${pctStr}.`);
    }
  }

  // Sentiment — FGI is always present when the upstream has any data;
  // FinBERT + Trends + composite are populated by separate scheduler
  // jobs and emitted only when their collectors have run.
  if (sent.status === "fulfilled") {
    const s = sent.value;
    const parts: string[] = [];
    if (s?.fear_greed_index != null) {
      parts.push(`F&G ${s.fear_greed_index}${s.fear_greed_label ? ` (${s.fear_greed_label})` : ""}`);
    }
    if (s?.finbert_score != null) {
      const sign = s.finbert_score > 0 ? "+" : "";
      parts.push(`news ${sign}${s.finbert_score.toFixed(2)}`);
    }
    if (s?.google_trends != null) {
      parts.push(`trends ${s.google_trends}/100`);
    }
    if (parts.length) {
      const composite = s?.composite_score != null
        ? ` → composite ${s.composite_score > 0 ? "+" : ""}${s.composite_score.toFixed(2)}`
        : "";
      lines.push(`Sentiment: ${parts.join(", ")}${composite}.`);
    }
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
    // 15% APR spread is already meaningful for perp-perp arb after fees +
    // borrow; raised noise floor above this would miss real opportunities.
    if (max - min > 0.15) return `funding spread ${formatPct(max - min)} APR — basis or perp-perp arb opportunity (long lowest, short highest).`;
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

// Age formatter shared between briefing and per-tool callers.
// Sub-100ms is reported as "live" — exact ms ("0 ms old") reads oddly to
// non-technical users and obscures that the data IS effectively realtime.
export function formatAge(ageMs: number | null): string {
  if (ageMs == null) return "fresh";
  if (ageMs < 100) return "live";
  if (ageMs < 1000) return `${ageMs} ms old`;
  return `${(ageMs / 1000).toFixed(1)}s old`;
}

// "2026-05-13 11:53:42 UTC" — readable, sortable, unambiguous.
export function formatIsoUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}
