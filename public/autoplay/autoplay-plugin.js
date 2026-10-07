"use strict";
/**
 * Autoplay-block plugin for proxied pages.
 *
 * Taps `frame.hooks.init.post` (same pattern as the darkmode/adblock
 * plugins) and ensures media never starts on its own — the user must
 * press play.
 *
 * What it does in every proxied window (including iframes like
 * YouTube embeds):
 * - strips `autoplay` attributes from `<video>`/`<audio>` (now, on
 *   DOMContentLoaded, and for later-added nodes);
 * - forces the `autoplay` IDL property to stay `false` so
 *   `video.autoplay = true` from page scripts is ignored;
 * - overrides `HTMLMediaElement.prototype.play()` to reject with
 *   `NotAllowedError` (like the browser's own autoplay block) unless
 *   the call is tied to a user gesture;
 * - pauses `play` events that slip past the override (attribute-driven
 *   autoplay doesn't go through JS `play()`);
 * - rewrites `autoplay=1` to `autoplay=0` in iframe `src` (YouTube/Vimeo
 *   embeds).
 *
 * Gesture policy:
 * - a `play()` is allowed while handling a user gesture
 *   (`userActivation.isActive`), within a short window after any
 *   gesture (covers click -> async `play()` chains in custom players),
 *   or once the user has clicked the media element itself;
 * - `<audio>` is additionally allowed after any prior interaction
 *   (`hasBeenActive`), so post-interaction notification/call sounds keep
 *   working while `<video>` stays strictly click-to-play.
 *
 * Fail-open everywhere: unknown states or exceptions mean "allow".
 */

window.AutoplayBlockPlugin = (() => {
	const APPROVED_ATTR = "data-sj-user-play";
	const PATCHED_FLAG = "__sjAutoplayBlocked";
	// Click -> fetch -> play() chains in custom players are async, so allow
	// a short window after any gesture. Short enough that load-time
	// autoplay and autoplay-next never fall inside it.
	const GESTURE_WINDOW_MS = 3000;

	function applyToWindow(win, debug = false) {
		const log = (...args) => {
			if (debug) console.log("[soar-autoplay]", ...args);
		};
		if (!win) return;
		try {
			if (win[PATCHED_FLAG]) return;
			win[PATCHED_FLAG] = true;
		} catch (err) {
			// ignore — still try to apply below
		}
		log("init");

		let lastGesture = 0;
		const markGesture = () => {
			lastGesture = Date.now();
		};
		const gestureFresh = () => Date.now() - lastGesture < GESTURE_WINDOW_MS;

		try {
			for (const type of [
				"pointerdown",
				"mousedown",
				"touchstart",
				"keydown",
			]) {
				win.addEventListener(type, markGesture, {
					capture: true,
					passive: true,
				});
			}
			// Direct interaction with the media itself approves it permanently.
			for (const type of ["pointerdown", "click", "touchend"]) {
				win.addEventListener(
					type,
					(event) => {
						try {
							markGesture();
							const target = event.target;
							const el =
								target && typeof target.closest === "function"
									? target.closest("video,audio")
									: null;
							if (el) {
								el.setAttribute(APPROVED_ATTR, "1");
								log("media approved by user gesture");
							}
						} catch (err) {
							// never break page input
						}
					},
					{ capture: true, passive: true }
				);
			}
		} catch (err) {
			log("gesture listeners unavailable", String(err));
		}

		function isApproved(el) {
			try {
				return !!(el && el.hasAttribute && el.hasAttribute(APPROVED_ATTR));
			} catch (err) {
				return false;
			}
		}

		function isAudio(el) {
			try {
				return !!(
					el &&
					(win.HTMLAudioElement
						? el instanceof win.HTMLAudioElement
						: el.tagName === "AUDIO")
				);
			} catch (err) {
				return false;
			}
		}

		function shouldAllow(el) {
			try {
				if (isApproved(el)) return true;
				const ua = win.navigator && win.navigator.userActivation;
				if (ua && ua.isActive) return true;
				if (gestureFresh()) return true;
				// Lenient for audio only: after the user has interacted with
				// the page once, background sounds (notifications, calls)
				// keep working. Video stays click-to-play.
				if (isAudio(el) && ua && ua.hasBeenActive) return true;
			} catch (err) {
				// fail open
				return true;
			}
			return false;
		}

		// 1. Gate programmatic play() — reject like the browser's own
		// autoplay policy so `video.play().catch(...)` paths show a play
		// button instead of throwing synchronously.
		try {
			const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
			if (proto && proto.play && !proto.play.__sjPatched) {
				const origPlay = proto.play;
				const patchedPlay = function (...args) {
					try {
						if (shouldAllow(this)) return origPlay.apply(this, args);
					} catch (err) {
						// fail open — fall through to the original
						try {
							return origPlay.apply(this, args);
						} catch (err2) {
							// ignore
						}
					}
					try {
						log(
							"blocked play()",
							(this && (this.currentSrc || this.src)) || ""
						);
					} catch (err) {
						// ignore
					}
					try {
						return win.Promise.reject(
							new win.DOMException(
								"Autoplay blocked: press play to watch.",
								"NotAllowedError"
							)
						);
					} catch (err) {
						return Promise.reject(err);
					}
				};
				try {
					Object.defineProperty(patchedPlay, "__sjPatched", {
						value: true,
						configurable: false,
					});
				} catch (err) {
					patchedPlay.__sjPatched = true;
				}
				proto.play = patchedPlay;
				log("play() patched");
			}
		} catch (err) {
			log("play() patch failed", String(err));
		}

		// 2. Pin the `autoplay` IDL property to false so
		// `video.autoplay = true` from page scripts is ignored.
		try {
			const proto = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
			const desc =
				(proto && Object.getOwnPropertyDescriptor(proto, "autoplay")) || null;
			if (proto && !(desc && desc.get && desc.get.__sjPatched)) {
				const origSet = desc && desc.set;
				const getter = () => false;
				const setter = function () {
					log("ignored autoplay=true");
					try {
						if (origSet) origSet.call(this, false);
					} catch (err) {
						// ignore
					}
				};
				try {
					Object.defineProperty(getter, "__sjPatched", { value: true });
				} catch (err) {
					// ignore
				}
				Object.defineProperty(proto, "autoplay", {
					get: getter,
					set: setter,
					configurable: true,
					enumerable: !!(desc && desc.enumerable),
				});
				log("autoplay property pinned");
			}
		} catch (err) {
			log("autoplay pin failed", String(err));
		}

		function stripMedia(el) {
			try {
				if (el.hasAttribute && el.hasAttribute("autoplay")) {
					el.removeAttribute("autoplay");
					log("stripped autoplay attribute");
				}
			} catch (err) {
				// ignore
			}
			try {
				// Goes through the pinned setter above — stays false.
				el.autoplay = false;
			} catch (err) {
				// ignore
			}
			try {
				if (!el.paused && !isApproved(el) && !gestureFresh()) el.pause();
			} catch (err) {
				// ignore (not ready / no source yet)
			}
		}

		function stripIframe(el) {
			try {
				const src = el.getAttribute ? el.getAttribute("src") : null;
				if (typeof src === "string" && /autoplay\s*=\s*1/i.test(src)) {
					el.setAttribute(
						"src",
						src.replace(/autoplay\s*=\s*1/gi, "autoplay=0")
					);
					log("rewrote iframe autoplay=1");
				}
			} catch (err) {
				// ignore
			}
		}

		function sweep(doc) {
			if (!doc || typeof doc.querySelectorAll !== "function") return;
			try {
				for (const el of doc.querySelectorAll(
					"video[autoplay],audio[autoplay]"
				)) {
					stripMedia(el);
				}
			} catch (err) {
				// document not ready — caller retries on DOMContentLoaded
			}
			try {
				// Pause anything already playing without approval (e.g.
				// muted `autoplay` that started before we ran).
				for (const el of doc.querySelectorAll("video,audio")) {
					try {
						if (!el.paused && !isApproved(el) && !gestureFresh()) el.pause();
					} catch (err) {
						// ignore
					}
				}
			} catch (err) {
				// ignore
			}
			try {
				// stripIframe() matches case-insensitively, so one pass suffices.
				for (const el of doc.querySelectorAll("iframe[src]")) {
					stripIframe(el);
				}
			} catch (err) {
				// ignore
			}
		}

		function attachPlayTrap(doc) {
			try {
				if (!doc || typeof doc.addEventListener !== "function") return false;
				doc.addEventListener(
					"play",
					(event) => {
						try {
							const el = event.target;
							if (
								!el ||
								!(win.HTMLMediaElement && el instanceof win.HTMLMediaElement)
							)
								return;
							if (shouldAllow(el)) return;
							try {
								el.pause();
							} catch (err) {
								// ignore
							}
							log("paused autoplay via play event");
						} catch (err) {
							// never break page playback
						}
					},
					true
				);
				return true;
			} catch (err) {
				return false;
			}
		}

		function attachObserver(doc) {
			try {
				const root = doc.documentElement || doc;
				if (!root || typeof win.MutationObserver !== "function") return;
				const observer = new win.MutationObserver((mutations) => {
					for (const m of mutations) {
						try {
							if (m.type === "attributes" && m.target) {
								const t = m.target;
								if (
									t.tagName === "VIDEO" ||
									t.tagName === "AUDIO" ||
									(t.closest && t.closest("video,audio"))
								) {
									const el =
										t.tagName === "VIDEO" || t.tagName === "AUDIO"
											? t
											: t.closest("video,audio");
									if (el) stripMedia(el);
								} else if (t.tagName === "IFRAME") {
									stripIframe(t);
								}
							}
							for (const node of m.addedNodes || []) {
								if (!node || node.nodeType !== 1) continue;
								if (node.tagName === "VIDEO" || node.tagName === "AUDIO") {
									stripMedia(node);
								} else if (node.tagName === "IFRAME") {
									stripIframe(node);
								} else if (node.querySelectorAll) {
									for (const el of node.querySelectorAll("video,audio"))
										stripMedia(el);
									for (const el of node.querySelectorAll("iframe[src]"))
										stripIframe(el);
								}
							}
						} catch (err) {
							// ignore bad nodes
						}
					}
				});
				observer.observe(root, {
					childList: true,
					subtree: true,
					attributes: true,
					attributeFilter: ["autoplay", "src"],
				});
				log("observer attached");
			} catch (err) {
				log("observer failed", String(err));
			}
		}

		try {
			const doc = win.document;
			if (doc) {
				sweep(doc);
				if (!attachPlayTrap(doc)) {
					try {
						doc.addEventListener(
							"DOMContentLoaded",
							() => {
								try {
									sweep(win.document);
									attachPlayTrap(win.document);
									attachObserver(win.document);
								} catch (err) {
									// never break page init
								}
							},
							{ once: true }
						);
					} catch (err) {
						// ignore
					}
				} else {
					attachObserver(doc);
				}
				try {
					if (doc.readyState === "loading") {
						doc.addEventListener(
							"DOMContentLoaded",
							() => {
								try {
									sweep(win.document);
								} catch (err) {
									// never break page init
								}
							},
							{ once: true }
						);
					}
				} catch (err) {
					// ignore
				}
			}
		} catch (err) {
			log("document not ready", String(err));
		}
	}

	class AutoplayBlockPlugin
		extends globalThis.$scramjetController.ManagedPlugin
	{
		/**
		 * @param {boolean} [debug] log block/apply steps to the console.
		 *   Enable with `localStorage.setItem("sj-debug", "1")` on the
		 *   outer page, then reload.
		 */
		constructor(debug = false) {
			super("soar-autoplay-block", []);
			this.debug = debug;
		}

		install(frame) {
			super.install(frame);
			this.tap(frame.hooks.init.post, (ctx) => {
				try {
					if (ctx && ctx.window) applyToWindow(ctx.window, this.debug);
					else if (this.debug)
						console.warn("[soar-autoplay] init.post without window");
				} catch (err) {
					// never break page init
					if (this.debug) console.warn("[soar-autoplay] apply failed", err);
				}
			});
		}
	}

	return AutoplayBlockPlugin;
})();
