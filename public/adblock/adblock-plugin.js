"use strict";
/**
 * Network adblock plugin for Scramjet frames (Scope 2: EasyList engine).
 *
 * Taps `frame.hooks.fetch.intercept` and asks the @ghostery/adblocker
 * FiltersEngine (see adblock/engine.js) whether each subresource should be
 * blocked. Matches the `CatchEscapedLinksPlugin` pattern from
 * scramjet-utils: set `props.response` to short-circuit with an empty 200.
 *
 * Important details:
 * - Match against `ctx.parsed.url` (decoded). `ctx.request.rawUrl` is still
 *   Scramjet-encoded (`/~/sj/...`) and useless for filter matching.
 * - `destination === "document"` (top-level navigation) is never blocked.
 * - `blob:`/`data:` URLs never reach `intercept` (handled before hooks).
 * - Fail-open everywhere: unknown destinations, unparsable URLs, missing
 *   engine, or any exception means "allow".
 * - Runs `before: ["scramjet-http-cache"]` so blocked hosts can't be served
 *   from cache.
 *
 * v1 limits (documented): `$redirect` surrogates are served as empty-200
 * instead of the surrogate body, and `$removeparam` rewrites are not applied
 * (intercept can only short-circuit, not rewrite-and-continue).
 */
window.AdblockPlugin = (() => {
	// Scramjet fetch destination -> ghostery Request type.
	const DEST_TO_TYPE = {
		script: "script",
		style: "stylesheet",
		image: "image",
		font: "font",
		fetch: "xmlhttprequest",
		xhr: "xmlhttprequest",
		iframe: "sub_frame",
		worker: "script",
		sharedworker: "script",
		serviceworker: "script",
		audio: "media",
		video: "media",
		track: "media",
		manifest: "other",
		xslt: "other",
	};
	const SKIP_DESTINATIONS = new Set(["document", "", "unknown"]);
	const BLOCKABLE_SCHEMES = /^https?:$/i;

	function emptyBlockedResponse() {
		const ScramjetHeaders =
			globalThis.$scramjet && globalThis.$scramjet.ScramjetHeaders;
		if (!ScramjetHeaders) return null;
		return {
			body: "",
			status: 200,
			statusText: "OK",
			headers: ScramjetHeaders.fromRawHeaders([
				["content-type", "text/plain"],
			]),
		};
	}

	class AdblockPlugin extends globalThis.$scramjetController.ManagedPlugin {
		/**
		 * @param {() => string} getSourceUrl returns the tab's current page URL
		 *   (drives third-party/exception matching in the engine).
		 */
		constructor(getSourceUrl) {
			super("soar-adblock", []);
			this.getSourceUrl = getSourceUrl;
		}

		install(frame) {
			super.install(frame);
			this.tap(
				frame.hooks.fetch.intercept,
				(ctx, props) => {
					const Adblock = globalThis.Adblock;
					if (!Adblock || !Adblock.isEnabled() || !Adblock.engine) return;

					const dest = ctx.parsed.destination;
					if (SKIP_DESTINATIONS.has(dest)) return;

					let url;
					try {
						url = ctx.parsed.url;
						if (!BLOCKABLE_SCHEMES.test(url.protocol)) return;
					} catch (err) {
						return;
					}

					let sourceUrl = "";
					try {
						sourceUrl = this.getSourceUrl() || "";
					} catch (err) {
						// fall through with empty source
					}

					let request;
					try {
						request = Adblock.Request.fromRawDetails({
							url: url.href,
							sourceUrl,
							type: DEST_TO_TYPE[dest] || "other",
						});
					} catch (err) {
						return;
					}

					let verdict;
					try {
						verdict = Adblock.engine.match(request);
					} catch (err) {
						return;
					}
					if (!verdict || (!verdict.match && !verdict.redirect)) return;

					const blocked = emptyBlockedResponse();
					if (!blocked) return;
					props.response = blocked;
					Adblock.noteBlocked();
					console.debug("[adblock] blocked", url.href);
				},
				{ before: ["scramjet-http-cache"] }
			);
		}
	}

	return AdblockPlugin;
})();
