#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pick } from "./index.ts";

const SETTINGS =
	process.env.T3_SETTINGS ?? join(homedir(), ".t3/userdata/settings.json");

type Target = ReturnType<typeof pick>[number]["target"];

// T3 settings store model options as [{ id, value }], the router as { id: value }
const toSelection = ({ target }: { target: Target }) => ({
	instanceId: target.providerInstanceId,
	model: target.model,
	...(Object.keys(target.options).length && {
		options: Object.entries(target.options).map(([id, value]) => ({
			id,
			value,
		})),
	}),
});

const ranked = pick("standard");
const top = ranked[0];
if (!top) {
	console.log(`${new Date().toISOString()} no candidates, settings unchanged`);
	process.exit(0);
}
const fallback = ranked.find(
	(r) => r.target.providerInstanceId !== top.target.providerInstanceId,
);

const settings = JSON.parse(readFileSync(SETTINGS, "utf8"));
const next = {
	...settings,
	defaultModelSelection: toSelection({ target: top.target }),
	...(fallback && {
		fallbackModelSelection: toSelection({ target: fallback.target }),
	}),
};
const summary = `default ${top.target.providerInstanceId}/${top.target.model} (score ${top.score}), fallback ${fallback ? `${fallback.target.providerInstanceId}/${fallback.target.model}` : "unchanged"}`;

if (JSON.stringify(next) === JSON.stringify(settings)) {
	console.log(`${new Date().toISOString()} unchanged: ${summary}`);
	process.exit(0);
}

// T3 Code watches this file; write atomically so it never reads a partial file
const tmp = `${SETTINGS}.router-tmp`;
writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
renameSync(tmp, SETTINGS);
console.log(`${new Date().toISOString()} updated: ${summary}`);
