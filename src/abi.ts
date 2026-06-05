/// Frozen ATRRound ABI for the Arc Testnet deployment (chain 5042002).
///
/// This is the full surface the CLI calls — joinRound, commitAction,
/// revealAction, claimPrize, plus state-reading views. Pinning here means
/// the CLI keeps working even if the round contract is upgraded server-side
/// (you'd just need to bump this file's version when the on-chain ABI changes).

import { defineChain } from "viem";

/// Arc Testnet — the chain this CLI transacts on. Native gas = USDC (6dp).
/// Using viem's `base` (chainId 8453) here would sign txs that Arc (5042002)
/// rejects. Import this everywhere a viem client needs a chain.
export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

export const atrRoundAbi = [
  // ─── Lifecycle (writes) ───────────────────────────────────────────
  {
    type: "function",
    name: "joinRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strategyHash", type: "bytes32" },
      { name: "hostingMode", type: "uint8" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "commitAction",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "revealAction",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ePayloadProd", type: "uint256" },
      { name: "eAlphaProd", type: "uint256" },
      { name: "eCraft", type: "uint256" },
      {
        name: "swaps",
        type: "tuple[3]",
        components: [
          { name: "market", type: "uint8" },
          { name: "kind", type: "uint8" },
          { name: "amount", type: "uint256" },
          { name: "limitAmount", type: "uint256" },
        ],
      },
      { name: "swapCount", type: "uint8" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "claimPrize",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },

  // ─── State (views) ────────────────────────────────────────────────
  {
    type: "function",
    name: "agents",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "alive", type: "bool" },
      { name: "payload", type: "uint256" },
      { name: "credits", type: "uint256" },
      { name: "alphaBalance", type: "uint256" },
      { name: "moduleTier", type: "uint8" },
      { name: "moduleDurability", type: "uint256" },
      { name: "throughputCap", type: "uint256" },
      { name: "missCount", type: "uint8" },
      { name: "craftProgress", type: "uint256" },
      { name: "entryTick", type: "uint256" },
      { name: "regime", type: "uint8" },
      { name: "strategyHash", type: "bytes32" },
      { name: "hostingMode", type: "uint8" },
    ],
  },
  {
    // v1.14 (RV-CT-3): the regime/phase-modified, MAX_ENERGY_CAP-clamped throughput
    // you may allocate this tick. revealAction validates against THIS — allocate
    // against it, not the raw throughputCap.
    type: "function",
    name: "throughputAllowance",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "currentTick",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lastTickTimestamp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "roundStatus",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }], // 0=CREATED 1=REGISTRATION 2=ACTIVE 3=RESOLVED
  },
  {
    type: "function",
    name: "regimePhaseOrder",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "regimePhaseTicksRemaining",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "usdc",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "pendingPayouts",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "claimDeferredPayout",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "amount", type: "uint256" }],
  },
  {
    type: "function",
    name: "tickDuration",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "commitWindow",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/// USDC ERC-20 — only the bits we need for entry-fee approval + balance check.
/// Same name kept (`usdcAbi`) — the underlying ABI for any ERC-20 is identical.
export const usdcAbi = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── Game constants ───────────────────────────────────────────────
// v1.6 FALLBACK defaults only — the CLI reads tickDuration()/commitWindow() from the
// round contract at boot (timing is per-round). These apply only if that read fails.
export const TICK_DURATION_SEC = 60;
export const COMMIT_WINDOW_SEC = 36;
export const DEFICIT_STEPS = 12; // was STARVATION_STEPS under v1.5 ontology
export const STARVATION_STEPS = DEFICIT_STEPS; // back-compat alias; remove in v0.3
export const ENTRY_FEE_USDC = 10n * 10n ** 6n; // 10 USDC with 6 decimals (v1.6 10x-down rescale)

export const ROUND_STATUS = {
  CREATED: 0,
  REGISTRATION: 1,
  ACTIVE: 2,
  RESOLVED: 3,
} as const;

export const HOSTING_MODE_LOCAL_CLI = 0;
