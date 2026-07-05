/// Commit-reveal helpers — keccak256-encode the action + salt, submit txs.
///
/// The commitment hash MUST be exactly:
///   keccak256(abi.encode(ePayloadProd, eAlphaProd, eCraft, swaps, swapCount, salt))
/// with swaps padded to a fixed-size [3] tuple. Mismatch reverts InvalidReveal().
///
/// Salt is 32 fresh random bytes per tick. Reusing salts across ticks isn't a
/// contract revert, but it's a privacy leak (third parties can correlate your
/// strategy across ticks).

import {
  encodeAbiParameters,
  keccak256,
  type Hex,
  type Address,
  type WalletClient,
} from "viem";
import { atrRoundAbi, arcTestnet } from "./abi.ts";

export interface SwapOrder {
  market: number;       // 0=PAYLOAD, 1=ALPHA
  kind: number;         // 0=SELL_A_FOR_B, 1=BUY_A_WITH_B, 2=ADD_LIQUIDITY, 3=REMOVE_LIQUIDITY (ECON-AMM-1)
  amount: bigint;       // amountIn (sell) / amountOut (buy) / goods offered (add) / shares to burn (remove)
  limitAmount: bigint;  // minOut (sell/remove) or max credits (buy/add); 0 = wallet-bounded on buy/add
}

export interface AgentAction {
  ePayloadProd: bigint;
  eAlphaProd: bigint;
  eCraft: bigint;
  swaps: SwapOrder[];   // length 0-3
}

const ACTION_TUPLE_TYPES = [
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
] as const;

const EMPTY_SWAP: SwapOrder = { market: 0, kind: 0, amount: 0n, limitAmount: 0n };

export function generateSalt(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return ("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")) as Hex;
}

function padSwaps(swaps: SwapOrder[]): { padded: SwapOrder[]; count: number } {
  const padded = swaps.slice(0, 3);
  while (padded.length < 3) padded.push(EMPTY_SWAP);
  return { padded, count: Math.min(swaps.length, 3) };
}

export function computeCommitment(action: AgentAction, salt: Hex): Hex {
  const { padded, count } = padSwaps(action.swaps);
  const encoded = encodeAbiParameters(ACTION_TUPLE_TYPES as any, [
    action.ePayloadProd,
    action.eAlphaProd,
    action.eCraft,
    padded,
    count,
    salt,
  ]);
  return keccak256(encoded);
}

export async function submitCommit(
  wallet: WalletClient,
  roundAddress: Address,
  commitment: Hex,
): Promise<Hex> {
  return await wallet.writeContract({
    address: roundAddress,
    abi: atrRoundAbi,
    functionName: "commitAction",
    args: [commitment],
    chain: arcTestnet,
  } as any);
}

export async function submitReveal(
  wallet: WalletClient,
  roundAddress: Address,
  action: AgentAction,
  salt: Hex,
): Promise<Hex> {
  const { padded, count } = padSwaps(action.swaps);
  return await wallet.writeContract({
    address: roundAddress,
    abi: atrRoundAbi,
    functionName: "revealAction",
    args: [
      action.ePayloadProd,
      action.eAlphaProd,
      action.eCraft,
      padded as any,
      count,
      salt,
    ],
    chain: arcTestnet,
  } as any);
}

/// @notice Arc/USDC migration: ATRRound's `_resolveRound` auto-pushes prizes
///         to survivors at resolution time via `_payoutOrDefer`. The only
///         pull-payment path is `claimDeferredPayout()` and it's used ONLY
///         when the auto-push transfer failed (e.g. contract recipient with
///         reverting fallback, USDC blacklist hit). Check `pendingPayouts`
///         before calling — if zero, you've already been paid.
export async function submitClaimDeferredPayout(
  wallet: WalletClient,
  roundAddress: Address,
): Promise<Hex> {
  return await wallet.writeContract({
    address: roundAddress,
    abi: atrRoundAbi,
    functionName: "claimDeferredPayout",
    chain: arcTestnet,
  } as any);
}
