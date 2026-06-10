/// LLM provider abstraction — calls Anthropic / OpenAI / OpenAI-compatible
/// endpoints DIRECTLY from your machine.
///
/// Privacy: your API key + game state go straight to the provider. NeoArch
/// never sees either. Spend cap is enforced LOCALLY in this process — at cap
/// we silently fall back to the heuristic. No telemetry, no upload.

import type { AgentSnapshot, LlmDecision } from "./strategy.ts";
import type { OpenAuction } from "./module-market.ts";

export type Provider = "anthropic" | "openai" | "compatible";

interface ModelPricing {
  promptUsdPerM: number;
  completionUsdPerM: number;
}

const PRICING: Record<string, Record<string, ModelPricing>> = {
  anthropic: {
    "claude-opus-4-7": { promptUsdPerM: 15, completionUsdPerM: 75 },
    "claude-sonnet-4-6": { promptUsdPerM: 3, completionUsdPerM: 15 },
    "claude-haiku-4-5": { promptUsdPerM: 1, completionUsdPerM: 5 },
  },
  openai: {
    "gpt-4o": { promptUsdPerM: 2.5, completionUsdPerM: 10 },
    "gpt-4o-mini": { promptUsdPerM: 0.15, completionUsdPerM: 0.6 },
    "gpt-5-mini": { promptUsdPerM: 0.5, completionUsdPerM: 2 },
  },
  compatible: {},
};

const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
  compatible: "",
};

function fallbackPricing(provider: Provider): ModelPricing {
  if (provider === "anthropic") return PRICING.anthropic["claude-sonnet-4-6"];
  if (provider === "openai") return PRICING.openai["gpt-4o-mini"];
  return { promptUsdPerM: 0, completionUsdPerM: 0 };
}

function costMicroUsd(
  provider: Provider,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICING[provider]?.[model] ?? fallbackPricing(provider);
  return Math.round(promptTokens * p.promptUsdPerM + completionTokens * p.completionUsdPerM);
}

export interface LlmConfig {
  provider: Provider;
  apiKey: string;
  model?: string;
  baseUrl?: string;        // for OpenAI-compatible endpoints (DeepSeek, Together, …)
  capUsdMicro: number;     // 0 disables cap
  systemPrompt: string;    // user-supplied strategy guidance, prepended to BASE_PROMPT
}

export interface SpendState {
  totalMicro: number;
  events: number;
  capReached: boolean;
}

const BASE_SYSTEM_PROMPT = `You are an autonomous trading agent in NeoArch — Agent Trade Royale, an economic survival game on Arc Testnet. Your goal is to maximize USDC-backed credits while staying solvent.

Each tick, allocate your throughput budget across three production targets and optionally swap payload/alpha for credits on the on-chain AMM. You consume payload each tick to stay alive; if you accumulate 12 missed ticks (no payload eaten) the contract eliminates you.

MODULE MARKET (in-round, settled in your in-game credits — no outside money):
- SELL: if you own a crafted module (moduleTier > 0) you may list it via workOrders. Listing locks the module IMMEDIATELY (you lose its production multiplier the same tick) and is one-shot per round. The auction is English-style: bids start at minPriceCredits, each later bid must exceed the previous by 5%, highest bid at the deadline wins and lands in YOUR credits.
- BUY: if you own NO module, your state may include OPEN MODULE AUCTIONS. Buying a tier 2-4 module for a few credits is usually far cheaper than many ticks of craftPct, and the production multiplier applies as soon as the auction settles. Emit a moduleBids entry with the auctionId and your maxBidCredits CEILING — the runtime bids the minimum needed to lead (never your ceiling unless required), your credits are escrowed only while you lead, and you are auto-refunded the moment someone outbids you. Don't bid above what the extra production is worth over the round's remaining ticks; never re-bid an auction marked "you lead".

Output ONLY a JSON object matching this exact schema — no prose, no code-fence:
{
  "payloadPct": <number 0-100>,
  "alphaPct":   <number 0-100>,
  "craftPct":   <number 0-100>,
  "swaps": [
    { "market": <0=payload, 1=alpha>, "kind": <0=sell for credits, 1=buy with credits>, "amount": <integer, 6-decimal>, "limitAmount": <integer, 6-decimal> }
  ],
  "workOrders": [
    { "kind": "module-listing", "minPriceCredits": <integer, 6-decimal credits>, "durationSeconds": <integer 300-3600> }
  ],
  "moduleBids": [
    { "kind": "module-bid", "auctionId": <integer from OPEN MODULE AUCTIONS>, "maxBidCredits": <integer, 6-decimal credits> }
  ]
}
Percentages must sum to 100. swaps / workOrders / moduleBids may be empty arrays. Max 3 swaps, 1 workOrder, 1 moduleBid per tick.
All amounts are 6-decimal integers (2500000 = 2.5) — plain integers, no underscores or scientific notation.
For a SELL swap, limitAmount is the minimum credits you'll accept (0 = any). For a BUY swap, limitAmount is the max credits you'll spend (must be > 0 or the buy is a no-op).`;

export class LlmClient {
  private spend: SpendState = { totalMicro: 0, events: 0, capReached: false };

  constructor(private config: LlmConfig) {
    if (!config.apiKey) throw new Error("LlmClient: apiKey is required");
    this.config.model = config.model || DEFAULT_MODELS[config.provider];
  }

  getSpend(): SpendState {
    return { ...this.spend };
  }

  /// Ask the LLM for a decision. Returns null on:
  ///   - cap reached (silent fallback to heuristic)
  ///   - HTTP error
  ///   - JSON parse failure
  /// Caller should treat null as "use heuristic for this tick".
  async callForDecision(
    snapshot: AgentSnapshot,
    tick: number,
    openAuctions: OpenAuction[] = [],
  ): Promise<LlmDecision | null> {
    if (this.spend.capReached) return null;

    const userPrompt = this.buildUserPrompt(snapshot, tick, openAuctions);
    const systemPrompt =
      this.config.systemPrompt.trim().length > 0
        ? `${BASE_SYSTEM_PROMPT}\n\nADDITIONAL STRATEGY GUIDANCE FROM YOUR OPERATOR:\n${this.config.systemPrompt}`
        : BASE_SYSTEM_PROMPT;

    try {
      if (this.config.provider === "anthropic") {
        return await this.callAnthropic(systemPrompt, userPrompt);
      }
      // openai + compatible share the chat-completions schema
      return await this.callOpenAIish(systemPrompt, userPrompt);
    } catch {
      return null;
    }
  }

  private buildUserPrompt(s: AgentSnapshot, tick: number, openAuctions: OpenAuction[] = []): string {
    // Arc/USDC migration: credits + payload + alpha + throughput are all 6dp
    // (matches USDC). 1 credit = 1 USDC at round-end redemption.
    const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(2);
    const auctionLines =
      openAuctions.length > 0
        ? [
            ``,
            `OPEN MODULE AUCTIONS (this round; you own no module, so you may bid):`,
            ...openAuctions.map(
              (a) =>
                `  auctionId=${a.auctionId.toString()} tier=${a.tier} durability=${a.durability.toString()}` +
                ` minNextBid=${a.minNextBid.toString()} (${fmt(a.minNextBid)} credits)` +
                ` closesIn=${a.secondsLeft}s${a.weLead ? " [you lead]" : ""}`,
            ),
          ]
        : [];
    return [
      `STATE (tick ${tick}):`,
      `  alive: ${s.alive}`,
      `  payload: ${fmt(s.payload)}    (consume 1/tick → deficit if you can't keep up)`,
      `  credits: ${fmt(s.credits)}    (USDC-backed; redeemed at round end)`,
      `  alphaBalance: ${fmt(s.alphaBalance)}`,
      `  moduleTier: ${s.moduleTier}      (0=bare, 1=bronze, 2=iron, 3=silver, 4=golden)`,
      `  throughput budget: ${fmt(s.throughputAllowance)}    (allocate exactly this across payload/alpha/craft; = base ${fmt(s.throughputCap)} × the live regime/phase modifier, clamped; drops as missCount grows)`,
      `  missCount: ${s.missCount} / 12  (eliminated at 12)`,
      ...auctionLines,
      ``,
      `Decide your allocation now. Output the JSON only.`,
    ].join("\n");
  }

  private async callAnthropic(systemPrompt: string, userPrompt: string): Promise<LlmDecision | null> {
    const model = this.config.model!;
    const baseUrl = this.config.baseUrl ?? "https://api.anthropic.com";
    const resp = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512, // headroom for the full schema (allocations + swaps + a workOrder/moduleBid); 256 truncated rich responses → parse-fail → fallback
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!resp.ok) return null;
    const json = (await resp.json()) as any;
    const text = json?.content?.[0]?.text ?? "";
    const inputTokens = json?.usage?.input_tokens ?? 0;
    const outputTokens = json?.usage?.output_tokens ?? 0;
    this.recordSpend(model, inputTokens, outputTokens);
    return parseJsonDecision(text);
  }

  private async callOpenAIish(systemPrompt: string, userPrompt: string): Promise<LlmDecision | null> {
    const model = this.config.model!;
    const baseUrl =
      this.config.baseUrl ??
      (this.config.provider === "openai" ? "https://api.openai.com" : "");
    if (!baseUrl) {
      throw new Error("compatible provider requires --base-url");
    }
    const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 512, // headroom for the full schema (allocations + swaps + a workOrder/moduleBid); 256 truncated rich responses → parse-fail → fallback
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!resp.ok) return null;
    const json = (await resp.json()) as any;
    const text = json?.choices?.[0]?.message?.content ?? "";
    const inputTokens = json?.usage?.prompt_tokens ?? 0;
    const outputTokens = json?.usage?.completion_tokens ?? 0;
    this.recordSpend(model, inputTokens, outputTokens);
    return parseJsonDecision(text);
  }

  private recordSpend(model: string, prompt: number, completion: number): void {
    const cost = costMicroUsd(this.config.provider, model, prompt, completion);
    this.spend.totalMicro += cost;
    this.spend.events += 1;
    if (this.config.capUsdMicro > 0 && this.spend.totalMicro >= this.config.capUsdMicro) {
      this.spend.capReached = true;
    }
  }
}

function parseJsonDecision(text: string): LlmDecision | null {
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as LlmDecision;
  } catch {
    return null;
  }
}

export function formatSpend(state: SpendState): string {
  const dollars = (state.totalMicro / 1_000_000).toFixed(4);
  return `$${dollars} over ${state.events} call${state.events === 1 ? "" : "s"}${state.capReached ? " (CAP REACHED — heuristic fallback)" : ""}`;
}
