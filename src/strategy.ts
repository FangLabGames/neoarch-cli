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
  throughputCap: bigint;
  missCount: number;
}

export interface LlmDecision {
  payloadPct: number;
  alphaPct: number;
  craftPct: number;
  swaps: SwapOrder[];
}

export type Strategy = "payload" | "balanced" | "craft";

const HUNDRED = 100n;

/// Three deterministic heuristic presets. Used as default when no API key is
/// set, and as fallback when the LLM call fails or hits the local spend cap.
///
/// Survival override: if the agent has missed any ticks OR is below a 2-tick
/// payload buffer (20 credits = 2× PAYLOAD_CONSUMPTION on the Arc/USDC 6dp
/// scale), dump 100% throughput into payload until recovered. Beats the
/// contract's built-in 70/30 fallback on the survival axis.
const PAYLOAD_SURVIVAL_THRESHOLD = 20n * 10n ** 6n; // 2× PAYLOAD_CONSUMPTION in 6dp USDC units

export function heuristicAction(
  snapshot: AgentSnapshot,
  strategy: Strategy,
  tick: number,
): AgentAction {
  const cap = snapshot.throughputCap;
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
      const alpha = (cap * 30n) / HUNDRED;
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
  const cap = snapshot.throughputCap;
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

  const swaps: SwapOrder[] = (decision.swaps ?? [])
    .filter((s) => s && typeof s === "object")
    .filter((s) => Number.isInteger(s.market) && s.market >= 0 && s.market <= 1)
    .filter((s) => Number.isInteger(s.kind) && s.kind >= 0 && s.kind <= 1)
    .filter((s) => typeof s.amount === "bigint" && s.amount >= 0n)
    .filter((s) => typeof s.limitAmount === "bigint" && s.limitAmount >= 0n)
    .slice(0, 3);

  return {
    ePayloadProd: payloadThroughput,
    eAlphaProd: alphaThroughput,
    eCraft: craftThroughput,
    swaps,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
