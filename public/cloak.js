"use strict";
/**
 * Tab cloak: disguises the tab as Gmail.
 *
 * Self-contained on purpose: the icon is an inline SVG data URI so it
 * works on restricted networks where hotlinking gstatic would fail, and
 * it re-applies itself so the parser-added <link id="sj-favicon"> (or
 * any extension-injected icon) can't override it.
 */
(() => {
	const TITLE = "Inbox (1) - Gmail";
	const ICON_HREF =
		"data:image/svg+xml," +
		"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'>" +
		"<rect x='7' y='11' width='34' height='26' rx='2.5' fill='%23ffffff' stroke='%23dadce0' stroke-width='2'/>" +
		"<rect x='9' y='13' width='5.5' height='22' fill='%234285F4'/>" +
		"<rect x='33.5' y='13' width='5.5' height='22' fill='%23FBBC04'/>" +
		"<path d='M9 13l15 11.5L39 13v4.5L24 29 9 17.5z' fill='%23EA4335'/>" +
		"<rect x='9' y='32.5' width='30' height='3.5' fill='%2334A853'/>" +
		"</svg>";

	function apply() {
		if (document.title !== TITLE) document.title = TITLE;

		let canonical = document.getElementById("sj-favicon");
		for (const link of document.querySelectorAll("link[rel*='icon']")) {
			if (link !== canonical) link.remove();
		}
		if (!canonical) {
			canonical = document.createElement("link");
			canonical.id = "sj-favicon";
			document.head.appendChild(canonical);
		}
		canonical.rel = "icon";
		canonical.type = "image/svg+xml";
		if (canonical.getAttribute("href") !== ICON_HREF) {
			canonical.setAttribute("href", ICON_HREF);
		}

		let theme = document.querySelector("meta[name='theme-color']");
		if (!theme) {
			theme = document.createElement("meta");
			theme.name = "theme-color";
			document.head.appendChild(theme);
		}
		const next =
			document.documentElement.dataset.theme === "light"
				? "#f1f3f4"
				: "#0d0d0d";
		if (theme.content !== next) theme.content = next;
	}

	apply();
	document.addEventListener("DOMContentLoaded", apply);
	new MutationObserver(apply).observe(document.documentElement, {
		childList: true,
		subtree: true,
	});
})();
