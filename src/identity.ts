/// ERC-8004 identity registration — Path A self-serve (v0.4.2).
///
/// joinRound gates on the DeAI overlay's isVerified(msg.sender), which needs
/// TWO self-mints from the agent wallet:
///   1. canonical Arc ERC-8004  register(name)            (skipped if held)
///   2. DeAI overlay            register(name, "")        (mints + verifies)
/// The web register panel and the managed runtime-manager both just wrap
/// these two transactions — so the CLI can register without ever touching
/// the web. Idempotent: safe to run on an already-registered wallet.

import {
  parseAbi,
  type Address,
  type PublicClient,
  type WalletClient,
} from "viem";

export const ARC_CANONICAL_IDENTITY =
  "0x8004A818BFB912233c491871b3d84c89A494BD9e" as Address;
export const DEAI_OVERLAY_IDENTITY =
  "0x40838c1deA516586AeAC4eEed4B77498b46Af6c5" as Address;

const canonicalAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function register(string name)",
]);

const overlayAbi = parseAbi([
  "function isVerified(address) view returns (bool)",
  "function register(string name, string metadataURI)",
]);

export async function ensureRegistered(
  publicClient: PublicClient,
  walletClient: WalletClient,
  address: Address,
  name: string,
  log: (msg: string) => void,
): Promise<void> {
  const verified = (await publicClient.readContract({
    address: DEAI_OVERLAY_IDENTITY,
    abi: overlayAbi,
    functionName: "isVerified",
    args: [address],
  })) as boolean;
  if (verified) {
    log("identity: already registered (isVerified ✓)");
    return;
  }

  const canonicalBalance = (await publicClient.readContract({
    address: ARC_CANONICAL_IDENTITY,
    abi: canonicalAbi,
    functionName: "balanceOf",
    args: [address],
  })) as bigint;

  if (canonicalBalance === 0n) {
    log(`identity: minting canonical Arc ERC-8004 ("${name}")…`);
    const tx1 = await walletClient.writeContract({
      address: ARC_CANONICAL_IDENTITY,
      abi: canonicalAbi,
      functionName: "register",
      args: [name],
      chain: walletClient.chain,
      account: walletClient.account!,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx1 });
    log(`  canonical tx: ${tx1}`);
  } else {
    log("identity: canonical NFT already held — minting overlay only");
  }

  log("identity: minting DeAI overlay…");
  const tx2 = await walletClient.writeContract({
    address: DEAI_OVERLAY_IDENTITY,
    abi: overlayAbi,
    functionName: "register",
    args: [name, ""],
    chain: walletClient.chain,
    account: walletClient.account!,
  });
  await publicClient.waitForTransactionReceipt({ hash: tx2 });
  log(`  overlay tx: ${tx2}`);

  const nowVerified = (await publicClient.readContract({
    address: DEAI_OVERLAY_IDENTITY,
    abi: overlayAbi,
    functionName: "isVerified",
    args: [address],
  })) as boolean;
  if (!nowVerified) {
    throw new Error(
      "identity registration sent but isVerified is still false — check the txs above on arcscan",
    );
  }
  log("identity: registered ✓ (isVerified)");
}
