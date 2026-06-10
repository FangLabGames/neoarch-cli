/// ATRModuleMarket executor — the in-round module trading loop (Path A).
///
/// Sell side: list your crafted module (English auction, in-game credits).
/// Buy side: bid on rivals' listings — proxy-style: the LLM gives a CEILING,
/// we bid the minimum the contract accepts (reserve, or highBid + 5%).
/// Settlement: `settle(auctionId)` is permissionless after the deadline; we
/// call it for any auction we're seller or high bidder of, so the module /
/// proceeds arrive without waiting for the keeper's 5-minute backup sweep.
///
/// Everything here is best-effort: a revert is logged and the game loop
/// carries on — module trading must never cost you a commit/reveal.

import type { Address, PublicClient, WalletClient } from "viem";
import {
  arcTestnet,
  moduleMarketAbi,
  MODULE_MARKET_ADDRESS,
  MODULE_MARKET_MIN_INCREMENT_BPS,
  MODULE_MARKET_MAX_DURATION_SEC,
} from "./abi.ts";
import type { AgentSnapshot, WorkOrderIntent, ModuleBidIntent } from "./strategy.ts";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

/// How many auction ids to look back from nextAuctionId. One round runs at a
/// time and each agent lists at most once per round, so a small window
/// always covers the live book.
const SCAN_WINDOW = 24;
const MAX_AUCTIONS_IN_PROMPT = 5;
/// Keep listings clear of the round end — a straddling auction abandons the
/// escrowed high bid into the round pot.
const LISTING_SAFETY_MARGIN_SEC = 120;

export interface OpenAuction {
  auctionId: bigint;
  seller: Address;
  tier: number;
  durability: bigint;
  minPrice: bigint;
  highBid: bigint;
  weLead: boolean;
  ours: boolean;
  minNextBid: bigint;
  secondsLeft: number;
  endTime: bigint;
}

export function computeRequiredBid(minPrice: bigint, highBid: bigint, hasLeader: boolean): bigint {
  if (!hasLeader) return minPrice;
  return highBid + (highBid * MODULE_MARKET_MIN_INCREMENT_BPS) / 10000n;
}

/// Scan the market for this round's auctions (open OR just-ended-unsettled —
/// the latter so settleDueAuctions can finalize them).
export async function scanAuctions(
  publicClient: PublicClient,
  roundAddress: Address,
  agentAddress: Address,
): Promise<OpenAuction[]> {
  try {
    const next = (await publicClient.readContract({
      address: MODULE_MARKET_ADDRESS,
      abi: moduleMarketAbi,
      functionName: "nextAuctionId",
    })) as bigint;
    if (next <= 1n) return [];

    const newest = next - 1n;
    const oldest = newest >= BigInt(SCAN_WINDOW) ? newest - BigInt(SCAN_WINDOW) + 1n : 1n;
    const ids: bigint[] = [];
    for (let id = newest; id >= oldest; id--) ids.push(id);

    const rows = await Promise.all(
      ids.map((id) =>
        publicClient
          .readContract({
            address: MODULE_MARKET_ADDRESS,
            abi: moduleMarketAbi,
            functionName: "listings",
            args: [id],
          })
          .then((r) => ({ id, row: r as readonly [Address, Address, number, bigint, bigint, bigint, Address, bigint, boolean] }))
          .catch(() => null),
      ),
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const result: OpenAuction[] = [];
    for (const entry of rows) {
      if (!entry) continue;
      const [round, seller, tier, durability, minPrice, endTime, highBidder, highBid, settled] = entry.row;
      if (round.toLowerCase() !== roundAddress.toLowerCase()) continue;
      if (settled) continue;
      const hasLeader = highBidder !== ZERO_ADDR;
      result.push({
        auctionId: entry.id,
        seller,
        tier,
        durability,
        minPrice,
        highBid,
        weLead: hasLeader && highBidder.toLowerCase() === agentAddress.toLowerCase(),
        ours: seller.toLowerCase() === agentAddress.toLowerCase(),
        minNextBid: computeRequiredBid(minPrice, highBid, hasLeader),
        secondsLeft: Number(endTime) - nowSec,
        endTime,
      });
    }
    return result;
  } catch {
    return [];
  }
}

/// Auctions worth surfacing to the LLM as bid targets: open, not ours,
/// excluding anything about to close.
export function bidTargets(auctions: OpenAuction[]): OpenAuction[] {
  return auctions
    .filter((a) => a.secondsLeft > 30 && !a.ours)
    .slice(0, MAX_AUCTIONS_IN_PROMPT);
}

/// List our module. Returns the tx hash or null on skip/failure.
export async function dispatchListing(
  walletClient: WalletClient,
  publicClient: PublicClient,
  roundAddress: Address,
  agentAddress: Address,
  intent: WorkOrderIntent,
  snapshot: AgentSnapshot,
  remainingRoundSec: number,
): Promise<string | null> {
  if (snapshot.moduleTier === 0) return null; // nothing to sell
  try {
    const existing = (await publicClient.readContract({
      address: MODULE_MARKET_ADDRESS,
      abi: moduleMarketAbi,
      functionName: "activeAuctionOf",
      args: [roundAddress, agentAddress],
    })) as bigint;
    if (existing !== 0n) return null; // already listed this round

    const maxAllowed = Math.min(
      MODULE_MARKET_MAX_DURATION_SEC,
      Math.max(0, remainingRoundSec - LISTING_SAFETY_MARGIN_SEC),
    );
    const duration = Math.min(intent.durationSeconds, maxAllowed);
    if (duration < 60) return null; // too close to round end

    const hash = await walletClient.writeContract({
      address: MODULE_MARKET_ADDRESS,
      abi: moduleMarketAbi,
      functionName: "listModule",
      args: [roundAddress, intent.minPriceCredits, BigInt(duration)],
      chain: arcTestnet,
      account: walletClient.account!,
    });
    return hash;
  } catch {
    return null;
  }
}

/// Bid on a rival's auction, proxy-style. Returns the amount bid or null.
export async function dispatchBid(
  walletClient: WalletClient,
  publicClient: PublicClient,
  roundAddress: Address,
  agentAddress: Address,
  intent: ModuleBidIntent,
  snapshot: AgentSnapshot,
): Promise<bigint | null> {
  if (snapshot.moduleTier !== 0) return null; // can't take delivery while owning one
  try {
    const row = (await publicClient.readContract({
      address: MODULE_MARKET_ADDRESS,
      abi: moduleMarketAbi,
      functionName: "listings",
      args: [intent.auctionId],
    })) as readonly [Address, Address, number, bigint, bigint, bigint, Address, bigint, boolean];
    const [round, seller, , , minPrice, endTime, highBidder, highBid, settled] = row;

    if (round.toLowerCase() !== roundAddress.toLowerCase()) return null;
    if (settled) return null;
    if (Number(endTime) - Math.floor(Date.now() / 1000) < 10) return null;
    if (seller.toLowerCase() === agentAddress.toLowerCase()) return null;
    const hasLeader = highBidder !== ZERO_ADDR;
    if (hasLeader && highBidder.toLowerCase() === agentAddress.toLowerCase()) return null; // already leading

    const required = computeRequiredBid(minPrice, highBid, hasLeader);
    if (required > intent.maxBidCredits) return null; // above our ceiling
    if (required > snapshot.credits) return null;     // can't afford

    await walletClient.writeContract({
      address: MODULE_MARKET_ADDRESS,
      abi: moduleMarketAbi,
      functionName: "bid",
      args: [intent.auctionId, required],
      chain: arcTestnet,
      account: walletClient.account!,
    });
    return required;
  } catch {
    return null;
  }
}

/// Settle any past-deadline auction we're seller or high bidder of —
/// permissionless, and faster than waiting for the keeper backup sweep.
/// Returns the ids settled.
export async function settleDueAuctions(
  walletClient: WalletClient,
  auctions: OpenAuction[],
): Promise<bigint[]> {
  const due = auctions.filter((a) => a.secondsLeft <= 0 && (a.ours || a.weLead));
  const settled: bigint[] = [];
  for (const a of due) {
    try {
      await walletClient.writeContract({
        address: MODULE_MARKET_ADDRESS,
        abi: moduleMarketAbi,
        functionName: "settle",
        args: [a.auctionId],
        chain: arcTestnet,
        account: walletClient.account!,
      });
      settled.push(a.auctionId);
    } catch {
      // someone else settled first, or transient RPC issue — fine either way
    }
  }
  return settled;
}
