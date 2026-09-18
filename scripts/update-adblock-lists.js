/**
 * Build a serialized adblock engine from EasyList + EasyPrivacy + uBlock filters.
 *
 * Usage: `node scripts/update-adblock-lists.js`
 *
 * Writes:
 *   public/adblock/engine.dat  - serialized FiltersEngine (loaded by engine.js)
 *   public/adblock/engine.json - metadata (engine version, date, list set)
 *
 * Re-run weekly or after bumping @ghostery/adblocker (serialized engines
 * throw on ENGINE_VERSION mismatch, so .dat must be rebuilt on upgrades).
 */
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FiltersEngine,
	ENGINE_VERSION,
	adsAndTrackingLists,
	adsLists,
} from "@ghostery/adblocker";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/adblock");

const lists = process.argv.includes("--ads-only") ? "ads-only" : "ads+tracking";

console.log(`Fetching filter lists (${lists})...`);
// Network-only engine (Scope 2): cosmetic filters are dead weight until the
// Scope 3 cosmetic layer lands, and they dominate serialized size.
const urls = lists === "ads-only" ? adsLists : adsAndTrackingLists;
const engine = await FiltersEngine.fromLists(fetch, urls, {
	loadCosmeticFilters: false,
	loadGenericCosmeticsFilters: false,
});

console.log("Serializing engine...");
const serialized = engine.serialize();
console.log(
	`Engine: ${(serialized.length / 1024).toFixed(0)} KiB, adblocker ENGINE_VERSION=${ENGINE_VERSION}`
);

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "engine.dat"), Buffer.from(serialized));
await writeFile(
	resolve(outDir, "engine.json"),
	JSON.stringify(
		{
			engineVersion: ENGINE_VERSION,
			adblocker: (
				await import("@ghostery/adblocker/package.json", {
					with: { type: "json" },
				})
			).default.version,
			lists,
			builtAt: new Date().toISOString(),
			bytes: serialized.length,
		},
		null,
		"\t"
	) + "\n"
);

console.log("Wrote public/adblock/engine.dat + engine.json");
