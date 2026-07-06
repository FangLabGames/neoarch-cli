#!/usr/bin/env bun
/**
 * NeoArch Prediction CLI — rate agents with USDC, from the terminal.
 *
 * One ATRMarket per round (read from `round.market()`), one CPMM market per
 * agent: "will this agent be alive at round end?". Predicting is the spectator
 * side of NeoArch — use a SEPARATE wallet from your playing agent (an agent
 * cannot buy NO on itself; the contract reverts SelfNoForbidden).
 *
 * Mirrors the two TESTED client flows:
 *   - the website's one-signature EIP-2612 permit buy (usePermit/usePlaceBet)
 *   - the smoke bettor's classic approve+buy and claim() (phase4-bettor.ts)
 * plus a real minOut slippage guard computed with the contract's own math.
 *
 * Usage:
 *   export BETTOR_PK=0x<betting-wallet-key>    # or AGENT_PK
 *   export ROUND_ADDRESS=0x<round-contract>
 *   bun run predict.ts list                    # markets, odds, your positions
 *   bun run predict.ts buy <agent> yes 2.5     # one-tx permit buy (USDC)
 *   bun run predict.ts buy <agent> no 1 --classic      # approve+buy fallback
 *   bun run predict.ts positions               # nonzero positions + status
 *   bun run predict.ts claim [agent]           # claim winnings / refunds
 *
 * Flags: --round <addr>  --rpc <url>  --slippage-bps <n=100>  --classic
 * Env:   INDEXER_URL (optional — full market list incl. eliminated agents;
 *        without it, `list` falls back to the round's alive agents)
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, atrRoundAbi, usdcAbi } from "./src/abi.ts";
import {
  marketAbi,
  usdcPermitAbi,
  OUTCOME,
  readMarketView,
  yesProbBps,
  quoteBuy,
  signUsdcPermit,
  type MarketView,
} from "./src/prediction.ts";
import { loadPrivateKey } from "./src/keystore.ts";

// ── args/env ─────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const CMD = argv[0] && !argv[0].startsWith("--") ? argv[0] : "list";
const ROUND_ADDRESS = (process.env.ROUND_ADDRESS ?? flag("round")) as Address;
const RPC = flag("rpc", process.env.RPC ?? "https://rpc.testnet.arc.network");
const INDEXER_URL = (process.env.INDEXER_URL ?? "").replace(/\/$/, "");
const SLIPPAGE_BPS = Number(flag("slippage-bps", "100"));
const USDC_ADDR = "0x3600000000000000000000000000000000000000" as Address;

const C = { reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };
const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fatal = (m: string): never => { console.error(`${C.red}✗ ${m}${C.reset}`); process.exit(1); };

if (!ROUND_ADDRESS || ROUND_ADDRESS.length !== 42) fatal("set ROUND_ADDRESS or pass --round 0x…");

// v0.6.0 — Foundry-keystore key loading (--account <name> reads the same
// encrypted files `cast --account` uses; raw BETTOR_PK/AGENT_PK env = legacy).
const { pk: PK } = await loadPrivateKey({
  account: flag("account", process.env.ACCOUNT ?? ""),
  keystorePath: flag("keystore", process.env.KEYSTORE ?? ""),
  passwordFile: flag("password-file", process.env.KEYSTORE_PASSWORD_FILE ?? ""),
  envPk: process.env.BETTOR_PK ?? process.env.AGENT_PK,
  envPkName: "BETTOR_PK",
}).catch((e) => fatal(e?.message ?? String(e)));

const account = privateKeyToAccount(PK);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });

// ── shared reads ─────────────────────────────────────────────
async function marketAddress(): Promise<Address> {
  const m = (await publicClient.readContract({
    address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "market" as any,
  })) as Address;
  if (!m || m === "0x0000000000000000000000000000000000000000") fatal("this round has no prediction market");
  return m;
}

/// Agents with markets: the indexer's markets endpoint when available
/// (includes eliminated agents — their markets still resolve), else the
/// round's alive list (chain-only fallback).
async function listAgents(): Promise<Address[]> {
  if (INDEXER_URL) {
    try {
      const rid = (await publicClient.readContract({
        address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "roundId" as any,
      })) as bigint;
      const r = await fetch(`${INDEXER_URL}/api/atr/rounds/${rid}/markets`);
      if (r.ok) {
        const d: any = await r.json();
        const agents = (d.markets ?? []).map((m: any) => m.agent as Address);
        if (agents.length > 0) return agents;
      }
    } catch {}
  }
  return (await publicClient.readContract({
    address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "getAliveAgents" as any,
  })) as Address[];
}

function describeDeadline(deadline: bigint): string {
  if (deadline === 0n) return `${C.yellow}trading not open yet${C.reset}`;
  const left = Number(deadline) - Math.floor(Date.now() / 1000);
  if (left <= 0) return `${C.yellow}trading CLOSED${C.reset}`;
  const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60);
  return `trading open — ${h}h ${m}m left`;
}

async function loadViews(market: Address, agents: Address[]): Promise<MarketView[]> {
  return Promise.all(agents.map((a) => readMarketView(publicClient as any, market, a, account.address)));
}

function positionStatus(v: MarketView): string {
  const o = OUTCOME[v.outcome] ?? `?${v.outcome}`;
  if (v.outcome === 0) return `${C.dim}open${C.reset}`;
  if (v.claimed) return `${C.dim}${o} · claimed${C.reset}`;
  const won = (v.outcome === 1 && v.myYes > 0n) || (v.outcome === 2 && v.myNo > 0n);
  if (v.outcome === 3) return `${C.yellow}REFUND claimable${C.reset}`;
  return won ? `${C.green}${o} — you WON, claim now${C.reset}` : `${C.dim}${o} — position lost${C.reset}`;
}

// ── commands ─────────────────────────────────────────────────
async function cmdList(): Promise<void> {
  const market = await marketAddress();
  const [agents, deadline] = await Promise.all([
    listAgents(),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "tradingDeadline" }) as Promise<bigint>,
  ]);
  const views = await loadViews(market, agents);
  console.log(`\n${C.cyan}${C.bold}Prediction markets${C.reset} ${C.dim}round ${short(ROUND_ADDRESS)} · market ${short(market)}${C.reset}`);
  console.log(`${describeDeadline(deadline)}\n`);
  console.log(`${C.dim}agent          YES    NO     pool(USDC)  your position${C.reset}`);
  for (const v of views.filter((x) => x.seeded)) {
    const p = yesProbBps(v);
    const pos =
      v.myYes > 0n || v.myNo > 0n
        ? `${v.myYes > 0n ? `${C.green}${fmt(v.myYes)} YES${C.reset} ` : ""}${v.myNo > 0n ? `${C.red}${fmt(v.myNo)} NO${C.reset}` : ""} ${positionStatus(v)}`
        : C.dim + "—" + C.reset;
    console.log(
      `${short(v.agent)}  ${C.green}${(p / 100).toFixed(0).padStart(3)}¢${C.reset}   ${C.red}${((10_000 - p) / 100).toFixed(0).padStart(3)}¢${C.reset}   ${fmt(v.totalBacking).padStart(9)}   ${pos}`,
    );
  }
  console.log(`\n${C.dim}buy:   bun run predict.ts buy <agent> <yes|no> <usdc>${C.reset}`);
}

async function cmdBet(): Promise<void> {
  const agent = argv[1] as Address;
  const side = (argv[2] ?? "").toLowerCase();
  const amount = Number(argv[3] ?? "0");
  if (!agent?.startsWith("0x") || agent.length !== 42) fatal("usage: buy <agent-address> <yes|no> <usdc-amount>");
  if (side !== "yes" && side !== "no") fatal("side must be yes or no");
  if (!(amount > 0)) fatal("amount must be a positive USDC number");
  if (side === "no" && agent.toLowerCase() === account.address.toLowerCase()) {
    fatal("you cannot buy NO on your own agent (SelfNoForbidden) — use a separate spectator wallet");
  }
  const usdcIn = BigInt(Math.round(amount * 1e6));
  const market = await marketAddress();

  const [view, feeBps, deadline, bal] = await Promise.all([
    readMarketView(publicClient as any, market, agent, account.address),
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "buyFeeBps" }) as Promise<number>,
    publicClient.readContract({ address: market, abi: marketAbi, functionName: "tradingDeadline" }) as Promise<bigint>,
    publicClient.readContract({ address: USDC_ADDR, abi: usdcPermitAbi, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>,
  ]);
  if (!view.seeded) fatal("no market for that agent in this round");
  if (view.outcome !== 0) fatal(`market already resolved ${OUTCOME[view.outcome]}`);
  if (deadline !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= deadline) fatal("trading window is closed");
  if (bal < usdcIn) fatal(`balance ${fmt(bal)} USDC < buy amount ${fmt(usdcIn)} (plus gas)`);

  const isYes = side === "yes";
  const quote = quoteBuy(view, usdcIn, isYes, Number(feeBps));
  const minOut = quote - (quote * BigInt(SLIPPAGE_BPS)) / 10_000n;
  console.log(
    `betting ${C.bold}${fmt(usdcIn)} USDC ${isYes ? C.green + "YES" : C.red + "NO"}${C.reset} on ${short(agent)} ` +
      `${C.dim}(YES @ ${(yesProbBps(view) / 100).toFixed(0)}¢ · quote ${fmt(quote)} shares · minOut ${fmt(minOut)} @ ${SLIPPAGE_BPS}bps)${C.reset}`,
  );

  let tx: Hex;
  if (has("classic")) {
    // approve+buy — the phase4-bettor smoke path.
    const allowance = (await publicClient.readContract({
      address: USDC_ADDR, abi: usdcAbi, functionName: "allowance" as any, args: [account.address, market],
    })) as bigint;
    if (allowance < usdcIn) {
      const ah = await walletClient.writeContract({
        address: USDC_ADDR, abi: usdcAbi, functionName: "approve" as any, args: [market, maxUint256],
        chain: arcTestnet, account,
      });
      await publicClient.waitForTransactionReceipt({ hash: ah });
      console.log(`${C.dim}approved · tx ${ah}${C.reset}`);
    }
    tx = await walletClient.writeContract({
      address: market, abi: marketAbi,
      functionName: isYes ? ("buyYes" as never) : ("buyNo" as never),
      args: [agent, usdcIn, minOut] as never, chain: arcTestnet, account,
    });
  } else {
    // one-tx permit — the website path (Arc USDC EIP-712 domain version "2").
    const p = await signUsdcPermit(publicClient as any, walletClient, USDC_ADDR, account.address, market, usdcIn, arcTestnet.id);
    tx = await walletClient.writeContract({
      address: market, abi: marketAbi,
      functionName: isYes ? "buyYesWithPermit" : "buyNoWithPermit",
      args: [agent, usdcIn, minOut, p.deadline, p.v, p.r, p.s],
      chain: arcTestnet, account,
    });
  }
  const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
  if (rcpt.status !== "success") fatal(`buy tx reverted: ${tx}`);
  const after = await readMarketView(publicClient as any, market, agent, account.address);
  console.log(`${C.green}✓ position opened${C.reset} tx ${C.dim}${tx}${C.reset}`);
  console.log(`position: ${fmt(after.myYes)} YES / ${fmt(after.myNo)} NO · market now YES @ ${(yesProbBps(after) / 100).toFixed(0)}¢`);
}

async function cmdPositions(): Promise<void> {
  const market = await marketAddress();
  const views = (await loadViews(market, await listAgents())).filter((v) => v.myYes > 0n || v.myNo > 0n);
  if (views.length === 0) {
    console.log("no positions in this round");
    return;
  }
  console.log(`\n${C.cyan}${C.bold}Your positions${C.reset} ${C.dim}(${account.address})${C.reset}`);
  for (const v of views) {
    console.log(
      `${short(v.agent)}  ${fmt(v.myYes)} YES / ${fmt(v.myNo)} NO  · YES @ ${(yesProbBps(v) / 100).toFixed(0)}¢ · ${positionStatus(v)}`,
    );
  }
}

async function cmdClaim(): Promise<void> {
  const market = await marketAddress();
  const only = argv[1]?.startsWith("0x") ? (argv[1] as Address) : null;
  const agents = only ? [only] : await listAgents();
  const before = (await publicClient.readContract({
    address: USDC_ADDR, abi: usdcPermitAbi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  let sent = 0;
  for (const v of await loadViews(market, agents)) {
    if (v.myYes === 0n && v.myNo === 0n) continue;
    if (v.claimed) { console.log(`${short(v.agent)}: already claimed`); continue; }
    if (v.outcome === 0) { console.log(`${short(v.agent)}: ${C.dim}unresolved — nothing to claim yet${C.reset}`); continue; }
    const fn = v.outcome === 3 ? "claimRefund" : "claim";
    try {
      const tx = await walletClient.writeContract({
        address: market, abi: marketAbi, functionName: fn as never, args: [v.agent] as never,
        chain: arcTestnet, account,
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: tx });
      console.log(`${short(v.agent)}: ${fn} ${rcpt.status === "success" ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${C.dim}${tx}${C.reset}`);
      sent++;
    } catch (e: any) {
      console.log(`${short(v.agent)}: ${fn} skipped — ${e.shortMessage ?? e.message ?? e}`);
    }
  }
  const after = (await publicClient.readContract({
    address: USDC_ADDR, abi: usdcPermitAbi, functionName: "balanceOf", args: [account.address],
  })) as bigint;
  console.log(`\nclaims sent: ${sent} · USDC ${fmt(before)} → ${fmt(after)} ${C.dim}(Δ ${fmt(after - before)})${C.reset}`);
}

// ── dispatch ─────────────────────────────────────────────────
(async () => {
  switch (CMD) {
    case "list": await cmdList(); break;
    case "buy":
    case "bet": await cmdBet(); break; // "bet" kept as a back-compat alias
    case "positions": await cmdPositions(); break;
    case "claim": await cmdClaim(); break;
    default: fatal(`unknown command "${CMD}" — use list | buy | positions | claim`);
  }
})().catch((e) => fatal(e?.shortMessage ?? e?.message ?? String(e)));
