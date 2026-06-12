#!/usr/bin/env bun
/**
 * NeoArch Arena Player CLI — open-source Path A runtime.
 *
 * Joins an Agent Trade Royale round with your wallet and plays autonomously
 * for the full round (~576 ticks; ~9.6h at the 60s default — per-round). Signs commit/reveal locally; private
 * key never leaves your machine.
 *
 * Usage:
 *   export AGENT_PK=0x<your-private-key>
 *   export ROUND_ADDRESS=0x<round-contract-address>
 *   export LLM_API_KEY=sk-ant-...           # optional — heuristic only if unset
 *   bun run arena-player.ts --strategy balanced
 *   bun run arena-player.ts --llm anthropic --prompt ./my-strategy.md
 *
 * See README.md for full flag list, security notes, and link to skills.md.
 */

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  formatUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  arcTestnet,
  atrRoundAbi,
  usdcAbi,
  TICK_DURATION_SEC,
  COMMIT_WINDOW_SEC,
  STARVATION_STEPS,
  ENTRY_FEE_USDC,
  ROUND_STATUS,
  HOSTING_MODE_LOCAL_CLI,
} from "./src/abi.ts";
import {
  type AgentAction,
  computeCommitment,
  generateSalt,
  submitCommit,
  submitReveal,
  submitClaimDeferredPayout,
} from "./src/commit-reveal.ts";

/// Arc/USDC: all on-chain amounts are 6dp. Single helper replaces formatEther
/// (which would format $80 as $0.00000008 if accidentally used).
const fmtUsd = (v: bigint) => formatUnits(v, 6);
import {
  type AgentSnapshot,
  type Strategy,
  type WorkOrderIntent,
  type ModuleBidIntent,
  heuristicAction,
  validateAndClamp,
  validateWorkOrders,
  validateModuleBids,
} from "./src/strategy.ts";
import { LlmClient, type Provider, formatSpend } from "./src/llm.ts";
import {
  type OpenAuction,
  scanAuctions,
  bidTargets,
  dispatchListing,
  dispatchBid,
  settleDueAuctions,
} from "./src/module-market.ts";
import { renderHud, type HudState } from "./src/hud.ts";
import {
  publishStrategyCard,
  startHeartbeat,
  type LinkStatus,
} from "./src/indexer-link.ts";
import { ensureRegistered } from "./src/identity.ts";

// ─── Pretty logging ─────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ts = () => new Date().toLocaleTimeString("en-US", { hour12: false });
/// While the HUD owns the screen (hudActive), log lines feed its tail panel
/// instead of stdout — the boot/join phase always prints normally so approval
/// txs and errors are never hidden.
let hudActive = false;
const logRing: string[] = [];
const log = (msg: string) => {
  const line = `${C.dim}${ts()}${C.reset} ${msg}`;
  if (hudActive) {
    logRing.push(line);
    if (logRing.length > 8) logRing.shift();
  } else {
    process.stdout.write(`${line}\n`);
  }
};
function fatal(msg: string): never {
  process.stderr.write(`${C.red}ERROR: ${msg}${C.reset}\n`);
  process.exit(1);
}

// ─── Arg parsing ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name: string, def = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const AGENT_PK = (process.env.AGENT_PK ?? "") as Hex;
const ROUND_ADDRESS = (process.env.ROUND_ADDRESS ?? flag("round")) as Address;
const RPC = flag("rpc", process.env.RPC ?? "https://rpc.testnet.arc.network");
const STRATEGY = flag("strategy", "balanced") as Strategy;
const LLM_PROVIDER = flag("llm", process.env.LLM_PROVIDER ?? "") as Provider | "";
const LLM_MODEL = flag("model", process.env.LLM_MODEL ?? "");
const LLM_BASE_URL = flag("base-url", process.env.LLM_BASE_URL ?? "");
const LLM_API_KEY = process.env.LLM_API_KEY ?? "";
const PROMPT_PATH = flag("prompt", process.env.PROMPT_PATH ?? "");
const CAP_USD = Number(flag("cap-usd", process.env.CAP_USD ?? "5"));
const SKIP_JOIN = has("no-join");
const DRY_RUN = has("dry-run");
// v0.4.0 — optional indexer link (strategy-card publish + 60s heartbeat for
// the Online indicator on neoarch.xyz). Gameplay never depends on it.
const INDEXER_URL = flag("indexer", process.env.INDEXER_URL ?? "").replace(/\/$/, "");
// v0.4.0 — live ASCII HUD. On by default in a TTY; --no-hud (or piping
// stdout) falls back to plain log lines.
const HUD_ENABLED = !has("no-hud") && Boolean(process.stdout.isTTY);
// v0.4.2 — agent display name for the self-serve ERC-8004 registration
// (only used when the wallet isn't registered yet; ≤32 chars like the web).
// Empty → defaults to cli-<addr-prefix> at registration time (the account
// isn't derived yet at flag-parse time).
const AGENT_NAME_FLAG = flag("name", process.env.AGENT_NAME ?? "").slice(0, 32);

if (!AGENT_PK || !AGENT_PK.startsWith("0x") || AGENT_PK.length !== 66) {
  fatal("set AGENT_PK=0x<64-hex-chars> in env (your wallet private key — never sent anywhere)");
}
if (!ROUND_ADDRESS || !ROUND_ADDRESS.startsWith("0x") || ROUND_ADDRESS.length !== 42) {
  fatal("set ROUND_ADDRESS=0x<40-hex-chars> in env or pass --round 0x... (find on neoarch.xyz/arena)");
}
if (!["payload", "balanced", "craft"].includes(STRATEGY)) {
  fatal(`unknown --strategy "${STRATEGY}" — must be one of: payload, balanced, craft`);
}

// ─── Clients ────────────────────────────────────────────────────────
const account = privateKeyToAccount(AGENT_PK);
const publicClient = createPublicClient({ chain: arcTestnet, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain: arcTestnet, transport: http(RPC) });

// ─── LLM (optional) ─────────────────────────────────────────────────
let userStrategyPrompt = "";
if (PROMPT_PATH) {
  try {
    userStrategyPrompt = readFileSync(PROMPT_PATH, "utf8");
  } catch (e: any) {
    fatal(`couldn't read --prompt file ${PROMPT_PATH}: ${e?.message ?? e}`);
  }
}

const llm: LlmClient | null =
  LLM_PROVIDER && LLM_API_KEY
    ? new LlmClient({
        provider: LLM_PROVIDER as Provider,
        apiKey: LLM_API_KEY,
        model: LLM_MODEL || undefined,
        baseUrl: LLM_BASE_URL || undefined,
        capUsdMicro: Math.round(CAP_USD * 1_000_000),
        systemPrompt: userStrategyPrompt,
      })
    : null;

// ─── Banner ─────────────────────────────────────────────────────────
log(`${C.cyan}NeoArch Arena Player${C.reset} v0.4.0`);
log(`  agent:    ${C.bold}${account.address}${C.reset}`);
log(`  round:    ${ROUND_ADDRESS}`);
log(`  rpc:      ${RPC}`);
log(`  brain:    ${llm ? `${C.green}LLM${C.reset} (${LLM_PROVIDER}, cap=$${CAP_USD}/round)` : `heuristic ${C.bold}${STRATEGY}${C.reset}`}`);
log(`  indexer:  ${INDEXER_URL ? INDEXER_URL : `${C.dim}off (set INDEXER_URL for the Online badge + strategy card)${C.reset}`}`);
log(`  hud:      ${HUD_ENABLED ? "on (--no-hud for plain logs)" : `${C.dim}off${C.reset}`}`);
if (DRY_RUN) log(`  mode:     ${C.yellow}DRY-RUN${C.reset} (no transactions sent)`);

// ─── State machine ──────────────────────────────────────────────────
interface PendingReveal {
  tick: number;
  action: AgentAction;
  salt: Hex;
}
let pending: PendingReveal | null = null;
let lastSeenTick = -1n;

// ─── HUD state (v0.4.0) ─────────────────────────────────────────────
const PHASES: Record<number, { name: string; payloadMod: number }> = {
  0: { name: "EXPANSION", payloadMod: 1.25 },
  1: { name: "LOAD SHOCK", payloadMod: 0.7 },
  2: { name: "FREEZE", payloadMod: 0.6 },
  3: { name: "CONGESTION", payloadMod: 0.85 },
};
let lastSnapshot: AgentSnapshot | null = null;
let lastActionSummary: string | null = null;
let lastRevealedTick: number | null = null;
let indexerLink: LinkStatus = INDEXER_URL ? "error" : "off";
let lastHudRenderMs = 0;

/// Round-context reads for the HUD frame. Each is best-effort — a failed read
/// renders as "—" rather than breaking the loop. Throttled by maybeRenderHud.
async function readHudExtras() {
  const [phaseIdx, ticksRemaining, alive, total, vault] = await Promise.all([
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "currentRegimePhaseIdx" }).catch(() => null),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "regimePhaseTicksRemaining" }).catch(() => null),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "aliveCount" }).catch(() => null),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "totalAgents" }).catch(() => null),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "prizeVault" }).catch(() => null),
  ]);
  let phase: HudState["phase"] = null;
  if (phaseIdx !== null) {
    const order = (await publicClient
      .readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "regimePhaseOrder", args: [BigInt(phaseIdx as number)] })
      .catch(() => null)) as number | null;
    if (order !== null && PHASES[order]) {
      phase = { ...PHASES[order], ticksRemaining: ticksRemaining !== null ? Number(ticksRemaining) : 0 };
    }
  }
  return {
    phase,
    aliveCount: alive !== null ? Number(alive) : null,
    totalAgents: total !== null ? Number(total) : null,
    prizeVaultCredits: (vault as bigint | null),
  };
}

/// Paint a HUD frame — at most every 5s unless forced (post-commit/reveal).
async function maybeRenderHud(
  timing: { status: number; tick: bigint; lastTs: bigint },
  force = false,
): Promise<void> {
  if (!HUD_ENABLED) return;
  const nowMs = Date.now();
  if (!force && nowMs - lastHudRenderMs < 5_000) return;
  lastHudRenderMs = nowMs;
  hudActive = true;

  let agentStale = false;
  const [extras, snap] = await Promise.all([
    readHudExtras(),
    readSnapshot().catch(() => {
      agentStale = true; // render the last snapshot but badge it as stale
      return lastSnapshot;
    }),
  ]);
  if (snap && !agentStale) lastSnapshot = snap;

  const now = Math.floor(nowMs / 1000);
  const tickStart = Number(timing.lastTs);
  const commitDeadline = tickStart + commitWindowSec;
  const tickEnd = tickStart + tickDurationSec;
  let window: HudState["window"] = "closed";
  let windowSecsLeft = 0;
  let windowTotalSecs = 0;
  if (timing.status === ROUND_STATUS.ACTIVE) {
    if (now < commitDeadline) {
      window = "commit";
      windowSecsLeft = commitDeadline - now;
      windowTotalSecs = commitWindowSec;
    } else if (now < tickEnd) {
      window = "reveal";
      windowSecsLeft = tickEnd - now;
      windowTotalSecs = tickDurationSec - commitWindowSec;
    }
  }

  const spend = llm ? llm.getSpend() : null;
  process.stdout.write(
    renderHud({
      address: account.address,
      roundAddress: ROUND_ADDRESS,
      status: timing.status,
      tick: Number(timing.tick),
      endTick: endTickNum,
      phase: extras.phase,
      aliveCount: extras.aliveCount,
      totalAgents: extras.totalAgents,
      prizeVaultCredits: extras.prizeVaultCredits,
      agent: lastSnapshot,
      window,
      windowSecsLeft,
      windowTotalSecs,
      agentStale,
      pendingTick: pending?.tick ?? null,
      lastRevealedTick,
      lastAction: lastActionSummary,
      brain: llm
        ? `LLM ${LLM_PROVIDER}${LLM_MODEL ? ` (${LLM_MODEL})` : ""}`
        : `heuristic ${STRATEGY}`,
      spendLine: spend ? formatSpend(spend) : null,
      indexerLink,
      dryRun: DRY_RUN,
      logTail: logRing,
    }),
  );
}

// ─── Strategy commitment ────────────────────────────────────────────
/// Compute the strategyHash committed at joinRound. Hashes the canonical
/// representation of what this agent is locked into for the entire round.
/// LLM mode: hash the system prompt + user prompt. Heuristic mode: hash the
/// preset name + version. The on-chain bytes32 is just a commitment — the
/// contract doesn't introspect it; it's there so spectators/researchers can
/// later verify you didn't swap strategies mid-round.
function computeStrategyHash(): Hex {
  if (llm) {
    const provider = LLM_PROVIDER || "anthropic";
    const model = LLM_MODEL || "default";
    const body = `llm|${provider}|${model}|${userStrategyPrompt.trim()}`;
    return keccak256(toHex(body));
  }
  return keccak256(toHex(`heuristic|${STRATEGY}|v1`));
}

// ─── Snapshot reader ────────────────────────────────────────────────
async function readSnapshot(): Promise<AgentSnapshot> {
  const result = (await publicClient.readContract({
    address: ROUND_ADDRESS,
    abi: atrRoundAbi,
    functionName: "agents",
    args: [account.address],
  })) as readonly [
    boolean, bigint, bigint, bigint, number, bigint, bigint, number, bigint, bigint, number, Hex, number,
  ];
  const throughputCap = result[6];
  // v1.14 (RV-CT-3): allocate against the regime/phase-modified, MAX_ENERGY_CAP-clamped
  // allowance — revealAction validates against it, so a reveal summing to the raw
  // throughputCap reverts (ThroughputMismatch) in a non-Expansion phase or a
  // ThroughputSector regime. Pre-v1.14 rounds lack the view; fall back to the raw cap.
  let throughputAllowance = throughputCap;
  try {
    throughputAllowance = (await publicClient.readContract({
      address: ROUND_ADDRESS,
      abi: atrRoundAbi,
      functionName: "throughputAllowance",
      args: [account.address],
    })) as bigint;
  } catch {
    // old round impl without throughputAllowance() — keep the raw-cap fallback
  }
  return {
    alive: result[0],
    payload: result[1],
    credits: result[2],
    alphaBalance: result[3],
    moduleTier: result[4],
    moduleDurability: result[5],
    throughputCap,
    throughputAllowance,
    missCount: result[7],
  };
}

async function readTiming(): Promise<{ status: number; tick: bigint; lastTs: bigint }> {
  const [status, tick, lastTs] = (await Promise.all([
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "roundStatus" }),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "currentTick" }),
    publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "lastTickTimestamp" }),
  ])) as [number, bigint, bigint];
  return { status, tick, lastTs };
}

// v1.6: per-round tick timing, read from chain ONCE at boot (was hardcoded 300/180).
// Falls back to the abi.ts defaults (60/36) if the read fails. The poll loop uses these.
let tickDurationSec = TICK_DURATION_SEC;
let commitWindowSec = COMMIT_WINDOW_SEC;
// endTick for the module-market listing clamp (an auction must settle before
// the round resolves). SEC-SEED-1: 0 until the seed lands — re-read lazily.
let endTickNum = 0;

async function loadRoundTiming(): Promise<void> {
  try {
    const [td, cw, et] = (await Promise.all([
      publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "tickDuration" }),
      publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "commitWindow" }),
      publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "endTick" }),
    ])) as [bigint, bigint, bigint];
    if (td > 0n && cw > 0n && cw < td) {
      tickDurationSec = Number(td);
      commitWindowSec = Number(cw);
    }
    endTickNum = Number(et);
    log(`  timing:   ${tickDurationSec}s tick / ${commitWindowSec}s commit (from chain)`);
  } catch {
    log(`  timing:   ${tickDurationSec}s tick / ${commitWindowSec}s commit (chain read failed — using defaults)`);
  }
}

// ─── joinRound bootstrap ────────────────────────────────────────────
async function ensureJoined(): Promise<void> {
  if (SKIP_JOIN) {
    log(`${C.yellow}--no-join${C.reset} — assuming already joined`);
    return;
  }

  // A fresh wallet that hasn't joined returns the all-zero AgentState struct.
  // alive=true OR payload>0 OR credits>0 means we're in.
  const snap = await readSnapshot();
  if (snap.alive || snap.payload > 0n || snap.credits > 0n) {
    log(`${C.green}already joined${C.reset} — payload=${fmtUsd(snap.payload)} credits=${fmtUsd(snap.credits)}`);
    return;
  }

  // Approve USDC entry fee if needed (round may be free-entry during beta).
  const usdcAddr = (await publicClient.readContract({
    address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "usdc",
  })) as Address;

  const balance = (await publicClient.readContract({
    address: usdcAddr, abi: usdcAbi, functionName: "balanceOf", args: [account.address],
  })) as bigint;

  if (balance >= ENTRY_FEE_USDC) {
    const allowance = (await publicClient.readContract({
      address: usdcAddr, abi: usdcAbi, functionName: "allowance",
      args: [account.address, ROUND_ADDRESS],
    })) as bigint;
    if (allowance < ENTRY_FEE_USDC) {
      log(`approving ${fmtUsd(ENTRY_FEE_USDC)} USDC to round contract...`);
      if (!DRY_RUN) {
        const hash = await walletClient.writeContract({
          address: usdcAddr, abi: usdcAbi, functionName: "approve",
          args: [ROUND_ADDRESS, ENTRY_FEE_USDC], chain: arcTestnet,
        });
        await publicClient.waitForTransactionReceipt({ hash });
        log(`  approve tx: ${C.dim}${hash}${C.reset}`);
      }
    }
  } else {
    log(`${C.yellow}low USDC balance (${fmtUsd(balance)} < ${fmtUsd(ENTRY_FEE_USDC)})${C.reset} — assuming voucher / free-entry`);
  }

  const strategyHash = computeStrategyHash();
  log(`joining round with strategyHash=${C.dim}${strategyHash.slice(0, 10)}…${C.reset} hostingMode=0 (Local CLI)`);

  if (DRY_RUN) return;
  const hash = await walletClient.writeContract({
    address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "joinRound",
    args: [strategyHash, HOSTING_MODE_LOCAL_CLI], chain: arcTestnet,
  });
  await publicClient.waitForTransactionReceipt({ hash });
  log(`${C.green}joined${C.reset} tx: ${C.dim}${hash}${C.reset}`);
}

// ─── Decide + commit ────────────────────────────────────────────────
async function decideAndCommit(execTick: bigint): Promise<void> {
  const snap = await readSnapshot();
  if (!snap.alive || snap.missCount >= STARVATION_STEPS) {
    // Bypass the HUD log ring — this is the last thing the process says and
    // a ring entry would die with it, leaving a silent exit under the HUD.
    hudActive = false;
    process.stdout.write(`\n${C.red}agent eliminated${C.reset} — exiting\n`);
    process.exit(0);
  }

  // Module market: surface open auctions to the LLM only when we can
  // actually take delivery (no module held). Best-effort.
  let openAuctions: OpenAuction[] = [];
  if (llm && snap.moduleTier === 0) {
    openAuctions = bidTargets(await scanAuctions(publicClient, ROUND_ADDRESS, account.address));
    if (openAuctions.length > 0) {
      log(
        `${C.dim}module market: ${openAuctions.length} open auction(s): ` +
          openAuctions.map((a) => `#${a.auctionId} t${a.tier}@${fmtUsd(a.minNextBid)}${a.weLead ? "(lead)" : ""}`).join(" ") +
          C.reset,
      );
    }
  }

  let action: AgentAction;
  let workOrders: WorkOrderIntent[] = [];
  let moduleBids: ModuleBidIntent[] = [];
  if (llm) {
    const decision = await llm.callForDecision(snap, Number(execTick), openAuctions);
    if (!decision) {
      action = heuristicAction(snap, STRATEGY, Number(execTick));
      log(`${C.dim}LLM returned null — heuristic fallback${C.reset}`);
    } else {
      action = validateAndClamp(decision, snap);
      workOrders = snap.moduleTier > 0 ? validateWorkOrders(decision.workOrders) : [];
      moduleBids = snap.moduleTier === 0 ? validateModuleBids(decision.moduleBids) : [];
    }
  } else {
    action = heuristicAction(snap, STRATEGY, Number(execTick));
  }

  const salt = generateSalt();
  const commitment = computeCommitment(action, salt);

  // HUD: human-readable allocation split for the "last" line.
  const budget = snap.throughputAllowance > 0n ? snap.throughputAllowance : 1n;
  const pct = (v: bigint) => Number((v * 100n) / budget);
  lastSnapshot = snap;
  lastActionSummary =
    `payload ${pct(action.ePayloadProd)}% · alpha ${pct(action.eAlphaProd)}% · craft ${pct(action.eCraft)}%` +
    (action.swaps.length > 0 ? ` · ${action.swaps.length} swap(s)` : "");

  log(
    `${C.cyan}COMMIT${C.reset} t=${execTick}  ` +
      `payload=${fmtUsd(action.ePayloadProd)}  ` +
      `alpha=${fmtUsd(action.eAlphaProd)}  ` +
      `craft=${fmtUsd(action.eCraft)}  ` +
      `(budget=${fmtUsd(snap.throughputAllowance)})`,
  );

  pending = { tick: Number(execTick), action, salt };

  if (DRY_RUN) return;
  try {
    const hash = await submitCommit(walletClient, ROUND_ADDRESS, commitment);
    log(`  commit tx: ${C.dim}${hash}${C.reset}`);
  } catch (e: any) {
    log(`${C.red}commit revert: ${e.shortMessage ?? e.message ?? e}${C.reset}`);
    pending = null;
    return;
  }

  // Module-market actions ride AFTER a successful commit (never risk the
  // tick), fire-and-forget.
  if (workOrders.length > 0 || moduleBids.length > 0) {
    dispatchMarketActions(snap, Number(execTick), workOrders, moduleBids).catch(() => {});
  }
}

/// Fire LLM-decided module-market actions: one listing (sell) or one bid (buy).
async function dispatchMarketActions(
  snap: AgentSnapshot,
  execTick: number,
  workOrders: WorkOrderIntent[],
  moduleBids: ModuleBidIntent[],
): Promise<void> {
  // SEC-SEED-1: endTick is 0 until the seed lands; re-read lazily once ACTIVE.
  if (endTickNum === 0) {
    try {
      endTickNum = Number(
        await publicClient.readContract({ address: ROUND_ADDRESS, abi: atrRoundAbi, functionName: "endTick" }),
      );
    } catch {}
  }
  if (workOrders.length > 0 && endTickNum > 0) {
    const remainingSec = Math.max(0, (endTickNum - execTick) * tickDurationSec);
    const tx = await dispatchListing(
      walletClient, publicClient, ROUND_ADDRESS, account.address,
      workOrders[0], snap, remainingSec,
    );
    if (tx) log(`${C.green}LISTED${C.reset} module tier=${snap.moduleTier} minPrice=${fmtUsd(workOrders[0].minPriceCredits)} tx: ${C.dim}${tx}${C.reset}`);
  }
  if (moduleBids.length > 0) {
    const amount = await dispatchBid(
      walletClient, publicClient, ROUND_ADDRESS, account.address,
      moduleBids[0], snap,
    );
    if (amount !== null) log(`${C.green}BID${C.reset} ${fmtUsd(amount)} credits on auction #${moduleBids[0].auctionId} (ceiling ${fmtUsd(moduleBids[0].maxBidCredits)})`);
  }
}

// ─── Reveal ─────────────────────────────────────────────────────────
async function maybeReveal(execTick: bigint): Promise<void> {
  if (!pending || pending.tick !== Number(execTick)) return;
  const p = pending;
  pending = null;

  log(`${C.cyan}REVEAL${C.reset} t=${p.tick}`);
  if (DRY_RUN) {
    lastRevealedTick = p.tick;
    return;
  }
  try {
    const hash = await submitReveal(walletClient, ROUND_ADDRESS, p.action, p.salt);
    lastRevealedTick = p.tick;
    log(`  reveal tx: ${C.dim}${hash}${C.reset}`);
  } catch (e: any) {
    log(`${C.red}reveal revert: ${e.shortMessage ?? e.message ?? e}${C.reset}`);
  }
}

// ─── Round end ──────────────────────────────────────────────────────
/// Arc/USDC migration: prize distribution is AUTOMATIC — `_resolveRound`
/// pushes USDC to every survivor via `_payoutOrDefer`. The only pull path is
/// `claimDeferredPayout()`, which only has a balance if the auto-push transfer
/// reverted (contract recipient with bad fallback, USDC blacklist hit, etc.).
/// We poll `pendingPayouts` first; if zero, we've already been paid.
async function handleResolved(): Promise<void> {
  log(`${C.yellow}round RESOLVED${C.reset}`);
  if (llm) log(`  LLM spend: ${formatSpend(llm.getSpend())}`);

  const snap = await readSnapshot();
  if (!snap.alive) {
    log(`agent did not survive — Last Stand pool may have paid out automatically`);
  } else {
    log(`agent survived — prize auto-pushed at resolution`);
  }

  // Check for deferred payout (rare: only if auto-push reverted).
  const pending = (await publicClient.readContract({
    address: ROUND_ADDRESS,
    abi: atrRoundAbi,
    functionName: "pendingPayouts",
    args: [account.address],
  })) as bigint;

  if (pending === 0n) {
    log(`  no deferred payout — your share was sent at resolution time`);
    return;
  }

  log(`  ${C.yellow}deferred payout${C.reset} of ${fmtUsd(pending)} USDC found — claiming…`);
  if (DRY_RUN) return;
  try {
    const hash = await submitClaimDeferredPayout(walletClient, ROUND_ADDRESS);
    await publicClient.waitForTransactionReceipt({ hash });
    log(`${C.green}deferred payout claimed${C.reset} tx: ${C.dim}${hash}${C.reset}`);
  } catch (e: any) {
    log(`${C.red}claimDeferredPayout failed: ${e.shortMessage ?? e.message ?? e}${C.reset}`);
    log(`${C.yellow}retry with: cast send ${ROUND_ADDRESS} 'claimDeferredPayout()' --account <your-account>${C.reset}`);
  }
}

// ─── Main poll loop ─────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastMarketSweep = 0;

async function pollLoop(): Promise<void> {
  while (true) {
    try {
      const { status, tick, lastTs } = await readTiming();
      await maybeRenderHud({ status, tick, lastTs });

      if (status === ROUND_STATUS.RESOLVED) {
        hudActive = false; // resolution summary prints below the last frame
        await handleResolved();
        return;
      }
      if (status === ROUND_STATUS.CANCELLED) {
        hudActive = false;
        log(`${C.yellow}round CANCELLED${C.reset} — the contract auto-refunded your entry (9.5 USDC). exiting.`);
        return;
      }
      if (status === ROUND_STATUS.SEEDING) {
        // SEC-SEED-1: joins are frozen and the round seed is being drawn
        // (commit-reveal / VRF). The round goes ACTIVE in the same tx the
        // seed lands — nothing to do but wait.
        log(`${C.dim}seed being drawn (joins frozen) — round starts the moment it lands…${C.reset}`);
        await sleep(10_000);
        continue;
      }
      if (status !== ROUND_STATUS.ACTIVE) {
        log(`waiting for round to start (status=${status})…`);
        await sleep(15_000);
        continue;
      }

      // Module market housekeeping (LLM mode only): settle any past-deadline
      // auction we sold or are winning, so the module/proceeds arrive without
      // waiting for the keeper's backup sweep. At most once a minute.
      const nowMs = Date.now();
      if (llm && !DRY_RUN && nowMs - lastMarketSweep > 60_000) {
        lastMarketSweep = nowMs;
        scanAuctions(publicClient, ROUND_ADDRESS, account.address)
          .then((all) => settleDueAuctions(walletClient, all))
          .then((ids) => {
            for (const id of ids) log(`${C.green}SETTLED${C.reset} module auction #${id}`);
          })
          .catch(() => {});
      }

      const now = BigInt(Math.floor(Date.now() / 1000));
      const tickStart = lastTs;
      const commitDeadline = tickStart + BigInt(commitWindowSec);
      const tickEnd = tickStart + BigInt(tickDurationSec);
      const execTick = tick + 1n;

      // New tick → drop any pending reveal we never got to submit.
      if (tick !== lastSeenTick) {
        lastSeenTick = tick;
        if (pending && pending.tick < Number(execTick)) {
          log(`${C.yellow}stale pending reveal for t=${pending.tick} — clearing${C.reset}`);
          pending = null;
        }
      }

      // Commit window — submit if we haven't yet for this execTick.
      if (now < commitDeadline && (!pending || pending.tick !== Number(execTick))) {
        await decideAndCommit(execTick);
        await maybeRenderHud({ status, tick, lastTs }, true);
        await sleep(2_000);
        continue;
      }

      // Reveal window — submit at +200s to leave a 100s safety margin.
      if (now >= commitDeadline && now < tickEnd && pending?.tick === Number(execTick)) {
        await maybeReveal(execTick);
        await maybeRenderHud({ status, tick, lastTs }, true);
        await sleep(2_000);
        continue;
      }

      // Idle — sleep to the next interesting boundary.
      const wait = now < commitDeadline
        ? Math.min(Number(commitDeadline - now), 30)
        : Math.max(Number(tickEnd - now), 5);
      await sleep(wait * 1_000);
    } catch (e: any) {
      log(`${C.red}poll error: ${e.shortMessage ?? e.message ?? e}${C.reset}`);
      await sleep(15_000);
    }
  }
}

// ─── Indexer link (optional, v0.4.0) ────────────────────────────────
/// Card text shown on the agent's neoarch.xyz profile. For LLM mode this is
/// the operator prompt plus a provenance footer; for heuristic mode it's a
/// generated description (the indexer requires ≥200 chars). The strategyHash
/// we publish is the SAME hash committed at joinRound — the web page can't
/// know the CLI's local config, so the CLI is the source of truth.
function buildCardPrompt(): string {
  if (llm) {
    const provider = LLM_PROVIDER || "anthropic";
    const model = LLM_MODEL || "default";
    return (
      `${userStrategyPrompt.trim()}\n\n` +
      `[Published by neoarch-cli v0.4.0 (Path A, self-hosted). The on-chain ` +
      `strategyHash committed at joinRound binds ` +
      `keccak256("llm|${provider}|${model}|<prompt above>") — provider, model, ` +
      `and prompt are locked for the entire round. This card was auto-published ` +
      `by the CLI at join and matches the chain commitment exactly.]`
    );
  }
  return (
    `Heuristic preset "${STRATEGY}" — deterministic local strategy from the ` +
    `open-source neoarch-cli (no LLM). Each tick it splits the throughput ` +
    `allowance between payload production, alpha, and module crafting per the ` +
    `preset's fixed weights, with survival overrides under starvation pressure. ` +
    `The on-chain strategyHash committed at joinRound binds ` +
    `keccak256("heuristic|${STRATEGY}|v1") and is locked for the entire round. ` +
    `Auto-published by the CLI at join.`
  );
}

async function linkIndexer(): Promise<void> {
  if (!INDEXER_URL) return;
  // Guard: if we're ALREADY joined with a DIFFERENT hash, the join came from
  // the web flow (the Join button commits the web-saved card's hash). In that
  // case the existing card matches the chain and replacing it with ours would
  // break card↔chain verification — keep it, heartbeat only.
  try {
    const onChain = (await publicClient.readContract({
      address: ROUND_ADDRESS,
      abi: atrRoundAbi,
      functionName: "agents",
      args: [account.address],
    })) as readonly unknown[];
    const committed = String(onChain[11] ?? "").toLowerCase();
    const ZERO32 = `0x${"0".repeat(64)}`;
    if (committed && committed !== ZERO32 && committed !== computeStrategyHash().toLowerCase()) {
      log(
        `${C.yellow}on-chain strategyHash differs from this CLI config${C.reset} ` +
          `(joined via the web flow?) — keeping the existing profile card; heartbeat only`,
      );
      startHeartbeat(INDEXER_URL, account, (s, detail) => {
        indexerLink = s;
        if (s === "ok") log(`${C.green}heartbeat ok${C.reset} — you'll show Online on neoarch.xyz`);
        else log(`${C.yellow}heartbeat failing${C.reset} (${detail ?? "?"}) — Online badge will lapse; gameplay unaffected`);
      });
      return;
    }
  } catch {
    // Chain read failed — proceed; a wrong card is recoverable, a missed
    // publish for a CLI-join is the more common case.
  }
  const res = await publishStrategyCard(INDEXER_URL, account, {
    prompt: buildCardPrompt(),
    llmProvider: (llm ? (LLM_PROVIDER as Provider) : "compatible") as "anthropic" | "openai" | "compatible",
    strategyHash: computeStrategyHash(),
    hardCapUsd: llm ? CAP_USD : 1,
  });
  if (res.ok) {
    log(`${C.green}strategy card published${C.reset} → ${INDEXER_URL} (hash matches on-chain commitment)`);
  } else {
    log(`${C.yellow}strategy-card publish failed${C.reset} (${res.error}) — profile card may be stale; gameplay unaffected`);
  }
  startHeartbeat(INDEXER_URL, account, (s, detail) => {
    indexerLink = s;
    if (s === "ok") log(`${C.green}heartbeat ok${C.reset} — you'll show Online on neoarch.xyz`);
    else log(`${C.yellow}heartbeat failing${C.reset} (${detail ?? "?"}) — Online badge will lapse; gameplay unaffected`);
  });
}

// ─── Boot ───────────────────────────────────────────────────────────
(async () => {
  try {
    // Self-serve ERC-8004 registration (v0.4.2): joinRound reverts for
    // unverified wallets, and the register txs are plain self-mints this
    // wallet can send itself — no web step needed. Skipped with --no-join
    // (you manage join readiness) and --dry-run (no txs).
    if (!SKIP_JOIN && !DRY_RUN) {
      const agentName = AGENT_NAME_FLAG || `cli-${account.address.slice(2, 8)}`;
      await ensureRegistered(publicClient, walletClient, account.address, agentName, log);
    }
    await ensureJoined();
    await loadRoundTiming();
    await linkIndexer();
    await pollLoop();
    log(`${C.dim}exit.${C.reset}`);
  } catch (e: any) {
    fatal(e?.shortMessage ?? e?.message ?? String(e));
  }
})();

process.on("SIGINT", () => {
  // Direct write — the HUD log ring would swallow this final message.
  hudActive = false;
  process.stdout.write(
    `\n${C.dim}interrupted — exiting cleanly. Pending reveals (if any) are dropped.${C.reset}\n`,
  );
  process.exit(0);
});
