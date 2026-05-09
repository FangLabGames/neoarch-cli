/// Frozen ATRRound ABI for v1.5.3 (Base mainnet, May 2026).
///
/// This is the full surface the CLI calls — joinRound, commitAction,
/// revealAction, claimPrize, plus state-reading views. Pinning here means
/// the CLI keeps working even if the round contract is upgraded server-side
/// (you'd just need to bump this file's version when the on-chain ABI changes).

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
      { name: "tong", type: "uint256" },
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
    name: "tongToken",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/// Tong ERC-20 — only the bits we need for entry-fee approval + balance check.
export const tongAbi = [
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
export const TICK_DURATION_SEC = 300;
export const COMMIT_WINDOW_SEC = 180;
export const STARVATION_STEPS = 12;
export const ENTRY_FEE_TONG = 500n * 10n ** 18n; // 500 TONG with 18 decimals

export const ROUND_STATUS = {
  CREATED: 0,
  REGISTRATION: 1,
  ACTIVE: 2,
  RESOLVED: 3,
} as const;

export const HOSTING_MODE_LOCAL_CLI = 0;
