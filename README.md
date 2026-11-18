# provider-usage-mcp

Subscription-aware model router for [T3 Code](https://github.com/pingdotgg/t3code). It picks the subagent model that uses your Claude, Codex, Cursor, and Grok subscriptions most evenly. It only picks providers you are signed in to and models your plan offers.

## Parts

| Part | File | Runs |
| --- | --- | --- |
| MCP server with `pick_model` and `provider_usage` tools | `index.ts` | On demand, from Claude Code and Codex |
| Default model updater for T3 settings | `set-default.ts` | Every hour, from launchd |
| Curated models, window rules, and shared defaults | `models.json` | Read by both scripts |
| Your key, preferences, and X sentiment | `models.local.json` (git-ignored) | Read by both scripts |
| Weekly X sentiment update (needs Grok) | `prompts/weekly-sentiment.md` | Weekly, as a T3 Code scheduled task |

## How it scores

The score is `quality × preference × weight`.

- **quality** is a weighted average of two parts. `sentimentWeight` (default 0.67) is the share of sentiment, because hands-on reports catch problems that benchmarks miss. When a part is missing, the other part is used alone.
  - **Benchmark:** the [Artificial Analysis](https://artificialanalysis.ai) Intelligence Index for that model at its effort level, scaled so the best model is 1. The light tier also counts output speed and price.
  - **Sentiment:** your X sentiment from `models.local.json`, else the curated `quality` in `models.json`.
- **preference** is your own multiplier by model id prefix.
- **weight** compares the quota left with the time left until reset, using the lowest weight of the model's usage windows. Above 1 means that quota will expire unused. Below 1 means the subscription is ahead of even pace.

New models: a model that a provider in `windows` offers, that `models.json` does not list, and that Artificial Analysis says was released after `_meta.updatedAt` joins every tier at medium effort. To choose its tiers and effort, add it to `tiers` and update `_meta.updatedAt`.

## Setup

```sh
pnpm install
```

Register the MCP server (Node 24 or later runs TypeScript directly):

```sh
claude mcp add provider-usage -- node "$PWD/index.ts"
```

Install the hourly default model updater (macOS, uses the `node` on your PATH):

```sh
launchd/install.sh
```

Create `models.local.json`. All keys are optional, and each one overrides the same top-level key in `models.json`.

```json
{
  "artificialAnalysisKey": "your free key",
  "preference": { "claude-": 1.15 },
  "sentimentSources": ["@theo", "@davis7"],
  "resetCredits": { "claudeAgent": { "seven_day": ["2026-12-11T04:00:00Z"] } }
}
```

- `artificialAnalysisKey`: a free key from [Artificial Analysis](https://artificialanalysis.ai/api-key-management-redirect). Benchmarks are fetched once a day into `.cache/` and are not committed. Without a key, the router uses `models.json` only.
- `preference`: multiplies the quality of models whose id starts with the prefix.
- `sentimentSources`: the X accounts the weekly job trusts most.
- `resetCredits`: expiry dates of free limit resets that T3 Code does not report.

If you have Grok in T3 Code, add a weekly T3 Code scheduled task in this project with the prompt `Follow prompts/weekly-sentiment.md.` It writes `sentiment` to your `models.local.json`.

## Environment

| Variable | Default |
| --- | --- |
| `T3_CACHES` | `~/.t3/caches` |
| `T3_SETTINGS` | `~/.t3/userdata/settings.json` |
| `PROVIDER_USAGE_CONFIG` | `models.json` next to `index.ts` |

Benchmark data by [Artificial Analysis](https://artificialanalysis.ai).
