# provider-usage-mcp

Subscription-aware model router for [T3 Code](https://github.com/pingdotgg/t3code). It picks the subagent model that uses your Claude, Codex, Cursor, and Grok subscriptions most evenly.

## Parts

| Part | File | Runs |
| --- | --- | --- |
| MCP server with `pick_model` and `provider_usage` tools | `index.ts` | On demand, from Claude Code and Codex |
| Default model updater for T3 settings | `set-default.ts` | Every hour, from launchd |
| Candidate models, quality scores, and preferences | `models.json` | Read by both scripts |
| Weekly sentiment update of `models.json` | `prompts/weekly-sentiment.md` | Weekly, as a T3 Code scheduled task |

## How it scores

For each usage window, the router compares the quota left with the time left until reset. A weight above 1 means that quota will expire unused. A weight below 1 means the subscription is ahead of even pace. The score is `quality × preference × weight`, with the lowest window weight for that model.

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

Optional: put your personal settings in `models.local.json`. It is git-ignored and overrides top-level keys in `models.json`.

```json
{
  "preference": { "claude-": 1.15 },
  "resetCredits": { "claudeAgent": { "seven_day": ["2026-12-11T04:00:00Z"] } }
}
```

`preference` multiplies the quality of models whose id starts with the prefix. `resetCredits` lists the expiry dates of free limit resets that T3 Code does not report.

To keep `models.json` current, one person adds a weekly T3 Code scheduled task in this project with the prompt: `Follow prompts/weekly-sentiment.md.` The task commits and pushes the changes. Other people run `git pull`.

## Environment

| Variable | Default |
| --- | --- |
| `T3_CACHES` | `~/.t3/caches` |
| `T3_SETTINGS` | `~/.t3/userdata/settings.json` |
| `PROVIDER_USAGE_CONFIG` | `models.json` next to `index.ts` |
