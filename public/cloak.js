"use strict";
/**
 * Tab cloak: disguises the tab as Gmail using the official favicon.
 */
(() => {
	document.title = "Inbox - Gmail";

	const link =
		document.querySelector("link[rel*='icon']") ||
		document.head.appendChild(
			Object.assign(document.createElement("link"), { rel: "icon" })
		);
	link.href = "https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico";
})();
