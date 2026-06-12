/// ASCII HUD v2 — a live terminal dashboard rendered alongside the agent loop.
/// Pure render module: arena-player.ts assembles a HudState each poll and
/// calls renderHud(); we paint the whole frame with ANSI (no alt-screen —
/// Ctrl+C leaves the last frame in scrollback for postmortems). Disable with
/// --no-hud or by piping stdout.
///
/// Iconography is deliberately single-width unicode (● ☀ ❄ ⚡ ≋ ▲ ▼ ♥ ✓ ✗ and
/// the ▁▂▃▄▅▆▇█ spark ramp) — double-width emoji break column math in most
/// terminals.

export interface HudAgent {
  alive: boolean;
  payload: bigint;
  credits: bigint;
  alphaBalance: bigint;
  moduleTier: number;
  moduleDurability: bigint;
  throughputCap: bigint;
  throughputAllowance: bigint;
  missCount: number;
}

export interface HudState {
  address: string;
  roundAddress: string;
  roundId: number | null;
  status: number; // ROUND_STATUS enum
  tick: number;
  endTick: number; // 0 until the seed lands (SEC-SEED-1)
  tickDurationSec: number;
  phase: { name: string; payloadMod: number; ticksRemaining: number } | null;
  aliveCount: number | null;
  totalAgents: number | null;
  prizeVaultCredits: bigint | null;
  agent: HudAgent | null;
  agentStale: boolean;
  /// Recent payload samples (6dp ints as numbers) for the sparkline, oldest first.
  payloadHistory: number[];
  /// Per-render deltas vs the previous frame (null on the first frame).
  deltas: { payload: bigint; credits: bigint; alpha: bigint } | null;
  window: "commit" | "reveal" | "closed";
  windowSecsLeft: number;
  windowTotalSecs: number;
  pendingTick: number | null;
  lastRevealedTick: number | null;
  lastAction: string | null;
  brain: string;
  spendUsd: number | null; // LLM spend so far (USD)
  capUsd: number | null; // cap (USD); 0/null = uncapped
  indexerLink: "off" | "ok" | "error";
  dryRun: boolean;
  logTail: string[];
}

const ESC = "\x1b[";
const R = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RED = `${ESC}31m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const MAGENTA = `${ESC}35m`;
const CYAN = `${ESC}36m`;
const BR_GREEN = `${ESC}92m`;
const BR_YELLOW = `${ESC}93m`;
const BR_BLUE = `${ESC}94m`;
const BR_MAGENTA = `${ESC}95m`;
const BR_CYAN = `${ESC}96m`;

const W = 70; // inner frame width

const STATUS_NAME: Record<number, string> = {
  0: "CREATED",
  1: "REGISTRATION",
  2: "ACTIVE",
  3: "RESOLVED",
  4: "CANCELLED",
  5: "SEEDING",
};

/// Phase styling — icon + color tuned to the vibe of each regime phase.
const PHASE_STYLE: Record<string, { icon: string; color: string }> = {
  EXPANSION: { icon: "☀", color: BR_GREEN },
  "LOAD SHOCK": { icon: "⚡", color: BR_YELLOW },
  FREEZE: { icon: "❄", color: BR_BLUE },
  CONGESTION: { icon: "≋", color: BR_MAGENTA },
};

const PAYLOAD_CONSUMPTION = 1_000_000n;
const SPARK = "▁▂▃▄▅▆▇█";

const fmt6 = (v: bigint) => (Number(v) / 1e6).toFixed(2);
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function padLine(content: string): string {
  let c = content;
  if (visible(c).length > W) {
    c = `${DIM}${visible(c).slice(0, W - 1)}…${R}`;
  }
  const pad = Math.max(0, W - visible(c).length);
  return `║ ${c}${" ".repeat(pad)} ║`;
}

function bar(ratio: number, width: number, color = ""): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const full = Math.round(clamped * width);
  return `${color}${"█".repeat(full)}${R}${DIM}${"░".repeat(width - full)}${R}`;
}

function sparkline(samples: number[], width: number): string {
  if (samples.length < 2) return `${DIM}${"·".repeat(width)}${R}`;
  const take = samples.slice(-width);
  const min = Math.min(...take);
  const max = Math.max(...take);
  const span = Math.max(1, max - min);
  const ramp = take
    .map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor(((v - min) / span) * SPARK.length))])
    .join("");
  const rising = take[take.length - 1] >= take[0];
  return `${rising ? GREEN : RED}${ramp}${R}`;
}

function delta(v: bigint): string {
  if (v === 0n) return "";
  return v > 0n ? ` ${BR_GREEN}▲${fmt6(v)}${R}` : ` ${RED}▼${fmt6(-v)}${R}`;
}

function eta(ticksLeft: number, tickSec: number): string {
  const s = ticksLeft * tickSec;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h >= 1 ? `~${h}h ${m}m` : `~${m}m`;
}

function divider(): string {
  return `╟${"─".repeat(W + 2)}╢`;
}

export function renderHud(s: HudState): string {
  const lines: string[] = [];
  const statusName = STATUS_NAME[s.status] ?? `STATUS=${s.status}`;
  const statusColor =
    s.status === 2 ? BR_GREEN : s.status === 3 ? BR_CYAN : s.status === 4 ? RED : YELLOW;

  // ── header: round + status + tick + ETA ──
  const tickStr =
    s.endTick > 0
      ? `tick ${s.tick}/${s.endTick} ${DIM}${eta(Math.max(0, s.endTick - s.tick), s.tickDurationSec)}${R}`
      : `tick ${s.tick}`;
  const title = ` ${BOLD}NEOARCH${R} ${s.roundId !== null ? `R${s.roundId}` : ""} ${DIM}${s.roundAddress.slice(0, 8)}…${R} ${statusColor}${BOLD}${statusName}${R}`;
  const headPad = Math.max(1, W + 1 - visible(title).length - visible(tickStr).length);
  lines.push(`╔${"═".repeat(W + 2)}╗`);
  lines.push(`║${title}${" ".repeat(headPad)}${tickStr} ║`);

  // ── phase banner ──
  const ph = s.phase ? PHASE_STYLE[s.phase.name] : null;
  const phaseStr = s.phase
    ? `${ph?.color ?? ""}${ph?.icon ?? "·"} ${BOLD}${s.phase.name}${R} ${DIM}payload ×${s.phase.payloadMod.toFixed(2)} · ${s.phase.ticksRemaining}t left${R}`
    : `${DIM}· phase unknown${R}`;
  const aliveStr =
    s.aliveCount !== null && s.totalAgents !== null
      ? `${BR_GREEN}●${R}${s.aliveCount}${DIM}/${s.totalAgents}${R}`
      : "";
  const vaultStr = s.prizeVaultCredits !== null ? `${DIM}vault${R} ${fmt6(s.prizeVaultCredits)}` : "";
  lines.push(padLine(`${phaseStr}   ${aliveStr}   ${vaultStr}`));

  // ── tick window ──
  if (s.status === 2) {
    const winColor = s.window === "commit" ? BR_CYAN : s.window === "reveal" ? BR_YELLOW : DIM;
    const winIcon = s.window === "commit" ? "✎" : s.window === "reveal" ? "◉" : "·";
    lines.push(
      padLine(
        `${winColor}${winIcon} ${s.window.toUpperCase().padEnd(6)}${R} ${bar(
          s.windowSecsLeft / Math.max(1, s.windowTotalSecs),
          20,
          winColor,
        )} ${String(s.windowSecsLeft).padStart(3)}s`,
      ),
    );
  }

  lines.push(divider());

  // ── agent vitals ──
  if (s.agent) {
    const a = s.agent;
    const runwayTicks = Number(a.payload / PAYLOAD_CONSUMPTION);
    const aliveBadge = a.alive ? `${BR_GREEN}● ALIVE${R}` : `${RED}✗ ELIMINATED${R}`;
    const staleBadge = s.agentStale ? ` ${YELLOW}(stale — rpc failing)${R}` : "";
    const missBadge =
      a.missCount > 0 ? `  ${RED}⚠ starving ${a.missCount}/12${R}` : "";
    const tierStr =
      a.moduleTier > 0
        ? `${BR_CYAN}◆T${a.moduleTier}${R} ${DIM}dur ${fmt6(a.moduleDurability)}${R}`
        : `${DIM}◇T0${R}`;
    lines.push(
      padLine(
        `${BOLD}YOU${R} ${DIM}${s.address.slice(0, 6)}…${s.address.slice(-4)}${R}  ${aliveBadge}${staleBadge}  ${tierStr}${missBadge}`,
      ),
    );
    const runwayColor = runwayTicks <= 3 ? RED : runwayTicks <= 8 ? BR_YELLOW : BR_GREEN;
    lines.push(
      padLine(
        `payload ${bar(Math.min(runwayTicks / 20, 1), 12, runwayColor)} ${runwayColor}${fmt6(a.payload)}${R} ${DIM}(≈${runwayTicks}t runway)${R}${delta(s.deltas?.payload ?? 0n)}`,
      ),
    );
    lines.push(
      padLine(
        `trend   ${sparkline(s.payloadHistory, 24)}  ${DIM}credits${R} ${fmt6(a.credits)}${delta(s.deltas?.credits ?? 0n)}  ${DIM}alpha${R} ${fmt6(a.alphaBalance)}${delta(s.deltas?.alpha ?? 0n)}`,
      ),
    );
    lines.push(
      padLine(`budget  ${DIM}throughput${R} ${fmt6(a.throughputAllowance)} ${DIM}/ cap ${fmt6(a.throughputCap)}${R}`),
    );
  } else {
    lines.push(padLine(`${DIM}agent state not loaded yet…${R}`));
  }

  // ── action state ──
  const stateBits: string[] = [];
  if (s.lastRevealedTick !== null) stateBits.push(`${BR_GREEN}✓ revealed t${s.lastRevealedTick}${R}`);
  if (s.pendingTick !== null) stateBits.push(`${BR_CYAN}✎ committed t${s.pendingTick}${R} ${DIM}(awaiting reveal)${R}`);
  if (stateBits.length === 0) stateBits.push(`${DIM}no action in flight${R}`);
  lines.push(padLine(`state   ${stateBits.join("  →  ")}`));
  if (s.lastAction) lines.push(padLine(`last    ${CYAN}${s.lastAction}${R}`));

  lines.push(divider());

  // ── brain + spend + link footer ──
  const linkStr =
    s.indexerLink === "off"
      ? `${DIM}indexer off${R}`
      : s.indexerLink === "ok"
        ? `${BR_GREEN}♥ linked${R}`
        : `${YELLOW}indexer unreachable${R}`;
  const spendStr =
    s.spendUsd !== null && s.capUsd
      ? `${DIM}spend${R} ${bar(s.spendUsd / s.capUsd, 8, s.spendUsd / s.capUsd > 0.8 ? RED : MAGENTA)} $${s.spendUsd.toFixed(2)}${DIM}/$${s.capUsd.toFixed(0)}${R}`
      : s.spendUsd !== null
        ? `${DIM}spend${R} $${s.spendUsd.toFixed(2)}`
        : "";
  const dryStr = s.dryRun ? `  ${BR_YELLOW}DRY-RUN${R}` : "";
  lines.push(padLine(`${MAGENTA}⚙${R} ${s.brain}  ${spendStr}  ${linkStr}${dryStr}`));

  // ── log tail ──
  if (s.logTail.length > 0) {
    lines.push(divider());
    for (const l of s.logTail.slice(-5)) {
      const vis = visible(l);
      const trimmed = vis.length > W ? vis.slice(0, W - 1) + "…" : vis;
      // Re-tint after stripping: errors red, confirmations green, rest dim.
      const tint = /✗|revert|failed|error/i.test(trimmed)
        ? RED
        : /✓|relayed|published|settled|joined/i.test(trimmed)
          ? GREEN
          : DIM;
      lines.push(padLine(`${tint}${trimmed}${R}`));
    }
  }

  lines.push(`╚${"═".repeat(W + 2)}╝`);
  return `${ESC}2J${ESC}H` + lines.join("\n") + "\n";
}
