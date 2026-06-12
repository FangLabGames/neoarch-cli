/// Prediction-market helpers — bet on agents with USDC (v0.5.0).
///
/// One ATRMarket contract per round (address from `round.market()`), one CPMM
/// market per agent inside it: "will this agent be alive at round end?".
/// Buys take (agent, usdcIn, minOut); a 2% fee is skimmed on entry (default
/// buyFeeBps=200; ¼ to the agent's creator, ¾ to treasury) and the net amount
/// mints YES+NO then swaps the unwanted side through the pool. Winners split
/// the post-rake losing-side backing at resolution; cancelled rounds refund
/// pro-rata. Self-NO is contract-forbidden (anti-throwing).
///
/// Bets are ONE transaction via EIP-2612 permit (Arc USDC domain version "2"),
/// exactly like the website.

import {
  parseAbi,
  parseSignature,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export const marketAbi = parseAbi([
  "function markets(address agent) view returns (uint256 yesReserve, uint256 noReserve, uint256 totalBacking, uint256 totalYesOut, uint256 totalNoOut, uint8 outcome, bool seeded, bool finalized)",
  "function yesBalance(address agent, address punter) view returns (uint256)",
  "function noBalance(address agent, address punter) view returns (uint256)",
  "function claimed(address agent, address punter) view returns (bool)",
  "function tradingDeadline() view returns (uint256)",
  "function buyFeeBps() view returns (uint16)",
  "function buyYesWithPermit(address agent, uint256 usdcIn, uint256 minOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)",
  "function buyNoWithPermit(address agent, uint256 usdcIn, uint256 minOut, uint256 deadline, uint8 v, bytes32 r, bytes32 s) returns (uint256)",
  "function claim(address agent) returns (uint256)",
  "function claimRefund(address agent) returns (uint256)",
]);

export const usdcPermitAbi = parseAbi([
  "function nonces(address owner) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);

export const OUTCOME = ["UNRESOLVED", "YES", "NO", "REFUND"] as const;

export interface MarketView {
  agent: Address;
  yesReserve: bigint;
  noReserve: bigint;
  totalBacking: bigint;
  outcome: number;
  seeded: boolean;
  myYes: bigint;
  myNo: bigint;
  claimed: boolean;
}

/// Implied YES probability in basis points (CPMM: price of YES rises as its
/// reserve shrinks, so P(yes) = noReserve / (yesReserve + noReserve)).
export function yesProbBps(m: { yesReserve: bigint; noReserve: bigint }): number {
  const denom = m.yesReserve + m.noReserve;
  if (denom === 0n) return 5000;
  return Number((m.noReserve * 10_000n) / denom);
}

/// Off-chain replica of ATRMarket._buy so we can show a quote and set a real
/// minOut (slippage guard) instead of 0.
export function quoteBuy(
  m: { yesReserve: bigint; noReserve: bigint },
  usdcIn: bigint,
  isYes: boolean,
  feeBps: number,
): bigint {
  const net = usdcIn - (usdcIn * BigInt(feeBps)) / 10_000n;
  if (isYes) {
    const newNo = m.noReserve + net;
    const newYes = (m.yesReserve * m.noReserve) / newNo;
    return net + (m.yesReserve - newYes);
  }
  const newYes = m.yesReserve + net;
  const newNo = (m.yesReserve * m.noReserve) / newYes;
  return net + (m.noReserve - newNo);
}

export async function readMarketView(
  publicClient: PublicClient,
  market: Address,
  agent: Address,
  punter: Address,
): Promise<MarketView> {
  const [m, myYes, myNo, isClaimed] = await Promise.all([
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "markets", args: [agent] }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "yesBalance", args: [agent, punter] }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "noBalance", args: [agent, punter] }),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "claimed", args: [agent, punter] }),
  ]);
  const [yesReserve, noReserve, totalBacking, , , outcome, seeded] = m as readonly [
    bigint, bigint, bigint, bigint, bigint, number, boolean, boolean,
  ];
  return {
    agent,
    yesReserve,
    noReserve,
    totalBacking,
    outcome: Number(outcome),
    seeded,
    myYes: myYes as bigint,
    myNo: myNo as bigint,
    claimed: isClaimed as boolean,
  };
}

/// Sign the EIP-2612 permit for the market to pull `value` USDC, then return
/// the (deadline, v, r, s) tuple for buyYes/NoWithPermit. Arc USDC (Circle)
/// uses EIP-712 domain version "2" — version "1" produces an invalid sig that
/// the contract's try/catch swallows, surfacing as a plain revert.
export async function signUsdcPermit(
  publicClient: PublicClient,
  walletClient: WalletClient,
  usdc: Address,
  owner: Address,
  spender: Address,
  value: bigint,
  chainId: number,
): Promise<{ deadline: bigint; v: number; r: Hex; s: Hex }> {
  const nonce = (await publicClient.readContract({
    address: usdc,
    abi: usdcPermitAbi,
    functionName: "nonces",
    args: [owner],
  })) as bigint;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await walletClient.signTypedData({
    account: walletClient.account!,
    domain: { name: "USDC", version: "2", chainId, verifyingContract: usdc },
    types: {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "Permit",
    message: { owner, spender, value, nonce, deadline },
  });
  const { v, r, s } = parseSignature(signature);
  return { deadline, v: Number(v ?? 27n), r, s };
}
