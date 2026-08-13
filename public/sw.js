importScripts("/scram/scramjet.all.js");
importScripts("/adblock/engine.js");
importScripts("/adblock/data.js");

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
const { FiltersEngine, Request } = $ghosteryAdblocker;

const adblock = FiltersEngine.deserialize(base64ToBytes(ADBLOCK_DATA));

function base64ToBytes(base64) {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function requestType(destination) {
	switch (destination) {
		case "document":
			return "main_frame";
		case "iframe":
			return "sub_frame";
		case "style":
			return "stylesheet";
		case "script":
			return "script";
		case "image":
			return "image";
		case "font":
			return "font";
		case "object":
		case "embed":
		case "fencedframe":
			return "object";
		case "worker":
		case "sharedworker":
		case "serviceworker":
		case "audioworklet":
		case "paintworklet":
			return "other";
		case "xhr":
			return "xmlhttprequest";
		default:
			return "other";
	}
}

function refererOf(requestHeaders) {
	if (requestHeaders == null) return "";
	const referer =
		typeof requestHeaders.get === "function"
			? requestHeaders.get("referer") || requestHeaders.get("Referer") || ""
			: requestHeaders["referer"] || requestHeaders["Referer"] || "";
	return referer;
}

scramjet.addEventListener("request", (event) => {
	const request = Request.fromRawDetails({
		url: event.url.href,
		type: requestType(event.destination),
		sourceUrl: refererOf(event.requestHeaders),
	});
	if (adblock.match(request).match) {
		// Return an empty 204 response so the page keeps working without
		// the blocked ad/tracking resource.
		const response = new Response(null, {
			status: 204,
			statusText: "Blocked by adblock",
		});
		response.rawHeaders = { "content-type": "text/plain" };
		response.finalURL = event.url.href;
		event.response = response;
	}
});

scramjet.addEventListener("handleResponse", (event) => {
	if (event.destination !== "document" && event.destination !== "iframe")
		return;
	if (typeof event.responseBody !== "string") return;

	let contentType =
		event.responseHeaders["content-type"] ??
		event.responseHeaders["Content-Type"] ??
		"";
	if (Array.isArray(contentType)) contentType = contentType[0] || "";
	if (!contentType.includes("text/html")) return;

	const request = Request.fromRawDetails({
		url: event.url.href,
		type: "main_frame",
	});
	const cosmetics = adblock.getCosmeticsFilters({
		url: event.url.href,
		hostname: request.hostname,
		domain: request.domain,
		getBaseRules: true,
		getRulesFromHostname: true,
		getRulesFromDOM: true,
		getInjectionRules: true,
		getExtendedRules: false,
	});

	let tags = "";
	if (cosmetics.styles) tags += `<style>${cosmetics.styles}</style>`;
	for (const script of cosmetics.scripts || []) {
		if (script) tags += `<script>try{${script}}catch(e){}</script>`;
	}
	if (tags) event.responseBody = injectHtmlTags(event.responseBody, tags);
});

function injectHtmlTags(html, tags) {
	if (html.indexOf("</head>") !== -1)
		return html.replace("</head>", tags + "</head>");
	if (html.indexOf("</body>") !== -1)
		return html.replace("</body>", tags + "</body>");
	if (html.indexOf("</html>") !== -1)
		return html.replace("</html>", tags + "</html>");
	return tags + html;
}

async function handleRequest(event) {
	await scramjet.loadConfig();
	if (scramjet.route(event)) {
		return scramjet.fetch(event);
	}
	return fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
