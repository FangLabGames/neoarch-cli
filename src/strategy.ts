/// Strategy module — heuristic presets + validate-and-clamp for LLM output.
///
/// AgentSnapshot fields match the on-chain AgentState struct returned by the
/// round contract's `agents(yourAddress)` view function. See src/abi.ts.

import type { AgentAction, SwapOrder } from "./commit-reveal.ts";

export interface AgentSnapshot {
  alive: boolean;
  payload: bigint;
  /// USDC-backed internal credit balance (6 decimals). Mirrors the on-chain
  /// AgentState.credits field returned by the round contract's agents(addr) view.
  credits: bigint;
  alphaBalance: bigint;
  moduleTier: number;
  moduleDurability: bigint;
  /// Raw deficit-adjusted base cap from agents(addr) (display only).
  throughputCap: bigint;
  /// v1.14 (RV-CT-3): the throughput you may allocate THIS tick — the deficit base
  /// scaled by the live RegimePhase + Regime throughputMod and clamped to
  /// MAX_ENERGY_CAP, read verbatim from the round's throughputAllowance(addr) view so
  /// the reveal sums to exactly what the contract accepts. Falls back to throughputCap
  /// against pre-v1.14 rounds that lack the view.
  throughputAllowance: bigint;
  missCount: number;
}

/// LLM-decided module listing (sell side of the in-round module market).
/// Translates to ATRModuleMarket.listModule(round, minPriceCredits, duration)
/// — an English auction settled in IN-GAME CREDITS between agents of the same
/// round. Listing locks your module immediately (you lose its production
/// multiplier the same tick); one listing per round.
export interface WorkOrderIntent {
  kind: "module-listing";
  /// Reserve price in in-game credits, 6-decimal units.
  minPriceCredits: bigint;
  /// Auction window seconds; contract caps at 1h, runtime clamps further.
  durationSeconds: number;
}

/// LLM-decided bid on another agent's module auction (buy side). The LLM
/// names the auction + a CEILING; the runtime bids the minimum the contract
/// accepts (minPrice, or highBid + 5%) and never exceeds the ceiling. Bids
/// escrow from your in-game credits and auto-refund when outbid. You cannot
/// bid while you own a module (delivery would fail at settle) or on your own
/// listing.
export interface ModuleBidIntent {
  kind: "module-bid";
  auctionId: bigint;
  maxBidCredits: bigint;
}

export interface LlmDecision {
  payloadPct: number;
  alphaPct: number;
  craftPct: number;
  swaps: SwapOrder[];
  /// Optional — at most 1 per tick (and 1 listing per round).
  workOrders?: WorkOrderIntent[];
  /// Optional — at most 1 per tick.
  moduleBids?: ModuleBidIntent[];
}

export type Strategy = "payload" | "balanced" | "craft";

const HUNDRED = 100n;

/// Three deterministic heuristic presets. Used as default when no API key is
/// set, and as fallback when the LLM call fails or hits the local spend cap.
///
/// Survival override: if the agent has missed any ticks OR is below a 2-tick
/// payload buffer (2 credits = 2× PAYLOAD_CONSUMPTION on the Arc/USDC 6dp
/// scale), dump 100% throughput into payload until recovered. Beats the
/// contract's built-in 85/15 fallback on the survival axis.
const PAYLOAD_SURVIVAL_THRESHOLD = 2n * 10n ** 6n; // 2× PAYLOAD_CONSUMPTION (1e6) in 6dp USDC units

export function heuristicAction(
  snapshot: AgentSnapshot,
  strategy: Strategy,
  tick: number,
): AgentAction {
  const cap = snapshot.throughputAllowance;
  if (cap === 0n) {
    return { ePayloadProd: 0n, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
  }
  const survivalNeeded = snapshot.missCount > 0 || snapshot.payload < PAYLOAD_SURVIVAL_THRESHOLD;
  if (survivalNeeded) {
    return { ePayloadProd: cap, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
  }

  switch (strategy) {
    case "payload":
      return { ePayloadProd: cap, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
    case "balanced": {
      const alpha = (cap * 15n) / HUNDRED;
      const payload = cap - alpha;
      return { ePayloadProd: payload, eAlphaProd: alpha, eCraft: 0n, swaps: [] };
    }
    case "craft": {
      // Early game: fund the stockpile before investing in modules.
      if (tick < 5) {
        return { ePayloadProd: cap, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
      }
      const alpha = (cap * 25n) / HUNDRED;
      const craft = (cap * 25n) / HUNDRED;
      const payload = cap - alpha - craft;
      return { ePayloadProd: payload, eAlphaProd: alpha, eCraft: craft, swaps: [] };
    }
  }
}

/// Validate + clamp LLM output. Always returns a contract-legal action whose
/// throughput sums exactly to cap. Drops malformed swap entries silently.
export function validateAndClamp(
  decision: Partial<LlmDecision>,
  snapshot: AgentSnapshot,
): AgentAction {
  const cap = snapshot.throughputAllowance;
  if (cap === 0n) {
    return { ePayloadProd: 0n, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
  }

  let payloadPct = clamp(decision.payloadPct ?? 100, 0, 100);
  let alphaPct = clamp(decision.alphaPct ?? 0, 0, 100);
  let craftPct = clamp(decision.craftPct ?? 0, 0, 100);
  const total = payloadPct + alphaPct + craftPct;
  if (total === 0) {
    payloadPct = 100;
  } else if (Math.abs(total - 100) > 0.5) {
    const k = 100 / total;
    payloadPct *= k;
    alphaPct *= k;
    craftPct *= k;
  }

  // Convert to bigint throughput. Compute alpha + craft, derive payload as
  // remainder so the sum is exactly cap (matches contract invariant).
  const alphaThroughput = (cap * BigInt(Math.round(alphaPct * 100))) / 10_000n;
  const craftThroughput = (cap * BigInt(Math.round(craftPct * 100))) / 10_000n;
  const payloadThroughput = cap - alphaThroughput - craftThroughput;
  if (payloadThroughput < 0n) {
    return { ePayloadProd: cap, eAlphaProd: 0n, eCraft: 0n, swaps: [] };
  }

  // BUGFIX (ported from the managed runtime, 2026-05-27): JSON.parse on the
  // LLM response yields plain `number` for amount/limitAmount — the old
  // `typeof s.amount === "bigint"` filter silently dropped EVERY LLM swap,
  // so agents could never trade on the AMM. Coerce via toNonNegBigint.
  //
  // ECON-AMM-1 (ported from the managed runtime 2026-07-04, CLI-ECON-1):
  // kinds 2 (ADD_LIQUIDITY) + 3 (REMOVE_LIQUIDITY) accepted — agent LP through
  // the same commit-reveal batch. `limitAmount` semantics on the current impl:
  // sells = minOut (0 = accept any); buys + ADD = max credits (0 = bounded by
  // wallet); REMOVE = min credits out. Unsatisfiable orders are skipped
  // on-chain (batch-safe), never revert.
  const swaps: SwapOrder[] = [];
  for (const s of decision.swaps ?? []) {
    if (swaps.length >= 3) break;
    if (!s || typeof s !== "object") continue;
    const o = s as unknown as Record<string, unknown>;
    if (!Number.isInteger(o.market) || (o.market as number) < 0 || (o.market as number) > 1) continue;
    if (!Number.isInteger(o.kind) || (o.kind as number) < 0 || (o.kind as number) > 3) continue;
    const amount = toNonNegBigint(o.amount);
    if (amount === null || amount === 0n) continue;
    const limitAmount = toNonNegBigint(o.limitAmount) ?? 0n;
    swaps.push({ market: o.market as number, kind: o.kind as number, amount, limitAmount });
  }

  return {
    ePayloadProd: payloadThroughput,
    eAlphaProd: alphaThroughput,
    eCraft: craftThroughput,
    swaps,
  };
}

/// Coerce an LLM-emitted JSON value to a non-negative integer bigint, or null.
/// LLMs emit JSON `number` (never `bigint`) and sometimes digits-only strings.
/// Rejects NaN, Infinity, fractional, negative, scientific notation, objects.
export function toNonNegBigint(v: unknown): bigint | null {
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "number") {
    if (!Number.isFinite(v) || v < 0 || !Number.isInteger(v)) return null;
    return BigInt(v);
  }
  if (typeof v === "string") {
    if (!/^[0-9]+$/.test(v)) return null;
    try {
      return BigInt(v);
    } catch {
      return null;
    }
  }
  return null;
}

// ─── Module-market intent validation ───────────────────────────────

export const MIN_PRICE_CREDITS = 100_000n;     // 0.10 credits
export const MAX_PRICE_CREDITS = 100_000_000n; // 100 credits sanity cap
export const MIN_AUCTION_DURATION_SECONDS = 5 * 60;
export const MAX_AUCTION_DURATION_SECONDS = 3600; // ATRModuleMarket.MAX_DURATION

/// Sanitize workOrders (listings). At most 1 per tick; clamps price+duration.
export function validateWorkOrders(raw: unknown): WorkOrderIntent[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkOrderIntent[] = [];
  for (const w of raw) {
    if (out.length >= 1) break;
    if (!w || typeof w !== "object") continue;
    const obj = w as Record<string, unknown>;
    if (obj.kind !== "module-listing") continue;
    let price = toNonNegBigint(obj.minPriceCredits);
    if (price === null) continue;
    if (price < MIN_PRICE_CREDITS) price = MIN_PRICE_CREDITS;
    if (price > MAX_PRICE_CREDITS) price = MAX_PRICE_CREDITS;
    const durRaw = toNonNegBigint(obj.durationSeconds);
    if (durRaw === null) continue;
    const dur = Math.max(
      MIN_AUCTION_DURATION_SECONDS,
      Math.min(MAX_AUCTION_DURATION_SECONDS, Number(durRaw)),
    );
    out.push({ kind: "module-listing", minPriceCredits: price, durationSeconds: dur });
  }
  return out;
}

/// Sanitize moduleBids. At most 1 per tick; ceiling clamped to the sanity cap.
export function validateModuleBids(raw: unknown): ModuleBidIntent[] {
  if (!Array.isArray(raw)) return [];
  const out: ModuleBidIntent[] = [];
  for (const b of raw) {
    if (out.length >= 1) break;
    if (!b || typeof b !== "object") continue;
    const obj = b as Record<string, unknown>;
    if (obj.kind !== "module-bid") continue;
    const auctionId = toNonNegBigint(obj.auctionId);
    if (auctionId === null || auctionId === 0n) continue;
    let ceiling = toNonNegBigint(obj.maxBidCredits);
    if (ceiling === null || ceiling === 0n) continue;
    if (ceiling > MAX_PRICE_CREDITS) ceiling = MAX_PRICE_CREDITS;
    out.push({ kind: "module-bid", auctionId, maxBidCredits: ceiling });
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
