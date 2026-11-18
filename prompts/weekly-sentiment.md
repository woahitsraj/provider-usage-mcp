Update my personal X (Twitter) sentiment scores for the subagent router. Run this from the repository root. `$T3_CACHES` is `~/.t3/caches` unless set.

Context: the router blends an Artificial Analysis benchmark score with X sentiment. Sentiment is personal: it goes in `sentiment` in models.local.json (git-ignored), shaped `{ "light": { "<model id>": 0.8 }, "standard": {...}, "deep": {...} }` with values from 0 to 1. Only Grok can search X well, so this job runs only for people with Grok.

Steps:
1. Read `$T3_CACHES/grok.json`. If it is missing, or `enabled` is not true, or `status` is not "ready", reply "Skipped: Grok is not available, so the router uses benchmarks and the models.json scores." and stop.
2. Read models.json and models.local.json (it may not exist). The developers to follow are `sentimentSources` in models.local.json, else in models.json. The models to score are every model in models.json `tiers`, plus every model from `pick_model` (provider-usage MCP) for each tier that is not in models.json.
3. Load the T3 tool `delegate_task` (and `orchestrator_capabilities` once) and delegate a research task to provider `grok`, model `grok-4.7`, reasoningEffort high, mode wait. Brief: search X and the web for developer sentiment in the last 14 days on these models for agentic coding. Weight posts from the listed developers most, then other engineers who compare models side by side. Return per model: suggested quality for light, standard, and deep (0-1; light rewards speed and low cost, deep rewards hard reasoning); one-line reason; 1-3 x.com status URLs.
4. Write the results to `sentiment` in models.local.json. Change a value only when the evidence supports a change of 0.05 or more. Keep all other keys in that file unchanged. Validate with `node -e "JSON.parse(require('fs').readFileSync('models.local.json','utf8'))"`. Do not edit models.json and do not commit.
5. Reset credits (report only): if any date in `resetCredits` in models.local.json is in the past, say so.
6. Reply with a short table of what changed (model, tier, old → new, reason, source link). If nothing changed, say so in one line. Write in simple, short sentences and do not use em dashes.
