"use strict";
/**
 * New-tab capture plugin for proxied pages.
 *
 * Taps `frame.hooks.init.post` (same pattern as the darkmode/adblock/
 * autoplay plugins) and routes every new-tab/new-window request from
 * proxied content to the outer shell's inner tabs — a real browser tab
 * must never open.
 *
 * Captured (converted into an `onNewTab(url, target)` call to the shell,
 * which opens an inner proxy tab):
 * - `window.open(url, target, ...)` (all targets; `_self` navigates the
 *   current frame instead, like the platform);
 * - left/middle clicks on `<a href>` that would open a new tab:
 *   `target="_blank"` (or another named window / `<base target>`),
 *   Ctrl/Cmd-click, Shift-click, middle-click;
 * - `<form>` submissions aimed at a named window / `_blank`
 *   (GET forms keep their query string; other methods fall back to the
 *   form's action URL);
 * - programmatic `form.submit()` with such a target (it bypasses the
 *   `submit` event, so `HTMLFormElement.prototype.submit` is wrapped too).
 *
 * Deliberately NOT intercepted (left to the platform):
 * - non-http(s) URLs (`mailto:`, `tel:`, `blob:`, `data:`, `javascript:`…)
 *   — those don't open normal tabs and have no proxied equivalent;
 * - right-click > "Open link in new tab": the browser opens it without
 *   dispatching any page event, so it can't be intercepted. The existing
 *   `CatchEscapedLinksPlugin` still routes that real tab back through the
 *   proxy shell (`/?goto=…`), and the shell hands it back to the opener
 *   as an inner tab when possible (see index.js).
 *
 * `window.open` returns a small stub (`closed`, `close()`, `focus()`,
 * `location.href` setter navigates the inner tab) so scripts that keep
 * the reference don't throw. Fail-open everywhere: unknown states or
 * exceptions mean "let the platform handle it".
 */

window.NewTabCapturePlugin = (() => {
	const WIN_PATCHED = "__sjNewTabCaptured";
	const DOC_PATCHED = "__sjNewTabListeners";
	// Click + auxclick both fire for some buttons — ignore repeats.
	const DEDUPE_WINDOW_MS = 750;
	const PROXYABLE = /^https?:$/i;

	function findAnchor(event) {
		try {
			const t = event.target;
			if (t && typeof t.closest === "function") {
				const a = t.closest("a[href]");
				if (a) return a;
			}
			const path =
				typeof event.composedPath === "function" ? event.composedPath() : null;
			if (path) {
				for (const node of path) {
					if (
						node &&
						node.tagName === "A" &&
						node.hasAttribute &&
						node.hasAttribute("href")
					)
						return node;
				}
			}
		} catch (err) {
			// ignore — no anchor found
		}
		return null;
	}

	function anchorHref(anchor) {
		try {
			return anchor.href || anchor.getAttribute("href") || "";
		} catch (err) {
			return "";
		}
	}

	function proxyableHref(href) {
		try {
			return PROXYABLE.test(new URL(href).protocol) ? href : null;
		} catch (err) {
			return null;
		}
	}

	function effectiveTarget(anchor, doc) {
		try {
			const raw = anchor.getAttribute
				? anchor.getAttribute("target")
				: anchor.target;
			if (raw && raw.trim()) return raw.trim().toLowerCase();
		} catch (err) {
			// ignore — fall through to <base>
		}
		try {
			const base =
				doc && doc.querySelector ? doc.querySelector("base[target]") : null;
			const braw =
				base && base.getAttribute ? base.getAttribute("target") : null;
			if (braw && braw.trim()) return braw.trim().toLowerCase();
		} catch (err) {
			// ignore
		}
		return "";
	}

	// True when this click would open a new tab/window in a normal browser.
	function isNewTabIntent(event, anchor, doc) {
		try {
			if (event.button === 1) return true;
		} catch (err) {
			// ignore
		}
		try {
			if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
		} catch (err) {
			// ignore
		}
		const t = effectiveTarget(anchor, doc);
		if (!t || t === "_self" || t === "_parent" || t === "_top") return false;
		return true; // _blank or a named window
	}

	function applyToWindow(win, onNewTab, debug = false) {
		const log = (...args) => {
			if (debug) console.log("[soar-newtab]", ...args);
		};
		if (!win) return;
		let winPatched = false;
		try {
			winPatched = !!win[WIN_PATCHED];
			win[WIN_PATCHED] = true;
		} catch (err) {
			// ignore — still try to apply below
		}

		let lastKey = "";
		let lastAt = 0;
		const dedupe = (key) => {
			let now = 0;
			try {
				now = Date.now();
			} catch (err) {
				return false;
			}
			if (key === lastKey && now - lastAt < DEDUPE_WINDOW_MS) return true;
			lastKey = key;
			lastAt = now;
			return false;
		};

		const openInner = (rawUrl, targetName) => {
			let href = "";
			try {
				href = String(rawUrl ?? "");
			} catch (err) {
				href = "";
			}
			let absolute = href.trim() === "" ? "about:blank" : href;
			if (absolute !== "about:blank") {
				try {
					absolute = new URL(absolute, win.location.href).href;
				} catch (err) {
					// unresolvable — let the outer shell validate
				}
			}
			if (absolute !== "about:blank" && !proxyableHref(absolute)) {
				log("ignoring non-http(s) new-tab url");
				return null;
			}
			if (dedupe(`${absolute}|${targetName || ""}`)) {
				log("deduped repeat open");
				return null;
			}
			try {
				return onNewTab(absolute, targetName || "");
			} catch (err) {
				log("onNewTab failed", String(err));
				return null;
			}
		};

		const makeStub = (href, handle) => {
			const navigate =
				handle && typeof handle.navigate === "function"
					? handle.navigate
					: null;
			const stub = {
				closed: false,
				opener: win,
				focus() {},
				blur() {},
				close() {
					try {
						stub.closed = true;
					} catch (err) {
						// ignore
					}
					try {
						if (handle && typeof handle.close === "function") handle.close();
					} catch (err) {
						// ignore
					}
				},
				postMessage() {},
			};
			let current = href;
			try {
				stub.location = {};
				Object.defineProperty(stub.location, "href", {
					get: () => current,
					set: (v) => {
						try {
							current = String(v);
						} catch (err) {
							current = "";
						}
						try {
							if (navigate) navigate(current);
						} catch (err) {
							// ignore
						}
					},
					configurable: true,
					enumerable: true,
				});
				stub.location.toString = () => current;
			} catch (err) {
				// ignore — stub without location still prevents crashes
			}
			try {
				stub.document = null;
			} catch (err) {
				// ignore
			}
			return stub;
		};

		const patchOpenOn = (obj) => {
			try {
				if (!obj || typeof obj.open !== "function") return;
				if (obj.open.__sjPatched) return;
				const patched = function (url, target, _features) {
					const name = target == null ? "" : String(target);
					const lname = name.toLowerCase();
					try {
						log("window.open", String(url).slice(0, 120), name);
					} catch (err) {
						// ignore
					}
					if (lname === "_self") {
						// Platform behavior: loads in the current frame.
						try {
							const raw = url == null ? "" : String(url);
							const abs =
								raw.trim() === ""
									? "about:blank"
									: new URL(raw, win.location.href).href;
							if (abs !== "about:blank" && proxyableHref(abs))
								win.location.href = abs;
						} catch (err) {
							// ignore — fail open
						}
						return makeStub("about:blank", null);
					}
					// Everything else (_blank, named windows, _top/_parent —
					// the shell owns top) becomes an inner proxy tab.
					const handle = openInner(url ?? "about:blank", name);
					let href = "about:blank";
					try {
						const raw = url == null ? "" : String(url);
						href =
							raw.trim() === ""
								? "about:blank"
								: new URL(raw, win.location.href).href;
					} catch (err) {
						// keep about:blank
					}
					return makeStub(href, handle);
				};
				try {
					Object.defineProperty(patched, "__sjPatched", { value: true });
				} catch (err) {
					patched.__sjPatched = true;
				}
				try {
					// Non-writable so later page scripts can't silently
					// restore the real window.open; still configurable so
					// removal/inspection keeps working.
					Object.defineProperty(obj, "open", {
						value: patched,
						writable: false,
						configurable: true,
						enumerable: false,
					});
				} catch (err) {
					try {
						obj.open = patched;
					} catch (err2) {
						// ignore
					}
				}
				log("patched window.open");
			} catch (err) {
				log("window.open patch failed", String(err));
			}
		};

		if (!winPatched) {
			patchOpenOn(win);
			try {
				if (win.Window && win.Window.prototype)
					patchOpenOn(win.Window.prototype);
			} catch (err) {
				// ignore
			}
			try {
				const proto = win.HTMLFormElement && win.HTMLFormElement.prototype;
				if (
					proto &&
					typeof proto.submit === "function" &&
					!proto.submit.__sjPatched
				) {
					const origSubmit = proto.submit;
					const patchedSubmit = function (...args) {
						try {
							const t = (
								(this.getAttribute && this.getAttribute("target")) ||
								this.target ||
								""
							).toLowerCase();
							if (t && t !== "_self" && t !== "_parent" && t !== "_top") {
								onSubmit({ target: this });
								return undefined;
							}
						} catch (err) {
							// fall through to the original
						}
						return origSubmit.apply(this, args);
					};
					try {
						Object.defineProperty(patchedSubmit, "__sjPatched", {
							value: true,
						});
					} catch (err) {
						patchedSubmit.__sjPatched = true;
					}
					proto.submit = patchedSubmit;
					log("patched form.submit");
				}
			} catch (err) {
				log("form.submit patch failed", String(err));
			}
		}

		const onClick = (event) => {
			try {
				if (!event || event.defaultPrevented) return;
				if (event.button !== 0 && event.button !== 1) return;
				const anchor = findAnchor(event);
				if (!anchor) return;
				const doc = win.document;
				if (!isNewTabIntent(event, anchor, doc)) return;
				const raw = anchorHref(anchor);
				if (!raw) return;
				let abs = "";
				try {
					abs = new URL(raw, win.location.href).href;
				} catch (err) {
					return;
				}
				if (!proxyableHref(abs)) return;
				event.preventDefault();
				try {
					event.stopPropagation();
				} catch (err) {
					// ignore
				}
				const t = effectiveTarget(anchor, doc);
				log("captured link click", abs.slice(0, 120));
				openInner(abs, t === "_blank" ? "" : t);
			} catch (err) {
				// never break page clicks
			}
		};

		const onAuxClick = (event) => {
			try {
				if (!event || event.button !== 1) return;
				const anchor = findAnchor(event);
				if (!anchor) return;
				const raw = anchorHref(anchor);
				if (!raw) return;
				let abs = "";
				try {
					abs = new URL(raw, win.location.href).href;
				} catch (err) {
					return;
				}
				if (!proxyableHref(abs)) return;
				event.preventDefault();
				try {
					event.stopPropagation();
				} catch (err) {
					// ignore
				}
				log("captured middle-click", abs.slice(0, 120));
				openInner(abs, "");
			} catch (err) {
				// never break page clicks
			}
		};

		const onSubmit = (event) => {
			try {
				const form = event && event.target;
				if (!form || form.tagName !== "FORM") return;
				const t = (
					(form.getAttribute && form.getAttribute("target")) ||
					form.target ||
					""
				).toLowerCase();
				if (!t || t === "_self" || t === "_parent" || t === "_top") return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				try {
					event.stopPropagation();
				} catch (err) {
					// ignore
				}
				let action = "";
				try {
					action = form.action || win.location.href;
				} catch (err) {
					try {
						action = win.location.href;
					} catch (err2) {
						return;
					}
				}
				const method = (form.method || "get").toLowerCase();
				if (method === "get") {
					try {
						const url = new URL(action, win.location.href);
						const data = new win.FormData(form);
						for (const [k, v] of data.entries()) {
							url.searchParams.append(
								k,
								typeof v === "string" ? v : v.name || "blob"
							);
						}
						log("captured form submit", url.href.slice(0, 120));
						openInner(url.href, t === "_blank" ? "" : t);
						return;
					} catch (err) {
						// fall through to plain action URL
					}
				}
				log("captured form submit (action only)");
				openInner(action, t === "_blank" ? "" : t);
			} catch (err) {
				// never break page submits
			}
		};

		const attach = () => {
			try {
				const doc = win.document;
				if (!doc || typeof doc.addEventListener !== "function") return false;
				try {
					if (doc[DOC_PATCHED]) return true;
					doc[DOC_PATCHED] = true;
				} catch (err) {
					// ignore — attach anyway (dedupe guards double-fires)
				}
				// Capture phase so page stopPropagation() can't pre-empt us.
				doc.addEventListener("click", onClick, true);
				doc.addEventListener("auxclick", onAuxClick, true);
				doc.addEventListener("submit", onSubmit, true);
				try {
					win.addEventListener("click", onClick, true);
				} catch (err) {
					// ignore
				}
				try {
					win.addEventListener("auxclick", onAuxClick, true);
				} catch (err) {
					// ignore
				}
				log("listeners attached");
				return true;
			} catch (err) {
				return false;
			}
		};

		try {
			const doc = win.document;
			if (doc && !attach()) {
				doc.addEventListener(
					"DOMContentLoaded",
					() => {
						try {
							attach();
						} catch (err) {
							// never break page init
						}
					},
					{ once: true }
				);
			}
		} catch (err) {
			log("document not ready", String(err));
		}
	}

	class NewTabCapturePlugin
		extends globalThis.$scramjetController.ManagedPlugin
	{
		/**
		 * @param {(url: string, target: string) => any} onNewTab called (in the
		 *   outer realm) when proxied content asks for a new tab/window.
		 *   Should open an inner proxy tab; may return a handle
		 *   `{ navigate(url), close() }` wired into the window.open stub.
		 * @param {boolean} [debug] log captures to the console.
		 *   Enable with `localStorage.setItem("sj-debug", "1")` on the
		 *   outer page, then reload.
		 */
		constructor(onNewTab, debug = false) {
			super("soar-newtab-capture", []);
			this.onNewTab = onNewTab;
			this.debug = debug;
		}

		install(frame) {
			super.install(frame);
			this.tap(frame.hooks.init.post, (ctx) => {
				try {
					if (ctx && ctx.window)
						applyToWindow(ctx.window, this.onNewTab, this.debug);
					else if (this.debug)
						console.warn("[soar-newtab] init.post without window");
				} catch (err) {
					// never break page init
					if (this.debug) console.warn("[soar-newtab] apply failed", err);
				}
			});
		}
	}

	return NewTabCapturePlugin;
})();
