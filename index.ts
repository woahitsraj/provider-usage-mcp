#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const CACHES = process.env.T3_CACHES ?? join(homedir(), ".t3/caches");
const CONFIG = process.env.PROVIDER_USAGE_CONFIG ?? join(import.meta.dirname, "models.json");
const KIND_MINS: Record<string, number> = { session: 300, daily: 1440, weekly: 10080, monthly: 43200 };
const STALE_MS = 2 * 3600_000;
const MAX_WEIGHT = 2;

type Window = { id: string; kind: string; label: string; usedPercent: number; resetsAt?: string; windowDurationMins?: number };
type Candidate = { providerInstanceId: string; model: string; options: Record<string, unknown>; quality: number; windows?: string[] };
type Tier = "light" | "standard" | "deep";
// expiry dates of free limit resets, by provider then window id ("*" = every window)
type Credits = Record<string, Record<string, string[]>>;
type Config = { minQuality?: number; preference?: Record<string, number>; resetCredits?: Credits; tiers: Record<Tier, Candidate[]> };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100) / 100;
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const LOCAL = join(dirname(CONFIG), "models.local.json");
const loadConfig = (): Config => ({ ...readJson(CONFIG), ...(existsSync(LOCAL) && readJson(LOCAL)) });

export function scoreWindow(w: Window, credits: string[] = [], now = Date.now()) {
  const durMs = (w.windowDurationMins ?? KIND_MINS[w.kind] ?? 10080) * 60_000;
  const msLeft = w.resetsAt ? Date.parse(w.resetsAt) - now : durMs / 2;
  const timeLeft = clamp(msLeft / durMs, 0.01, 1);
  const used = w.usedPercent / 100;
  const left = 1 - used;
  // >1 means burning faster than even pace
  const pace = used / Math.max(1 - timeLeft, 0.01);
  const live = credits.map(Date.parse).filter((t) => t > now).sort((a, b) => a - b);
  // each credit adds the share of a window it must cover before expiring; a credit expiring this window counts in full
  const creditBonus = live.reduce((s, t) => s + Math.min(1, durMs / Math.max(t - now, msLeft, 1)), 0);
  const weight = left <= 0.03 ? 0 : clamp((left + creditBonus) / timeLeft, 0, MAX_WEIGHT);
  return {
    id: w.id, label: w.label, usedPercent: round(w.usedPercent), timeElapsedPercent: round((1 - timeLeft) * 100), pace: round(pace),
    hoursToReset: round(msLeft / 3600_000), resetCredits: live.length, ...(live.length && { nextCreditExpiresInDays: round((live[0] - now) / 86400_000), creditBonus: round(creditBonus) }),
    weight: round(weight),
    ...(left <= 0.03 && live.length && { hint: `Exhausted. A free reset is available (expires in ${round((live[0] - now) / 86400_000)} days). Ask the user to use it.` }),
  };
}

export function readProviders(now = Date.now()) {
  const manual = loadConfig().resetCredits ?? {};
  return readdirSync(CACHES)
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      try {
        const d = JSON.parse(readFileSync(join(CACHES, f), "utf8"));
        if (!d.enabled || d.status !== "ready") return [];
        const checkedAt = d.usageLimits?.checkedAt;
        const windows: Window[] = d.usageLimits?.windows ?? [];
        const id: string = d.instanceId ?? f.replace(/\.json$/, "");
        const rc = d.usageLimits?.resetCredits;
        // T3's own count wins; manual entries only fill in for providers T3 does not report
        const credits: Record<string, string[]> = rc?.availableCount ? { "*": Array(rc.availableCount).fill(rc.nextExpiresAt) } : manual[id] ?? {};
        return [{
          providerInstanceId: id,
          plan: d.auth?.label,
          stale: !checkedAt || now - Date.parse(checkedAt) > STALE_MS,
          checkedAt,
          windows: windows.map((w) => scoreWindow(w, [...(credits["*"] ?? []), ...(credits[w.id] ?? [])], now)),
        }];
      } catch {
        return [];
      }
    });
}

export function pick(tier: Tier, exclude: string[] = [], now = Date.now()) {
  const providers = new Map(readProviders(now).map((p) => [p.providerInstanceId, p]));
  const cfg = loadConfig();
  return cfg.tiers[tier]
    .flatMap((c) => {
      const p = providers.get(c.providerInstanceId);
      if (!p || exclude.includes(c.providerInstanceId) || c.quality < (cfg.minQuality ?? 0)) return [];
      const ws = p.windows.filter((w) => !c.windows || c.windows.includes(w.id));
      const base = ws.length ? Math.min(...ws.map((w) => w.weight)) : 1;
      const weight = p.stale ? Math.min(base, 1) * 0.75 : base;
      const pref = Object.entries(cfg.preference ?? {}).find(([prefix]) => c.model.startsWith(prefix));
      const quality = c.quality * (pref?.[1] ?? 1);
      return [{ target: { providerInstanceId: c.providerInstanceId, model: c.model, options: c.options }, quality: round(quality), weight: round(weight), score: round(quality * weight), windows: ws, stale: p.stale }];
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.quality - a.quality);
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

const server = new McpServer(
  { name: "provider-usage", version: "0.1.0" },
  {
    instructions:
      "Subscription-aware model routing for T3 Code. Before every delegate_task call, call pick_model with the task's tier and pass the first result's `target` to delegate_task, unless the user named a model or provider. weight < 1 means that subscription is ahead of even pace; weight > 1 means quota will expire unused. Prefer to keep a model for follow-ups on the same delegate thread. Efforts start at medium; if a delegate fails or falls short, retry one effort level higher before switching to a bigger model.",
  },
);

server.registerTool(
  "pick_model",
  {
    description:
      "Rank provider/model/effort targets for a subagent by subscription headroom (T3 Code usage limits). Call before every delegate_task. Tier: light = lookups, search, small edits, summaries; standard = normal features, bug fixes, tests, reviews; deep = architecture, hard debugging, subtle correctness, large refactors.",
    inputSchema: {
      tier: z.enum(["light", "standard", "deep"]),
      exclude: z.array(z.string()).optional().describe("providerInstanceIds to skip, e.g. the parent's own provider for a second opinion"),
    },
  },
  async ({ tier, exclude }) => json(pick(tier, exclude)),
);

server.registerTool(
  "provider_usage",
  { description: "Usage, even-pace ratio, hours to reset, and routing weight for each enabled T3 Code provider subscription.", inputSchema: {} },
  async () => json(readProviders()),
);

if (import.meta.main) await server.connect(new StdioServerTransport());
