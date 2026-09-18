/**
 * Bundle @ghostery/adblocker (+ its bare-specifier deps) into one
 * browser-loadable IIFE file.
 *
 * Why: the package's dist/esm files import bare specifiers
 * (@ghostery/url-parser, tldts-experimental, ...) that only Node can
 * resolve, and its UMD build keeps them external. Browsers can load
 * neither, so we bundle.
 *
 * Usage: `node scripts/bundle-adblocker.js`
 * Writes: public/adblock/adblocker.bundle.js (global `GhosteryAdblocker`)
 *
 * Re-run after bumping @ghostery/adblocker.
 */
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = fileURLToPath(import.meta.resolve("@ghostery/adblocker"));
const outFile = resolve(here, "../public/adblock/adblocker.bundle.js");

const bundle = await rollup({
	input: entry,
	plugins: [nodeResolve()],
	onwarn(warning, warn) {
		// tldts ships circular imports; harmless for our use.
		if (warning.code === "CIRCULAR_DEPENDENCY") return;
		warn(warning);
	},
});

await bundle.write({
	file: outFile,
	format: "iife",
	name: "GhosteryAdblocker",
	exports: "named",
});

await bundle.close();
console.log(`Wrote ${outFile}`);
