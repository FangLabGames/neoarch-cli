/// Optional indexer link — strategy-card publish + liveness heartbeat.
///
/// Gameplay NEVER depends on the indexer (the CLI is chain-only by design);
/// this module only powers the social surface on neoarch.xyz:
///   - publishStrategyCard(): one signed POST /api/agents/:addr/deploy so your
///     profile shows the strategy card with the SAME strategyHash the CLI
///     commits on-chain at joinRound (the web "Save Strategy" can't know your
///     local config — the CLI is the source of truth for Path A).
///   - startHeartbeat(): signed POST /api/agents/:addr/heartbeat every 60s to
///     drive the Online/Offline indicator.
///
/// Wire protocol (mirrors services/indexer requireSignedSelfCaller):
///   body = canonical JSON M including { nonce } strictly greater than the
///   last nonce the indexer has seen for this agent; EIP-191 personal_sign(M);
///   headers x-eip191-message-b64 = base64(M), x-eip191-signature. We use
///   Date.now() as the nonce — strictly increasing across restarts.

import type { Address } from "viem";

interface Signer {
  address: Address;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

export type LinkStatus = "off" | "ok" | "error";

// Strictly-monotonic nonce even when two posts land in the same millisecond
// (e.g. the card publish resolving instantly on localhost, then the first
// heartbeat) — the indexer rejects nonce <= last seen.
let lastNonce = 0;
function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

async function signedPost(
  indexerUrl: string,
  signer: Signer,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const message = JSON.stringify({ ...body, nonce: nextNonce() });
  const signature = await signer.signMessage({ message });
  try {
    const res = await fetch(`${indexerUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-eip191-message-b64": Buffer.from(message, "utf8").toString("base64"),
        "x-eip191-signature": signature,
      },
      body: message,
    });
    if (res.ok) return { ok: true, status: res.status };
    let error = `HTTP ${res.status}`;
    try {
      const j: any = await res.json();
      if (j?.error) error = `${error}: ${j.error}`;
    } catch {}
    return { ok: false, status: res.status, error };
  } catch (e: any) {
    return { ok: false, status: 0, error: e?.message ?? String(e) };
  }
}

export interface StrategyCard {
  prompt: string;
  llmProvider: "anthropic" | "openai" | "compatible";
  strategyHash: `0x${string}`;
  hardCapUsd: number;
}

/// Publish the strategy card (atomic strategy + runtime-config row, mode=cli).
/// The indexer stores our client-computed strategyHash for cli mode so the
/// card hash matches the on-chain joinRound commitment exactly.
export async function publishStrategyCard(
  indexerUrl: string,
  signer: Signer,
  card: StrategyCard,
): Promise<{ ok: boolean; error?: string }> {
  const res = await signedPost(indexerUrl, signer, `/api/agents/${signer.address}/deploy`, {
    mode: "cli",
    prompt: card.prompt,
    llmProvider: card.llmProvider,
    hardCapUsd: Math.max(1, Math.min(50, Math.round(card.hardCapUsd))),
    strategyHash: card.strategyHash,
  });
  return { ok: res.ok, error: res.error };
}

/// 60s heartbeat loop. Returns a stop() handle. onStatus fires only on
/// transitions so the caller can surface link state without log spam.
export function startHeartbeat(
  indexerUrl: string,
  signer: Signer,
  onStatus: (s: LinkStatus, detail?: string) => void,
): () => void {
  let last: LinkStatus | null = null;
  const beat = async () => {
    const res = await signedPost(indexerUrl, signer, `/api/agents/${signer.address}/heartbeat`, {});
    const status: LinkStatus = res.ok ? "ok" : "error";
    if (status !== last) {
      last = status;
      onStatus(status, res.error);
    }
  };
  void beat();
  const timer = setInterval(beat, 60_000);
  return () => clearInterval(timer);
}
