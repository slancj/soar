"use strict";
/**
 * Forced dark-mode plugin for proxied pages (native dark mode only).
 *
 * Taps `frame.hooks.init.post` (same pattern as scramjet-utils plugins)
 * and, when enabled, makes each proxied document prefer dark:
 * - spoofs `matchMedia("(prefers-color-scheme: dark)")` to match (and
 *   the `: light` variant to not match), so sites with a native dark
 *   mode render it;
 * - injects `:root { color-scheme: dark; }` plus the inline
 *   `color-scheme` so UA chrome (scrollbars, form controls) goes dark.
 *
 * Whether dark or light is forced is driven by the shell theme, so the
 * theme button deterministically controls pages in both directions
 * (instead of "light" leaving pages up to the device theme).
 *
 * Fail-open everywhere: unknown states or exceptions mean
 * "leave the page alone".
 */

window.DarkModePlugin = (() => {
	const STYLE_ID = "sj-forced-dark-mode";
	const ORIG_MEDIA_ATTR = "data-sj-orig-media";

	// Sites like caniuse.com theme via `<link media="(prefers-color-scheme:
	// dark)">`. The browser evaluates that declaratively — a JS
	// matchMedia spoof can't touch it — so force/disable such sheets
	// directly: dark sheets always apply in dark mode and never in light
	// mode, and vice versa for light sheets.
	function applyThemeStylesheets(doc, wantDark, log) {
		let count = 0;
		try {
			const links = doc.querySelectorAll('link[rel~="stylesheet"][media]');
			for (const link of links) {
				let media = "";
				try {
					media = (link.getAttribute("media") || "").toLowerCase();
				} catch (err) {
					continue;
				}
				if (!media.includes("prefers-color-scheme")) continue;
				try {
					if (!link.getAttribute(ORIG_MEDIA_ATTR))
						link.setAttribute(ORIG_MEDIA_ATTR, media);
				} catch (err) {
					// ignore — still apply below
				}
				const isDark = media.includes("dark");
				const isLight = media.includes("light");
				let next = null;
				if (isDark && !isLight) next = wantDark ? "all" : "not all";
				else if (isLight && !isDark) next = wantDark ? "not all" : "all";
				if (next) {
					try {
						link.media = next;
						count += 1;
					} catch (err) {
						// ignore
					}
				}
			}
		} catch (err) {
			// document not ready — caller retries on DOMContentLoaded
		}
		log(`theme stylesheets forced: ${count}`);
	}

	// `@media (prefers-color-scheme: dark) { ... }` blocks *inside*
	// stylesheets are also evaluated declaratively. Walk same-origin
	// sheets (everything proxied is same-origin; true cross-origin
	// sheets throw on cssRules access and are skipped) and pin matching
	// blocks to `all` (apply) or `not all` (never apply).
	function mediaTarget(conditionText) {
		const t = String(conditionText || "").toLowerCase();
		if (!t.includes("prefers-color-scheme")) return null;
		const dark = t.includes("dark");
		const light = t.includes("light");
		if (dark && !light) return "dark";
		if (light && !dark) return "light";
		return null;
	}

	function walkRules(rules, wantDark) {
		let count = 0;
		for (const rule of rules) {
			let nested = null;
			try {
				// 4 = MEDIA_RULE, 12 = SUPPORTS_RULE, 3 = IMPORT_RULE.
				if (rule.type === 4) {
					const target = mediaTarget(rule.conditionText);
					if (target) {
						const next = (target === "dark") === wantDark ? "all" : "not all";
						try {
							if (rule.media.mediaText !== next) {
								rule.media.mediaText = next;
								count += 1;
							}
						} catch (err) {
							// read-only — leave alone
						}
					}
					nested = rule.cssRules;
				} else if (rule.type === 12) {
					nested = rule.cssRules;
				} else if (rule.type === 3 && rule.styleSheet) {
					nested = rule.styleSheet.cssRules;
				}
			} catch (err) {
				continue;
			}
			if (nested) {
				try {
					count += walkRules(nested, wantDark);
				} catch (err) {
					// ignore
				}
			}
		}
		return count;
	}

	function applyMediaRules(doc, wantDark) {
		let count = 0;
		let sheets = [];
		try {
			sheets = [...doc.styleSheets];
		} catch (err) {
			return 0;
		}
		try {
			for (const adopted of doc.adoptedStyleSheets || []) sheets.push(adopted);
		} catch (err) {
			// ignore
		}
		for (const sheet of sheets) {
			let rules = null;
			try {
				rules = sheet.cssRules;
			} catch (err) {
				continue; // cross-origin — fail open
			}
			if (!rules) continue;
			try {
				count += walkRules(rules, wantDark);
			} catch (err) {
				// ignore
			}
		}
		return count;
	}

	function applyToWindow(win, wantDark, debug = false) {
		const log = (...args) => {
			if (debug) console.log("[soar-darkmode]", ...args);
		};
		log(`init, wantDark=${wantDark}`);
		// 1. Spoof prefers-color-scheme before page scripts read it.
		try {
			const orig = win.matchMedia.bind(win);
			win.matchMedia = (query) => {
				const mql = orig(query);
				const q = String(query).toLowerCase();
				if (q.includes("prefers-color-scheme")) {
					const match = q.includes("dark") ? wantDark : !wantDark;
					if (mql.matches !== match) {
						try {
							Object.defineProperty(mql, "matches", {
								value: match,
								configurable: true,
							});
						} catch (err) {
							// read-only — leave as-is
						}
					}
					log(`matchMedia(${JSON.stringify(query)}) -> ${mql.matches}`);
				}
				return mql;
			};
			log("matchMedia spoofed");
		} catch (err) {
			// matchMedia unavailable — fall through to color-scheme only
			log("matchMedia unavailable", String(err));
		}

		// 2. color-scheme for UA chrome + sites keying off it.
		try {
			const doc = win.document;
			if (!doc) {
				log("no document");
				return;
			}
			if (!doc.getElementById(STYLE_ID)) {
				const style = doc.createElement("style");
				style.id = STYLE_ID;
				style.textContent = `:root{color-scheme:${wantDark ? "dark" : "light"};}`;
				(doc.head || doc.documentElement).appendChild(style);
				log("style injected");
			}
			if (doc.documentElement)
				doc.documentElement.style.colorScheme = wantDark ? "dark" : "light";
			log("colorScheme set");
			// 3+4. Force `<link media>` sheets and `@media` blocks, now and
			// again once parsing finishes (head may be partial) and
			// whenever sheets are added later (SPAs, lazy toggles).
			const passAll = () => {
				applyThemeStylesheets(doc, wantDark, log);
				log(`media rules forced: ${applyMediaRules(doc, wantDark)}`);
			};
			passAll();
			try {
				if (doc.readyState === "loading")
					doc.addEventListener(
						"DOMContentLoaded",
						() => {
							try {
								passAll();
							} catch (err) {
								// never break page init
							}
						},
						{ once: true }
					);
			} catch (err) {
				// ignore
			}
			try {
				let scheduled = false;
				const observer = new win.MutationObserver((mutations) => {
					for (const m of mutations) {
						for (const node of m.addedNodes || []) {
							const tag = node && node.tagName;
							if (tag === "STYLE" || tag === "LINK") {
								if (scheduled) return;
								scheduled = true;
								win.setTimeout(() => {
									scheduled = false;
									try {
										passAll();
									} catch (err) {
										// never break page init
									}
								}, 100);
								return;
							}
						}
					}
				});
				observer.observe(doc.documentElement || doc, {
					childList: true,
					subtree: true,
				});
			} catch (err) {
				// MutationObserver unavailable — init + DCL passes stand
			}
		} catch (err) {
			// not ready — ignore
			log("document not ready", String(err));
		}
	}

	class DarkModePlugin extends globalThis.$scramjetController.ManagedPlugin {
		/**
		 * @param {() => string} getTheme returns the shell theme
		 *   ("dark" or "light") — read live so the toggle applies on next
		 *   load without rebuilding frames.
		 * @param {boolean} [debug] log init/apply steps to the console.
		 *   Enable with `localStorage.setItem("sj-debug", "1")` on the
		 *   outer page, then reload.
		 */
		constructor(getTheme, debug = false) {
			super("soar-darkmode", []);
			this.getTheme = getTheme;
			this.debug = debug;
		}

		install(frame) {
			super.install(frame);
			this.tap(frame.hooks.init.post, (ctx) => {
				let wantDark = true;
				try {
					wantDark = this.getTheme() !== "light";
				} catch (err) {
					// fall through with dark default
				}
				try {
					if (ctx && ctx.window)
						applyToWindow(ctx.window, wantDark, this.debug);
					else if (this.debug)
						console.warn("[soar-darkmode] init.post without window");
				} catch (err) {
					// never break page init
					if (this.debug) console.warn("[soar-darkmode] apply failed", err);
				}
			});
		}
	}

	return DarkModePlugin;
})();
