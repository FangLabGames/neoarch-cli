/// PROPH-1a — agent-side prophecy reader (holder-only).
///
/// At round activation the keeper may have handed THIS agent a sealed prophecy
/// item (Divine or False — you cannot tell which). This module checks whether
/// we hold one, fetches the ECIES-encrypted envelope from the indexer with an
/// EIP-191-signed request, decrypts it with the agent key, and returns the
/// contents for the LLM to weigh. Gameplay never depends on it — a fetch/
/// decrypt failure just means "no prophecy this round". See
/// docs/NeoArch/PROPH-1-design.md §5.

import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { gcm } from "@noble/ciphers/aes";
import { type Address, type Hex, type PublicClient } from "viem";

// Arc factory that clones the per-round ATRProphecy (RoundInfo.prophecy).
export const ATR_FACTORY = "0xd34eDb9cF2aDfA22ba68dE81E975C568DF53Dc42" as Address;

const factoryAbi = [
  { type: "function", name: "rounds", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }] },
] as const;
const roundAbi = [
  { type: "function", name: "roundId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;
const prophecyAbi = [
  { type: "function", name: "items", stateMutability: "view", inputs: [{ type: "uint256" }],
    outputs: [{ type: "bytes32" }, { type: "address" }, { type: "bool" }, { type: "bool" }] },
] as const;

const hexToBytes = (h: string): Uint8Array => {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
};
const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

interface EciesEnvelope { v: 1; eph: string; iv: string; ct: string }

/// Decrypt an ECIES envelope with the agent private key (counterpart of the
/// keeper's eciesEncrypt; same HKDF "proph-1a" info + AES-256-GCM).
function eciesDecrypt(privKeyHex: string, env: EciesEnvelope): string {
  const priv = hexToBytes(privKeyHex);
  const eph = secp256k1.ProjectivePoint.fromHex(env.eph);
  const shared = eph.multiply(BigInt("0x" + bytesToHex(priv))).toRawBytes(true);
  const key = hkdf(sha256, shared, undefined, "proph-1a", 32);
  return new TextDecoder().decode(gcm(key, hexToBytes(env.iv)).decrypt(hexToBytes(env.ct)));
}

export interface HeldProphecy {
  itemIdx: number;
  endTick: number;
  phaseOrder: number[];
  /// The raw payload bytes + salt — kept so a future `verify()` intent can use
  /// them without re-fetching.
  payloadHex: Hex;
  salt: Hex;
}

interface Signer {
  address: Address;
  signMessage(args: { message: string }): Promise<Hex>;
  privateKey?: Hex;
}

let lastNonce = 0;
function nextNonce(): number {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

/// EIP-191-signed GET (the prophecy read endpoint requires holder proof).
async function signedGet(indexerUrl: string, signer: Signer, path: string): Promise<any | null> {
  const message = JSON.stringify({ nonce: nextNonce() });
  const signature = await signer.signMessage({ message });
  const res = await fetch(`${indexerUrl}${path}`, {
    headers: {
      "x-eip191-message-b64": Buffer.from(message, "utf8").toString("base64"),
      "x-eip191-signature": signature,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

/// Check whether this agent holds a prophecy item in `roundAddress`, and if so
/// fetch + decrypt it. `privKeyHex` is the agent's key (for ECIES decrypt).
/// Returns null on no-holding / any failure (gameplay-safe).
export async function fetchHeldProphecy(
  publicClient: PublicClient,
  signer: Signer,
  privKeyHex: Hex,
  roundAddress: Address,
  indexerUrl: string,
): Promise<HeldProphecy | null> {
  try {
    const roundId = (await publicClient.readContract({ address: roundAddress, abi: roundAbi, functionName: "roundId" })) as bigint;
    const info = (await publicClient.readContract({ address: ATR_FACTORY, abi: factoryAbi, functionName: "rounds", args: [roundId] })) as any;
    const clone = info[2] as Address;
    if (!clone || /^0x0+$/.test(clone)) return null;

    for (let idx = 0; idx < 2; idx++) {
      const item = (await publicClient.readContract({ address: clone, abi: prophecyAbi, functionName: "items", args: [BigInt(idx)] })) as any;
      const holder = item[1] as Address;
      if (holder?.toLowerCase() !== signer.address.toLowerCase()) continue;

      const resp = await signedGet(indexerUrl, signer, `/api/atr/prophecy/${roundId}/${idx}`);
      if (!resp?.encrypted_payload) return null;
      const env = JSON.parse(resp.encrypted_payload) as EciesEnvelope;
      const inner = JSON.parse(eciesDecrypt(privKeyHex, env)) as { payloadHex: Hex; salt: Hex };
      const payload = JSON.parse(new TextDecoder().decode(hexToBytes(inner.payloadHex))) as { endTick: number; phaseOrder: number[] };
      return { itemIdx: idx, endTick: payload.endTick, phaseOrder: payload.phaseOrder, payloadHex: inner.payloadHex, salt: inner.salt };
    }
    return null;
  } catch {
    return null;
  }
}

const PHASE_NAMES = ["Expansion", "LoadShock", "Freeze", "Congestion"];

/// The LLM-facing framing — deliberately states it may be False so the model
/// weighs it rather than trusting blindly (that judgement IS the game).
export function prophecyPromptBlock(p: HeldProphecy): string {
  const order = p.phaseOrder.map((x) => PHASE_NAMES[x] ?? `?${x}`).join(" → ");
  return (
    `\n\nPROPHECY (you hold sealed item #${p.itemIdx} — it may be the Divine ` +
    `prophecy (true) OR the False prophecy (fabricated); you CANNOT tell which). ` +
    `It claims: the round ends at tick ${p.endTick}, and the regime-phase order ` +
    `is ${order}. Weigh this against what you actually observe each tick — if it ` +
    `matches reality it is Divine and immensely valuable; if it contradicts what ` +
    `you see, you hold the False one and are being misled.`
  );
}
