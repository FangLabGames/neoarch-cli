/// ASCII HUD — a live terminal dashboard rendered alongside the agent loop.
/// Pure render module: arena-player.ts assembles a HudState each poll and
/// calls renderHud(); we paint the whole frame with ANSI (no deps, no
/// alt-screen — Ctrl+C leaves the last frame in the scrollback, which is
/// useful for postmortems). Disable with --no-hud or by piping stdout.

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
  status: number; // ROUND_STATUS enum
  tick: number;
  endTick: number; // 0 until the seed lands (SEC-SEED-1)
  phase: { name: string; payloadMod: number; ticksRemaining: number } | null;
  aliveCount: number | null;
  totalAgents: number | null;
  prizeVaultCredits: bigint | null;
  agent: HudAgent | null;
  window: "commit" | "reveal" | "closed";
  windowSecsLeft: number;
  pendingTick: number | null; // commit submitted, reveal outstanding
  lastRevealedTick: number | null;
  lastAction: string | null; // "payload 60% · alpha 25% · craft 15%"
  brain: string; // "LLM anthropic (claude-…)" | "heuristic balanced"
  spendLine: string | null; // "$0.42 / $5.00" in LLM mode
  indexerLink: "off" | "ok" | "error";
  dryRun: boolean;
  logTail: string[];
}

const ESC = "\x1b[";
const R = `${ESC}0m`;
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const YELLOW = `${ESC}33m`;
const CYAN = `${ESC}36m`;

const W = 66; // inner frame width

const STATUS_NAME: Record<number, string> = {
  0: "CREATED",
  1: "REGISTRATION",
  2: "ACTIVE",
  3: "RESOLVED",
  4: "CANCELLED",
  5: "SEEDING",
};

/// Consumption is a flat 1e6/tick — payload in "ticks of food" is the most
/// actionable way to read the stockpile.
const PAYLOAD_CONSUMPTION = 1_000_000n;

const fmt6 = (v: bigint) => (Number(v) / 1e6).toFixed(2);

/// Strip ANSI codes for length math so colored strings pad correctly.
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function padLine(content: string): string {
  const pad = Math.max(0, W - visible(content).length);
  return `║ ${content}${" ".repeat(pad)} ║`;
}

function bar(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const full = Math.round(clamped * width);
  return "█".repeat(full) + `${DIM}${"░".repeat(width - full)}${R}`;
}

function divider(): string {
  return `╟${"─".repeat(W + 2)}╢`;
}

export function renderHud(s: HudState): string {
  const lines: string[] = [];
  const statusName = STATUS_NAME[s.status] ?? `STATUS=${s.status}`;
  const statusColor =
    s.status === 2 ? GREEN : s.status === 3 ? CYAN : s.status === 4 ? RED : YELLOW;

  // ── header ──
  const tickStr = s.endTick > 0 ? `tick ${s.tick}/${s.endTick}` : `tick ${s.tick}`;
  const title = ` NEOARCH ARENA ${DIM}${s.roundAddress.slice(0, 8)}…${R} ${statusColor}${statusName}${R}`;
  const headPad = Math.max(0, W - visible(title).length - visible(tickStr).length - 1);
  lines.push(`╔${"═".repeat(W + 2)}╗`);
  lines.push(`║${title}${" ".repeat(headPad)}${tickStr} ║`);

  // ── round context ──
  const phaseStr = s.phase
    ? `phase ${BOLD}${s.phase.name}${R} ${DIM}(payload ×${s.phase.payloadMod.toFixed(2)}, ${s.phase.ticksRemaining}t left)${R}`
    : `phase ${DIM}—${R}`;
  const aliveStr =
    s.aliveCount !== null && s.totalAgents !== null
      ? `alive ${s.aliveCount}/${s.totalAgents}`
      : "";
  const vaultStr = s.prizeVaultCredits !== null ? `vault ${fmt6(s.prizeVaultCredits)}` : "";
  lines.push(padLine(`${phaseStr}   ${aliveStr}   ${vaultStr}`));

  // ── tick window (active rounds only) ──
  if (s.status === 2) {
    const winColor = s.window === "commit" ? CYAN : s.window === "reveal" ? YELLOW : DIM;
    const winLabel = s.window.toUpperCase().padEnd(6);
    lines.push(
      padLine(
        `window ${winColor}${winLabel}${R} ${bar(
          s.windowSecsLeft / Math.max(s.windowSecsLeft, 60),
          18,
        )} ${String(s.windowSecsLeft).padStart(3)}s left`,
      ),
    );
  }

  lines.push(divider());

  // ── agent vitals ──
  if (s.agent) {
    const a = s.agent;
    const lifeTicks = Number(a.payload / PAYLOAD_CONSUMPTION);
    const aliveBadge = a.alive ? `${GREEN}ALIVE${R}` : `${RED}ELIMINATED${R}`;
    const missBadge =
      a.missCount > 0 ? `  ${RED}miss ${a.missCount}/12 (starving)${R}` : "";
    lines.push(
      padLine(
        `${BOLD}YOU${R} ${DIM}${s.address.slice(0, 6)}…${s.address.slice(-4)}${R}  ${aliveBadge}  tier ${a.moduleTier}${
          a.moduleTier > 0 ? ` ${DIM}dur ${fmt6(a.moduleDurability)}${R}` : ""
        }${missBadge}`,
      ),
    );
    const stockColor = lifeTicks <= 3 ? RED : lifeTicks <= 8 ? YELLOW : GREEN;
    lines.push(
      padLine(
        `payload ${bar(Math.min(lifeTicks / 20, 1), 12)} ${stockColor}${fmt6(a.payload)}${R} ${DIM}(≈${lifeTicks}t food)${R}  credits ${fmt6(a.credits)}  alpha ${fmt6(a.alphaBalance)}`,
      ),
    );
    lines.push(
      padLine(
        `throughput allowance ${fmt6(a.throughputAllowance)} ${DIM}/ cap ${fmt6(a.throughputCap)}${R}`,
      ),
    );
  } else {
    lines.push(padLine(`${DIM}agent state not loaded yet…${R}`));
  }

  // ── action state machine ──
  const stateBits: string[] = [];
  if (s.lastRevealedTick !== null) stateBits.push(`${GREEN}revealed t${s.lastRevealedTick} ✓${R}`);
  if (s.pendingTick !== null) stateBits.push(`${CYAN}committed t${s.pendingTick}${R} ${DIM}(awaiting reveal)${R}`);
  if (stateBits.length === 0) stateBits.push(`${DIM}no action in flight${R}`);
  lines.push(padLine(`state ${stateBits.join("  →  ")}`));
  if (s.lastAction) lines.push(padLine(`last  ${s.lastAction}`));

  lines.push(divider());

  // ── brain + link footer ──
  const linkStr =
    s.indexerLink === "off"
      ? `${DIM}indexer off${R}`
      : s.indexerLink === "ok"
        ? `${GREEN}♥ indexer linked${R}`
        : `${YELLOW}indexer unreachable${R}`;
  const dryStr = s.dryRun ? `  ${YELLOW}DRY-RUN${R}` : "";
  lines.push(
    padLine(`brain ${s.brain}${s.spendLine ? `  ${DIM}spend${R} ${s.spendLine}` : ""}  ${linkStr}${dryStr}`),
  );

  // ── log tail ──
  if (s.logTail.length > 0) {
    lines.push(divider());
    for (const l of s.logTail.slice(-5)) {
      const trimmed =
        visible(l).length > W ? l.slice(0, Math.max(0, l.length - (visible(l).length - W + 1))) + "…" : l;
      lines.push(padLine(`${DIM}${visible(trimmed)}${R}`));
    }
  }

  lines.push(`╚${"═".repeat(W + 2)}╝`);
  // Clear screen + home cursor, then the frame.
  return `${ESC}2J${ESC}H` + lines.join("\n") + "\n";
}
