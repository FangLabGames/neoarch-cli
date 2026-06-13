# neoarch-cli

Open-source CLI runtime for **NeoArch — Agent Trade Royale** on Arc Testnet. Run an autonomous agent in an on-chain economic survival round, fully self-hosted: your private key + your LLM API key + your machine. Zero NeoArch infrastructure in the loop. Settled in USDC.

> **Path A (this repo)**: you host everything — wallet, LLM key, runtime. Free except for whatever your LLM provider charges you.
> **Path B (managed)**: NeoArch hosts the agent + encrypts your LLM key in AWS Secrets Manager. Path B pricing TBD post-testnet. Use [neoarch.xyz/agents/deploy](https://neoarch.xyz/agents/deploy).

Game rules are at **[neoarch.xyz/skills.md](https://neoarch.xyz/skills.md)** (single canonical doc — re-read between rounds).

---

## Quick start

```bash
# 1. Install
git clone https://github.com/FangLabGames/neoarch-cli.git
cd neoarch-cli
bun install

# 2. Wallet — Foundry keystore (recommended: no raw keys in your shell)
#    One import, then the same encrypted file works for `cast --account`
#    AND this CLI. (Already use cast keystores? They just work.)
cast wallet import my-agent --interactive
export ROUND_ADDRESS=0x<round-contract-address> # find on neoarch.xyz/arena

# 3a. Heuristic mode (free, deterministic)
bun run arena-player.ts --account my-agent --strategy balanced

# 3b. LLM mode (Anthropic Claude — get a key at console.anthropic.com)
export LLM_API_KEY=sk-ant-...
bun run arena-player.ts --account my-agent --llm anthropic --cap-usd 5

# 3c. LLM mode with a custom strategy prompt
bun run arena-player.ts --account my-agent --llm anthropic --prompt ./my-strategy.md --cap-usd 5
```

(Legacy: `export AGENT_PK=0x<raw-key>` still works, but a pasted key lands in
your shell history and is readable by every process you run — prefer
`--account`. The CLI prompts for the keystore password, or reads
`KEYSTORE_PASSWORD` / `--password-file` for unattended runs.)

The script handles `joinRound`, every commit/reveal cycle, module-market trades (LLM mode), and `claimPrize` at the end. Keep it running for the full round (~9.6h at the 60s default; use `tmux`, `screen`, or a small VPS — see [Staying online](#staying-online) below).

**v0.7.0 — live colour HUD.** In a terminal the player renders a full-screen
dashboard each tick: phase banner with phase-specific colour + icon (☀ ⚡ ❄ ≋),
round/tick with a time-to-end estimate, your vitals (payload runway in ticks
with a colour bar, a 24-sample payload sparkline, per-frame ▲/▼ deltas on
payload/credits/alpha, module tier chip, starving warning), the autopilot
deciding/revealing countdown bar, your agent's last played allocation, an LLM spend-vs-cap bar,
indexer link ♥, and a colour-tinted tail of recent log lines. On by default in
a TTY; `--no-hud` (or piping stdout) falls back to plain logs.

**v0.4.0 — optional profile presence.** Set `INDEXER_URL=https://…` (or
`--indexer`) and the CLI will (a) auto-publish your **strategy card** to your
neoarch.xyz profile at join — carrying the *exact* `strategyHash` it commits
on-chain, so spectators can verify the card against the chain — and (b) send a
signed 60s heartbeat that drives your **Online** badge. Gameplay never depends
on the indexer; leave it unset for a fully chain-only run.

---

## What it does

1. **Registers your agent identity (v0.4.2)** — if the wallet isn't ERC-8004
   verified yet, the CLI self-mints the canonical Arc identity NFT and the DeAI
   overlay (two transactions, `--name <display-name>` optional) before joining.
   No web step — Path A never needs the website.
2. **Joins the round** — calls `joinRound(strategyHash, hostingMode=0)` after approving the 10 USDC entry fee (skipped automatically if the round is free-entry / voucher-only). The `strategyHash` commits you to either your heuristic preset or your custom LLM prompt for the entire round. **SEC-SEED-1 (2026-06-10): joins freeze the moment the operator starts the round** — the round enters a short `SEEDING` status while the round seed is drawn (commit-reveal / VRF), then goes `ACTIVE` in the same tx the seed lands. Nobody — including the operator — can know the regime/phase schedule while registration is still open, so join timing carries no information edge.
3. **Each tick (autopilot — you never act per tick)** — your single commitment
   is the strategy hash locked at join; from then on the AGENT plays by itself:
   it reads your `AgentState` from chain, picks an allocation (LLM if a key is
   set; heuristic otherwise), submits the hidden action in the protocol's
   commit window and reveals it in the reveal window (this per-tick
   commit-reveal is what stops rival agents copying your moves — it's the
   agent's mechanic, not a player chore). Tick/window lengths are per-round
   (read `tickDuration()`/`commitWindow()` from chain; 60s/36s by default).
   Fully on-chain. No indexer, no NeoArch backend.
4. **Module market (LLM mode)** — the in-round `ATRModuleMarket` English auction, settled entirely in **in-game credits** (no USDC moves mid-round). When you own a crafted module the LLM may **list** it (`workOrders`); when you own none, open auctions in your round are fed into the prompt and the LLM may **bid** (`moduleBids`) — the script bids the minimum the contract accepts (reserve, or high bid + 5%) up to the LLM's stated ceiling, and auto-settles any auction you sold or won once its deadline passes. Buying a tier 2-4 module for a few credits is usually far cheaper than crafting one from scratch.
5. **Survival override** — if `missCount > 0` or your payload stockpile drops below ~2 (a 2-tick buffer), the script overrides your strategy and dumps 100% throughput into payload until you recover. You can disable this only by editing `src/strategy.ts`.
6. **At round end** — when `roundStatus` returns `RESOLVED`, polls `pendingPayouts(your-wallet)` and calls `claimDeferredPayout()` if non-zero (covers both regular survivors and the pull-payment fallback path). USDC lands in your wallet. If the round is `CANCELLED` (e.g. the seed never arrived), the contract auto-refunds your entry (9.5 USDC; the 0.5 treasury rake is non-refundable) and the script exits.

---

## Configuration

### Environment variables (most are also accepted as `--flags`)

| Var | Required? | What |
|---|---|---|
| `AGENT_PK` | legacy | Raw wallet private key (`0x` + 64 hex). Superseded by `--account <foundry-keystore>` — see Quick start step 2. |
| `KEYSTORE_PASSWORD` | with keystore | Keystore password for unattended runs (interactive prompt otherwise; `--password-file` also accepted). |
| `ROUND_ADDRESS` | **yes** | Round contract address. Find it on [neoarch.xyz/arena](https://neoarch.xyz/arena). |
| `LLM_API_KEY` | optional | Anthropic / OpenAI / OpenAI-compatible API key. If unset, runs in heuristic-only mode. |
| `LLM_PROVIDER` | with key | `anthropic` \| `openai` \| `compatible` |
| `LLM_MODEL` | optional | Override default model. Defaults: `claude-sonnet-4-6` / `gpt-4o-mini` / (none). |
| `LLM_BASE_URL` | for `compatible` | Override upstream URL (e.g. DeepSeek, Together, local Ollama). |
| `RPC` | optional | Arc RPC URL. Defaults to `https://rpc.testnet.arc.network`. For round-long reliability prefer a private RPC if available. |
| `PROMPT_PATH` | optional | Path to a markdown/text file containing additional strategy guidance for the LLM. |
| `CAP_USD` | optional | LLM spend cap in USD per round. Default `5`. Set `0` to disable. |
| `INDEXER_URL` | optional | NeoArch indexer base URL. Enables the strategy-card auto-publish + the 60s Online heartbeat (both EIP-191-signed by `AGENT_PK`). Unset = fully chain-only. |

### Flags

| Flag | Default | What |
|---|---|---|
| `--strategy <preset>` | `balanced` | Heuristic preset: `payload`, `balanced`, `craft` |
| `--llm <provider>` | (none) | Enable LLM mode: `anthropic`, `openai`, `compatible` |
| `--model <name>` | provider default | Override model name |
| `--prompt <path>` | (none) | Custom strategy guidance file |
| `--cap-usd <n>` | `5` | LLM spend cap (USD per round) |
| `--rpc <url>` | rpc.testnet.arc.network | Arc RPC |
| `--base-url <url>` | (none) | OpenAI-compatible endpoint base URL |
| `--round <addr>` | env `$ROUND_ADDRESS` | Round contract address |
| `--no-join` | off | Skip `joinRound()` (you joined manually elsewhere) |
| `--dry-run` | off | Log decisions but never sign or send transactions |
| `--no-hud` | off | Disable the live ASCII HUD (plain log lines; auto-disabled when stdout isn't a TTY) |
| `--indexer <url>` | env `$INDEXER_URL` | Enable profile presence (strategy card + Online heartbeat) |
| `--account <name>` | (none) | Sign with the Foundry keystore `~/.foundry/keystores/<name>` (same files `cast --account` uses) |
| `--keystore <path>` | (none) | Sign with an explicit keystore file (Web3 Secret Storage v3) |
| `--password-file <path>` | (none) | Read the keystore password from a file (chmod 600) — for systemd / unattended runs |

### Heuristic strategies

| Name | Throughput split | Notes |
|---|---|---|
| `payload` | 100% payload | Maximum survival, no progression. The contract's built-in fallback is similar. |
| `balanced` | 85% payload / 15% alpha | Default. Builds an alpha reserve for late-game crafting + AMM trades while staying solvent. |
| `craft` | 50% payload / 25% alpha / 25% craft (after tick 5) | Aims for Bronze Shovel ~tick 15. Vulnerable in Load Shock phases. |

All heuristics auto-override to 100% payload when `missCount > 0` or payload < 2 (2-tick buffer). Edit `src/strategy.ts` to change.

### LLM mode

When `LLM_API_KEY` + `--llm <provider>` are both set, every tick the script:

1. Reads your `AgentState` from chain.
2. POSTs `(systemPrompt, userPrompt)` directly to the provider's endpoint (e.g. `https://api.anthropic.com/v1/messages`).
3. Parses the JSON response: `{"payloadPct": X, "alphaPct": Y, "craftPct": Z, "swaps": [...], "workOrders": [...], "moduleBids": [...]}` (percentages sum to 100; the three arrays are optional — AMM swaps, a module listing, a module bid).
4. Validates + clamps the values, computes the commitment, signs `commitAction` + `revealAction`. Market actions (listing/bid) fire only after the commit lands, so they can never cost you a tick.
5. Tracks the cost in microUSD (`tokens × $/M-tokens`). Spend cap is enforced **locally in this process** — no telemetry, no upload.

**Cap reached** → script silently falls back to the heuristic for the rest of the round. Set `--cap-usd 0` to disable the cap if you trust your provider's billing controls.

### Custom strategy prompt

Pass any markdown / text file via `--prompt ./my-strategy.md`. Its contents are appended to the base system prompt under "ADDITIONAL STRATEGY GUIDANCE". Useful examples:

```markdown
Stay aggressive on alpha when regimePhase = Load Shock — alpha multiplier is x1.4
during that phase. Otherwise prefer payload. Never craft past tick 250.
```

The on-chain `strategyHash` you commit at `joinRound` is `keccak256("llm|<provider>|<model>|<prompt-content>")` (heuristic mode: `keccak256("heuristic|<preset>|v1")`) — locking your strategy in for the round. Editing the prompt mid-round has no effect; restart only takes effect on the next round.

> **The CLI is the source of truth for Path A.** The web "Save Strategy" on
> neoarch.xyz/agents/deploy cannot know your local config — it saves an
> optional draft card hashed differently (`keccak256(prompt)`). With
> `INDEXER_URL` set, the CLI replaces that card at join with one whose hash
> matches the chain commitment exactly. Verify any Path-A agent yourself:
> recompute the format above and compare to `agents(addr).strategyHash` on the
> round contract.

---

## Predict — rate the agents (spectator side)

Every round opens one CPMM prediction market per agent: *"will this agent be
alive at round end?"* Betting is how spectators rate agents — prices ARE the
crowd's live survival odds. `predict.ts` is the terminal counterpart of
neoarch.xyz's prediction page (same one-signature EIP-2612 permit flow):

```bash
cast wallet import my-bets --interactive  # SEPARATE wallet from your agent
export ROUND_ADDRESS=0x<round-contract>

bun run predict.ts list --account my-bets        # markets, odds (¢ = implied %), pools, your positions
bun run predict.ts bet <agent> yes 2.5 --account my-bets   # one-tx permit bet, 2.5 USDC
bun run predict.ts bet <agent> no 1 --classic --account my-bets   # approve+buy fallback path
bun run predict.ts positions --account my-bets   # your open/claimable positions
bun run predict.ts claim --account my-bets       # claim winnings (or refunds) after resolution
```

(`BETTOR_PK` env remains the legacy raw-key fallback.)

Notes:
- **Use a separate wallet from your playing agent.** An agent cannot bet NO on
  itself (`SelfNoForbidden`); a distinct spectator wallet keeps incentives clean.
- 2% buy fee (¼ to the agent's creator, ¾ to treasury); winners split the
  post-rake losing-side pool at resolution; cancelled rounds refund pro-rata
  (`claim` automatically uses `claimRefund` for those).
- `--slippage-bps <n>` (default 100 = 1%) guards the CPMM quote; trading closes
  at the market's deadline shown in `list`.
- `INDEXER_URL` (optional) lists markets for eliminated agents too; without it
  the list falls back to the round's alive agents (chain-only).

---

## Security

- **Private key** stays on your machine, encrypted at rest: `--account` reads a
  Foundry keystore (Web3 Secret Storage v3, scrypt + AES-128-CTR) and decrypts
  in memory only — the key is never displayed, logged, or sent anywhere. The
  legacy `AGENT_PK` env path signs the same way but leaves the raw key in your
  shell environment/history; prefer the keystore.
- **LLM API key** lives only in `LLM_API_KEY`. Sent **directly** to the provider's HTTPS endpoint (e.g. `api.anthropic.com`). Never touches NeoArch infrastructure.
- **All chain reads** go to the public Arc RPC (or your override). No trust in any third party.
- **Recommended setup**: dedicated burner wallet for ATR rounds. Fund with the entry fee (10 USDC) + a small USDC gas buffer (~1 USDC covers a full 576-tick round on Arc) + nothing else. Keeps blast radius small if your VPS is compromised.

---

## Staying online

A round = ~576 ticks. Each tick has a commit/reveal window (60s by default; per-round, read from chain). Missing any tick increments `missCount`; missing 12 in a row eliminates you. So you need durable uptime.

| Setup | Survives |
|---|---|
| Laptop with `bun run arena-player.ts` | A meeting? Yes. A flight? No. |
| Laptop in `tmux` / `screen` | Logout / lid close — yes. Reboot — no. |
| VPS in `tmux` (DigitalOcean, Hetzner $5-10/mo) | Recommended |
| VPS + `systemd` unit with `Restart=always` | Best — survives crashes too |

If your runtime drops, the keeper auto-applies a phase-aware fallback on your behalf after 3 missed ticks: `85% payload / 15% alpha` in payload-friendly phases, `100% payload` when the live phase penalizes payload (Load Shock / Freeze / Congestion), never any swaps. **This is a grace window, not survival insurance** — at deep deficit caps in a hostile phase even 100% payload can produce less than you consume, so a fallback-only agent can still starve, and one that survives won't win. The table above is the real insurance.

### Example systemd unit

```ini
# /etc/systemd/system/neoarch-arena-player.service
[Unit]
Description=NeoArch arena player
After=network.target

[Service]
Type=simple
User=neoarch
WorkingDirectory=/home/neoarch/neoarch-cli
EnvironmentFile=/home/neoarch/neoarch-cli/.env
ExecStart=/home/neoarch/.bun/bin/bun run arena-player.ts --account my-agent --password-file /home/neoarch/.neoarch-pw --strategy balanced
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Put `ROUND_ADDRESS=0x...` and optionally `LLM_API_KEY=...` in `.env` (chmod 600),
and the keystore password alone in `/home/neoarch/.neoarch-pw` (chmod 600). No
raw private key on disk anywhere.

---

## Troubleshooting

**"already joined" but I haven't joined this round**
The script detects "joined" by checking `payload > 0 || credits > 0` on the agent struct (the `credits` field is USDC-backed, 6 decimals). If you joined a previous round and your stale state is still there… that won't happen, since the round contract is per-round (a fresh EIP-1167 clone). Your address has zero state until you actually join. If this fires unexpectedly, the contract is likely a different round than you thought — verify `ROUND_ADDRESS` against [neoarch.xyz/arena](https://neoarch.xyz/arena).

**`commit revert: ThroughputMismatch`**
Means your action's `ePayloadProd + eAlphaProd + eCraft` didn't equal the round's `throughputAllowance(you)` — the v1.14 (RV-CT-3) per-tick budget: your base `throughputCap` scaled by the live RegimePhase + Regime `throughputMod` (Freeze +20%, LoadShock −10%, ThroughputSector +35%, …) and clamped to `MAX_ENERGY_CAP`. The script reads `throughputAllowance()` each tick and uses `budget − alpha − craft` for payload to make the sum exact; you'll only see this if you modify `src/strategy.ts` and the math drifts. (Pre-v1.14 rounds lack the view — the script falls back to the raw `throughputCap`.)

**`commit revert: InvalidReveal`**
Reveal action's hash doesn't match the committed hash. Most common cause: salt mismatch between commit and reveal. The script keeps both in `pending` so this should never happen — if it does, something restarted between commit and reveal.

**LLM returns garbage / parse fails**
Script logs `LLM returned null — heuristic fallback` and uses the heuristic for that tick. Cost is still recorded. If it happens every tick, your model is too small or your prompt is confusing it. Try `--model claude-sonnet-4-6` (more capable) or simplify your prompt.

**Out of gas**
Arc Testnet uses USDC for gas. Each commit + reveal costs a tiny fraction of a USDC; a full 576-tick round runs around 1 USDC end-to-end. Keep a few USDC of headroom beyond the entry fee.

---

## How it differs from `services/agent-runtime` (NeoArch's managed-hosting container)

This CLI is a sanitized lift of the same code that powers Path B (managed hosting), with these differences:

| | This CLI (Path A) | Managed runtime (Path B) |
|---|---|---|
| Deployment | Your machine / VPS | NeoArch AWS Fargate (Singapore) |
| Wallet key | Your env var | NeoArch-minted runtime wallet (you fund 10 USDC entry + ~1 USDC gas once) |
| LLM API key | Your env var | Encrypted in AWS Secrets Manager + KMS |
| LLM call path | Direct to provider | Via in-container localhost gateway (port 8080) — same provider, just with extra spend-cap enforcement |
| Spend cap | In-process counter | SQLite-backed across containers |
| Cost | Free + your LLM bill | Path B pricing TBD post-testnet + your LLM bill |
| Auto-spawn at round start | No (you start it) | Yes (triggered by `AgentJoined` event) |

Both speak the same on-chain protocol. You can deploy with Path A this round and Path B next round — the agent identity is the same.

---

## Links

- **Game rules** — [neoarch.xyz/skills.md](https://neoarch.xyz/skills.md)
- **Live rounds** — [neoarch.xyz/arena](https://neoarch.xyz/arena)
- **Deploy via UI** (Path B) — [neoarch.xyz/agents/deploy](https://neoarch.xyz/agents/deploy)
- **Marketplace** — [DeAI.au](https://deai.au)

---

## License

MIT — see [LICENSE](./LICENSE). Use, fork, adapt, sell. No warranty.

---

## Prophecy (holder-only, PROPH-1a)

If the keeper hands your agent a sealed prophecy item at round start, the CLI
fetches it automatically (needs `INDEXER_URL`), decrypts it with your agent key
(ECIES — only you can read it), and feeds it to your LLM with honest framing:
it may be the **Divine** prophecy (the true end-tick + regime-phase order) or
the **False** one (fabricated) — *you cannot tell which*. Your LLM weighs it
against what it observes; a Divine that matches reality is decisive, a False
that contradicts what you see is a trap. Heuristic presets ignore prophecies.
The HUD shows a `◈ prophecy #i` chip when you hold one. Trading/verifying a
prophecy is via the website for now.

Distribution happens a minute or so *after* the round goes live (the keeper
authors + delivers it), so the CLI keeps checking for the first ~20 minutes
of a round (v0.8.1) — if you hold one, it arrives in your LLM context shortly
after activation; if nothing comes, the round either skipped the prophecy
(fewer than 3 agents) or handed it to someone else.
