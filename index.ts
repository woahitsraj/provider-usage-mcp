#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const CACHES = process.env.T3_CACHES ?? join(homedir(), ".t3/caches");
const CONFIG = process.env.PROVIDER_USAGE_CONFIG ?? join(import.meta.dirname, "models.json");
const LOCAL = join(dirname(CONFIG), "models.local.json");
const BENCH = join(dirname(CONFIG), ".cache/benchmarks.json");
const KIND_MINS: Record<string, number> = { session: 300, daily: 1440, weekly: 10080, monthly: 43200 };
const STALE_MS = 2 * 3600_000;
const MAX_WEIGHT = 2;
const MAX_RESULTS = 8;
const NEW_MODEL_DAYS = 60;
const EFFORT_KEYS = ["effort", "reasoningEffort", "reasoning_effort"];

type Window = { id: string; kind: string; label: string; usedPercent: number; resetsAt?: string; windowDurationMins?: number };
type Candidate = { providerInstanceId: string; model: string; options: Record<string, unknown>; quality?: number; windows?: string[] };
type Tier = "light" | "standard" | "deep";
// expiry dates of free limit resets, by provider then window id ("*" = every window)
type Credits = Record<string, Record<string, string[]>>;
type Config = {
  minQuality?: number;
  preference?: Record<string, number>;
  resetCredits?: Credits;
  // usage windows per provider, by model id prefix; providers listed here get new models automatically
  windows?: Record<string, Record<string, string[]>>;
  // personal X sentiment, by tier then model id
  sentiment?: Partial<Record<Tier, Record<string, number>>>;
  artificialAnalysisKey?: string;
  tiers: Record<Tier, Candidate[]>;
};
type Bench = { ii: number; tps?: number; price?: number; released?: string };
type Model = { slug: string; capabilities?: { optionDescriptors?: { id: string; type: string; options?: { id: string }[] }[] } };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 100) / 100;
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
const loadConfig = (): Config => ({ ...readJson(CONFIG), ...(existsSync(LOCAL) && readJson(LOCAL)) });
const loadBench = (): Record<string, Bench> => (existsSync(BENCH) ? readJson(BENCH).models : {});

// Artificial Analysis data is per user (their key, their cache), never committed
export async function refreshBenchmarks(maxAgeMs = 86400_000) {
  const key = loadConfig().artificialAnalysisKey;
  if (!key || (existsSync(BENCH) && Date.now() - statSync(BENCH).mtimeMs < maxAgeMs)) return false;
  const models: Record<string, Bench> = {};
  for (let page = 1, more = true; more; page++) {
    const res = await fetch(`https://artificialanalysis.ai/api/v2/language/models/free?page=${page}`, { headers: { "x-api-key": key } });
    if (!res.ok) throw new Error(`Artificial Analysis returned ${res.status}`);
    const body = await res.json();
    for (const m of body.data) {
      const ii = m.evaluations?.artificial_analysis_intelligence_index;
      if (ii != null) models[m.slug] = { ii, tps: m.performance_v3?.mean_output_tokens_per_second ?? undefined, price: m.pricing?.price_1m_output_tokens ?? undefined, released: m.release_date ?? undefined };
    }
    more = body.pagination?.has_more;
  }
  mkdirSync(dirname(BENCH), { recursive: true });
  writeFileSync(BENCH, JSON.stringify({ fetchedAt: new Date().toISOString(), models }));
  return true;
}

// AA slugs are T3 slugs with dots as dashes, plus an effort suffix; the bare slug is the top effort
const benchFor = (bench: Record<string, Bench>, model: string, options: Record<string, unknown>) => {
  const base = model.toLowerCase().replace(/\./g, "-");
  const effort = EFFORT_KEYS.map((k) => options[k]).find(Boolean);
  return bench[`${base}-${effort}`] ?? bench[base];
};

export function benchQuality(tier: Tier, b: Bench, iiMax: number) {
  const ii = b.ii / iiMax;
  if (tier !== "light") return ii;
  // light work favors fast, cheap models; price stands in for how much quota a call uses
  return (ii + Math.min(1, (b.tps ?? 0) / 200) + clamp(1 - Math.log10((b.price || 5) / 0.5) / 2, 0, 1)) / 3;
}

const defaultOptions = (m: Model) =>
  Object.fromEntries(
    (m.capabilities?.optionDescriptors ?? [])
      .filter((d) => EFFORT_KEYS.includes(d.id) && d.options?.some((o) => o.id === "medium"))
      .map((d) => [d.id, "medium"]),
  );

const windowsFor = (rules: Record<string, string[]>, model: string) =>
  Object.entries(rules).sort(([a], [b]) => b.length - a.length).find(([prefix]) => model.startsWith(prefix))?.[1];

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
          models: (d.models ?? []) as Model[],
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
  const bench = loadBench();
  const iiMax = Math.max(1, ...Object.values(bench).map((b) => b.ii));
  const listed = cfg.tiers[tier];
  const known = new Set(Object.values(cfg.tiers).flat().map((c) => c.model));
  const isNew = (slug: string) => {
    const released = benchFor(bench, slug, {})?.released;
    return !known.has(slug) && !!released && now - Date.parse(released) < NEW_MODEL_DAYS * 86400_000;
  };
  // recently released models that models.json does not list yet join every tier at medium effort
  const discovered: Candidate[] = Object.entries(cfg.windows ?? {}).flatMap(([id, rules]) =>
    (providers.get(id)?.models ?? [])
      .filter((m) => isNew(m.slug))
      .map((m) => ({ providerInstanceId: id, model: m.slug, options: defaultOptions(m), windows: windowsFor(rules, m.slug) })),
  );
  return [...listed, ...discovered]
    .flatMap((c) => {
      const p = providers.get(c.providerInstanceId);
      if (!p || !p.models.some((m) => m.slug === c.model) || exclude.includes(c.providerInstanceId)) return [];
      const b = benchFor(bench, c.model, c.options);
      const benchmark = b && benchQuality(tier, b, iiMax);
      const sentiment = cfg.sentiment?.[tier]?.[c.model] ?? c.quality;
      const blended = benchmark != null && sentiment != null ? (benchmark + sentiment) / 2 : benchmark ?? sentiment;
      if (blended == null || blended < (cfg.minQuality ?? 0)) return [];
      const ws = p.windows.filter((w) => !c.windows || c.windows.includes(w.id));
      const base = ws.length ? Math.min(...ws.map((w) => w.weight)) : 1;
      const weight = p.stale ? Math.min(base, 1) * 0.75 : base;
      const pref = Object.entries(cfg.preference ?? {}).find(([prefix]) => c.model.startsWith(prefix));
      const quality = blended * (pref?.[1] ?? 1);
      return [{
        target: { providerInstanceId: c.providerInstanceId, model: c.model, options: c.options },
        quality: round(quality),
        sources: { benchmark: benchmark == null ? null : round(benchmark), sentiment: sentiment ?? null, preference: pref?.[1] ?? 1 },
        weight: round(weight), score: round(quality * weight), windows: ws, stale: p.stale,
      }];
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.quality - a.quality)
    .slice(0, MAX_RESULTS);
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
  async () => json(readProviders().map(({ models, ...p }) => p)),
);

if (import.meta.main) {
  refreshBenchmarks().catch(() => {});
  await server.connect(new StdioServerTransport());
}
