"use strict";
/**
 * Adblock engine loader (EasyList + EasyPrivacy via @ghostery/adblocker).
 *
 * Lazily loaded on first navigation so the 5MB engine.dat download never
 * slows the initial page load. Cached in the Cache API after first fetch.
 * If the checked-in engine.dat is missing or stale (ENGINE_VERSION mismatch
 * after a library bump), falls back to prebuilt lists from the network.
 *
 * Exposes `window.Adblock`:
 *   load()        -> Promise<FiltersEngine|null> (null = blocking disabled)
 *   isEnabled()   -> localStorage-backed toggle, default ON
 *   setEnabled(b) -> persist toggle + refresh toolbar badge
 *   updateBadge() -> refresh toolbar toggle label
 */
window.Adblock = (() => {
	const STORAGE_KEY = "sj-adblock";
	const CACHE_NAME = "soar-adblock-v1";
	const ENGINE_URL = "adblock/engine.dat";

	let engine = null;
	let Request = null;
	let ready = false;
	let loadPromise = null;
	let blockedTotal = 0;

	function isEnabled() {
		try {
			return localStorage.getItem(STORAGE_KEY) !== "off";
		} catch (err) {
			return true;
		}
	}

	function setEnabled(on) {
		try {
			localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
		} catch (err) {
			// private mode etc. — toggle just won't persist
		}
		updateBadge();
	}

	function noteBlocked() {
		blockedTotal += 1;
		updateBadge();
	}

	function updateBadge() {
		const btn = document.getElementById("sj-adblock-toggle");
		if (!btn) return;
		const on = isEnabled();
		btn.classList.toggle("off", !on);
		btn.title = on
			? `Adblock on — ${blockedTotal} request${blockedTotal === 1 ? "" : "s"} blocked${ready ? "" : " (engine loading)"}`
			: "Adblock off — click to enable";
	}

	async function readCachedBytes() {
		try {
			const cache = await caches.open(CACHE_NAME);
			const hit = await cache.match(ENGINE_URL);
			if (hit) return new Uint8Array(await hit.arrayBuffer());
		} catch (err) {
			// Cache API unavailable — fall through to network
		}
		return null;
	}

	async function fetchAndCache() {
		const res = await fetch(ENGINE_URL);
		if (!res.ok) throw new Error(`engine.dat HTTP ${res.status}`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		try {
			const cache = await caches.open(CACHE_NAME);
			await cache.put(
				ENGINE_URL,
				new Response(bytes, {
					headers: { "Content-Type": "application/octet-stream" },
				})
			);
		} catch (err) {
			// non-fatal
		}
		return bytes;
	}

	async function bustCache() {
		try {
			const cache = await caches.open(CACHE_NAME);
			await cache.delete(ENGINE_URL);
		} catch (err) {
			// non-fatal
		}
	}

	async function load() {
		if (ready) return engine;
		if (loadPromise) return loadPromise;
		loadPromise = (async () => {
			// Self-contained rollup bundle (see scripts/bundle-adblocker.js),
			// loaded via classic <script> in index.html. The package's own
			// ESM/UMD builds can't load in browsers (bare specifiers).
			const { FiltersEngine, Request: Req } =
				globalThis.GhosteryAdblocker || {};
			if (!FiltersEngine || !Req)
				throw new Error("GhosteryAdblocker bundle missing");
			Request = Req;

			// 1. checked-in engine.dat (cache first, then network)
			let bytes = await readCachedBytes();
			if (!bytes) bytes = await fetchAndCache();
			try {
				engine = FiltersEngine.deserialize(bytes);
			} catch (err) {
				// stale after an adblocker upgrade — refetch once, then give up
				console.warn("[adblock] engine.dat stale, refetching", err);
				await bustCache();
				try {
					engine = FiltersEngine.deserialize(await fetchAndCache());
				} catch (err2) {
					console.warn("[adblock] engine.dat unusable, using prebuilt lists", err2);
					engine = null;
				}
			}

			// 2. fallback: build from prebuilt lists over the network
			if (!engine) {
				engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
			}

			ready = true;
			updateBadge();
			console.log("[adblock] engine ready");
			return engine;
		})().catch((err) => {
			loadPromise = null;
			console.error("[adblock] engine failed to load, proxying unblocked", err);
			return null;
		});
		return loadPromise;
	}

	return {
		load,
		isEnabled,
		setEnabled,
		noteBlocked,
		updateBadge,
		get engine() {
			return engine;
		},
		get Request() {
			return Request;
		},
		get ready() {
			return ready;
		},
		get blockedTotal() {
			return blockedTotal;
		},
	};
})();
