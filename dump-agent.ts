/// One-shot "dump" driver: make AGENT_PK's agent sell ~all its payload on the
/// AMM in a single commit/reveal, so it starves to elimination in ~12 ticks.
/// Used to force a fast, SAFE sole-survivor resolution. Reuses the CLI's tested
/// commit-reveal encoding so the commitment hash matches exactly.
import { createWalletClient, createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { atrRoundAbi, arcTestnet } from "./src/abi.ts";
import { computeCommitment, submitCommit, submitReveal, generateSalt, type AgentAction } from "./src/commit-reveal.ts";

const PK = process.env.AGENT_PK as Hex;
const ROUND = process.env.ROUND_ADDRESS as Address;
const RPC = process.env.RPC ?? "https://rpc.testnet.arc.network";
if (!PK || !ROUND) { console.error("need AGENT_PK + ROUND_ADDRESS"); process.exit(1); }

const account = privateKeyToAccount(PK);
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });
const pub = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const me = account.address;
const tag = me.slice(0, 8);

const read = (fn: string, args: any[] = []) =>
  pub.readContract({ address: ROUND, abi: atrRoundAbi, functionName: fn as any, args }) as Promise<any>;

const tickDur = Number(await read("tickDuration"));
const commitWin = Number(await read("commitWindow"));

// Poll until we're at the start of a fresh commit window (need room to commit + reveal).
async function waitForCommitWindow() {
  for (let i = 0; i < 240; i++) {
    const last = Number(await read("lastTickTimestamp"));
    const into = Math.floor(Date.now() / 1000) - last;
    if (into >= 0 && into < commitWin - 6) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("no commit window found");
}

const last = await waitForCommitWindow();
const allowance = (await read("throughputAllowance", [me])) as bigint;
const state = (await read("agents", [me])) as any[];
const payload = state[1] as bigint; // [alive, payload, credits, ...]
// Sell almost everything; leave ~1 payload so death lands ~12 ticks out for ANY
// starting buffer (selling P-1 can't exceed balance even after the tick's consumption).
const sellAmount = payload > 1_500_000n ? payload - 1_000_000n : 0n;

// All throughput to alpha (produce ZERO payload), and dump payload on the AMM.
const action: AgentAction = {
  ePayloadProd: 0n,
  eAlphaProd: allowance,
  eCraft: 0n,
  swaps: [{ market: 0, kind: 0, amount: sellAmount, limitAmount: 0n }], // PAYLOAD, SELL_A_FOR_B, minOut=0
};
const salt = generateSalt();
console.log(`[${tag}] payload=${Number(payload) / 1e6} selling=${Number(sellAmount) / 1e6} allowance=${Number(allowance) / 1e6}`);

const cTx = await submitCommit(wallet, ROUND, computeCommitment(action, salt));
console.log(`[${tag}] commit ${cTx}`);

// Wait into the reveal window (after lastTick + commitWin), then reveal.
while (Math.floor(Date.now() / 1000) - last < commitWin + 2) await new Promise((r) => setTimeout(r, 1500));
const rTx = await submitReveal(wallet, ROUND, action, salt);
console.log(`[${tag}] reveal ${rTx} — payload dumped; will starve in ~12 ticks`);
