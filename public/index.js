"use strict";
/**
 * @type {HTMLFormElement}
 */
const form = document.getElementById("sj-form");
/**
 * @type {HTMLInputElement}
 */
const address = document.getElementById("sj-address");
/**
 * @type {HTMLSelectElement}
 */
const searchEngine = document.getElementById("sj-search-engine");
/**
 * @type {HTMLParagraphElement}
 */
const error = document.getElementById("sj-error");
/**
 * @type {HTMLPreElement}
 */
const errorCode = document.getElementById("sj-error-code");

/**
 * @type {HTMLButtonElement}
 */
const backButton = document.getElementById("sj-back");
/**
 * @type {HTMLButtonElement}
 */
const forwardButton = document.getElementById("sj-forward");
/**
 * @type {HTMLButtonElement}
 */
const reloadButton = document.getElementById("sj-reload");
/**
 * @type {HTMLButtonElement}
 */
const homeButton = document.getElementById("sj-home");
/**
 * @type {HTMLButtonElement}
 */
const adblockToggle = document.getElementById("sj-adblock-toggle");
/**
 * @type {HTMLButtonElement}
 */
const themeToggle = document.getElementById("sj-theme-toggle");
/**
 * @type {HTMLButtonElement}
 */
const newTabButton = document.getElementById("sj-new-tab");
/**
 * @type {HTMLDivElement}
 */
const tabsEl = document.getElementById("sj-tabs");
/**
 * @type {HTMLDivElement}
 */
const homeScreen = document.getElementById("sj-home-screen");
/**
 * @type {HTMLDivElement}
 */
const frameHost = document.getElementById("sj-frame-host");
/**
 * @type {HTMLDivElement}
 */
const errorWrap = document.getElementById("sj-error-wrap");

/** @type {import("/libcurl/index.mjs").default} */
let LibcurlClient;

async function ensureGlobal(name, timeoutMs = 15000) {
	if (name in globalThis) return;

	const deadline = Date.now() + timeoutMs;
	await new Promise((resolve, reject) => {
		const tick = () => {
			if (name in globalThis) return resolve();
			if (Date.now() > deadline)
				return reject(
					new Error(
						`${name} failed to load. Check that its <script> tag loaded correctly.`
					)
				);
			setTimeout(tick, 25);
		};
		tick();
	});
}

async function initBrowser() {
	await ensureGlobal("$scramjetController");
	await ensureGlobal("$scramjetUtils");
	await ensureGlobal("GhosteryAdblocker");
	await ensureGlobal("Adblock");
	await ensureGlobal("AdblockPlugin");
	await ensureGlobal("DarkModePlugin");

	const [{ default: libcurlTransport }, { Controller }, utils] =
		await Promise.all([
			import("/libcurl/index.mjs"),
			$scramjetController,
			Promise.resolve($scramjetUtils),
		]);
	LibcurlClient = libcurlTransport;

	// Non-fatal: the proxy works unblocked if the engine fails to load.
	try {
		await window.Adblock.load();
	} catch (err) {
		console.error("[adblock] engine failed to load", err);
	}
	window.Adblock.updateBadge();

	return {
		Controller,
		defaultConfig: $scramjet.defaultConfig,
		HttpCachePlugin: utils.HttpCachePlugin,
		UrlWatcherPlugin: utils.UrlWatcherPlugin,
		CatchEscapedLinksPlugin: utils.CatchEscapedLinksPlugin,
		AdblockPlugin: window.AdblockPlugin,
		DarkModePlugin: window.DarkModePlugin,
	};
}

/** @type {Awaited<ReturnType<typeof initBrowser>> | null} */
let browserApi = null;
/** @type {import("/libcurl/index.mjs").default extends { new (options: infer O): infer T } ? T : never} */
let transport;
/** @type {InstanceType<any>} */
let controller;

async function ensureTransport() {
	const wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	transport = new LibcurlClient({ wisp: wispUrl });
}

async function waitForServiceWorkerController(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;

	while (!navigator.serviceWorker.controller) {
		if (Date.now() > deadline) break;

		await Promise.race([
			navigator.serviceWorker.ready.then(() => {}),
			new Promise((resolve) => {
				navigator.serviceWorker.addEventListener("controllerchange", resolve, {
					once: true,
				});
			}),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
	}

	return navigator.serviceWorker.controller;
}

/** Time to wait for a proxied page before reporting a stall. */
const LOAD_TIMEOUT_MS = 30000;

/** @type {{ id: number, frame: any, element: HTMLIFrameElement | null, title: string, lastUrl: string, loading: boolean, loadTimer: number }[]} */
const tabs = [];
/** @type {typeof tabs[number]} */
let activeTab = null;
let tabIdCounter = 1;

function createScramjetFrame(tab) {
	const element = document.createElement("iframe");
	element.className = "sj-frame";
	element.hidden = true;

	const urlWatcher = new browserApi.UrlWatcherPlugin((url) => {
		tab.lastUrl = url;
		syncTitle(tab);
		if (tab === activeTab) address.value = url;
	});
	const catchEscapedLinks = new browserApi.CatchEscapedLinksPlugin(
		(url) => new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin)
	);
	const adblock = new browserApi.AdblockPlugin(() => tab.lastUrl);
	const darkmode = new browserApi.DarkModePlugin(
		// Shell theme drives pages both ways — read live so the toggle
		// applies on next load without rebuilding frames.
		() => loadTheme(),
		// Verbose per-page logs. Enable with
		// `localStorage.setItem("sj-debug", "1")` in the outer console.
		(() => {
			try {
				return localStorage.getItem("sj-debug") === "1";
			} catch (err) {
				return false;
			}
		})()
	);
	const frame = controller.createFrame(element, {
		plugins: [urlWatcher, catchEscapedLinks, adblock, darkmode],
	});

	element.addEventListener("load", () => {
		tab.loading = false;
		if (tab.loadTimer) {
			clearTimeout(tab.loadTimer);
			tab.loadTimer = 0;
		}
		renderTabs();
		syncTitle(tab);
		if (tab === activeTab) {
			updateButtons();
			try {
				address.value = tab.lastUrl;
			} catch (err) {
				// keep current value
			}
		}

		// The service worker answers same-origin, so a proxy failure page
		// ("Internal Service Worker Error: ...") is readable here. An
		// iframe `load` fires for error pages too, so check explicitly.
		try {
			const text = (element.contentDocument?.body?.textContent || "").trim();
			if (text.startsWith("Internal Service Worker Error")) {
				if (tab === activeTab)
					showError("Proxy request failed.", text.slice(0, 500));
				return;
			}
		} catch (err) {
			// not readable (cross-origin or not ready) — ignore
		}
		if (tab === activeTab) clearError();
	});

	return frame;
}

function currentUrl(tab) {
	try {
		return tab.lastUrl;
	} catch (err) {
		return tab.lastUrl || "";
	}
}

function inferHostname(tab) {
	const url = currentUrl(tab) || tab.lastUrl || address.value;
	try {
		return new URL(url).hostname;
	} catch (err) {
		return "New Tab";
	}
}

function syncTitle(tab) {
	let title = "";
	try {
		title = (tab.frame?.element?.contentWindow?.document?.title || "").trim();
	} catch (err) {
		// fall through to hostname
	}
	if (!title) title = inferHostname(tab);
	if (title !== tab.title) {
		tab.title = title;
		renderTabs();
	}
}

function updateButtons() {
	const browsing = activeTab?.frame != null;
	backButton.disabled = !browsing;
	forwardButton.disabled = !browsing;
	reloadButton.disabled = !browsing;
}

function renderTab(tab) {
	const el = document.createElement("div");
	el.className =
		"sj-tab" +
		(tab === activeTab ? " active" : "") +
		(tab.loading ? " loading" : "");

	if (tab.loading) {
		const spin = document.createElement("span");
		spin.className = "sj-tab-spinner";
		spin.setAttribute("aria-hidden", "true");
		el.appendChild(spin);
	}

	const title = document.createElement("span");
	title.className = "sj-tab-title";
	title.textContent = tab.title || "New Tab";
	el.appendChild(title);

	const close = document.createElement("button");
	close.className = "sj-tab-close";
	close.type = "button";
	close.textContent = "\u00d7";
	close.title = "Close tab";
	close.addEventListener("click", (event) => {
		event.stopPropagation();
		closeTab(tab);
	});
	el.appendChild(close);

	el.addEventListener("click", () => activateTab(tab));
	return el;
}

function renderTabs() {
	tabsEl.replaceChildren(...tabs.map(renderTab));
}

function createTab() {
	const tab = {
		id: tabIdCounter++,
		frame: null,
		element: null,
		title: "New Tab",
		lastUrl: "",
		loading: false,
		loadTimer: 0,
	};
	tabs.push(tab);
	renderTabs();
	activateTab(tab);
	return tab;
}

function activateTab(tab) {
	activeTab = tab;
	renderTabs();

	for (const t of tabs) {
		if (t.frame) t.frame.element.hidden = t !== tab;
	}

	if (tab.frame) {
		homeScreen.hidden = true;
		frameHost.hidden = false;
		address.value = tab.lastUrl || "";
	} else {
		frameHost.hidden = true;
		homeScreen.hidden = false;
		address.value = "";
	}

	updateButtons();
	syncTitle(tab);
}

function closeTab(tab) {
	const index = tabs.indexOf(tab);
	if (index === -1) return;

	const wasActive = tab === activeTab;
	tabs.splice(index, 1);
	if (tab.loadTimer) clearTimeout(tab.loadTimer);
	if (tab.frame) tab.frame.element.remove();

	if (tabs.length === 0) {
		createTab();
	} else if (wasActive) {
		activateTab(tabs[Math.max(0, index - 1)]);
	} else {
		renderTabs();
	}
}

function showHome() {
	createTab();
}

function showError(message, detail) {
	error.textContent = message;
	errorCode.textContent = detail || "";
	errorWrap.hidden = false;
}

function clearError() {
	errorWrap.hidden = true;
}

const THEME_KEY = "sj-theme";
const ENGINE_KEY = "sj-engine";

function applyTheme(theme) {
	document.documentElement.dataset.theme = theme;
	try {
		localStorage.setItem(THEME_KEY, theme);
	} catch (err) {
		// private mode etc. — theme just won't persist
	}
	const meta = document.querySelector("meta[name='theme-color']");
	if (meta) meta.content = theme === "light" ? "#f1f3f4" : "#0d0d0d";
	themeToggle.textContent = theme === "light" ? "◑" : "◐";
	themeToggle.title =
		theme === "light" ? "Switch to dark theme" : "Switch to light theme";
}

function loadTheme() {
	try {
		return localStorage.getItem(THEME_KEY) || "dark";
	} catch (err) {
		return "dark";
	}
}

function engineName() {
	const selected = searchEngine.selectedOptions[0];
	return selected ? selected.textContent.trim() : "Startpage";
}

function syncEnginePlaceholder() {
	address.placeholder = `Search with ${engineName()} or enter address`;
}

try {
	const saved = localStorage.getItem(ENGINE_KEY);
	if (
		saved &&
		[...searchEngine.options].some((option) => option.value === saved)
	) {
		searchEngine.value = saved;
	}
} catch (err) {
	// ignore — default engine stands
}
syncEnginePlaceholder();
applyTheme(loadTheme());

searchEngine.addEventListener("change", () => {
	try {
		localStorage.setItem(ENGINE_KEY, searchEngine.value);
	} catch (err) {
		// ignore
	}
	syncEnginePlaceholder();
});

themeToggle.addEventListener("click", () => {
	const next = loadTheme() === "light" ? "dark" : "light";
	applyTheme(next);
	// Page forcing follows the shell theme and applies at page init —
	// reload open tabs to apply now.
	for (const tab of tabs) tab.frame?.reload();
});

backButton.addEventListener("click", () => activeTab?.frame?.back());
forwardButton.addEventListener("click", () => activeTab?.frame?.forward());
reloadButton.addEventListener("click", () => activeTab?.frame?.reload());
homeButton.addEventListener("click", showHome);
newTabButton.addEventListener("click", createTab);
adblockToggle.addEventListener("click", () => {
	if (!window.Adblock) return;
	window.Adblock.setEnabled(!window.Adblock.isEnabled());
});
form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await navigate(address.value);
	} catch (err) {
		showError("Request failed.", err.toString());
	}
	address.blur();
});

async function navigate(url) {
	await registerSW();

	if (!browserApi) browserApi = await initBrowser();

	if (!controller) {
		console.log("browserApi", browserApi);
		const serviceworker = await waitForServiceWorkerController();
		if (!serviceworker)
			throw new Error("No service worker available for controller");

		await ensureTransport();

		controller = new browserApi.Controller({
			serviceworker,
			transport,
			scramjetConfig: browserApi.defaultConfig,
		});
		await controller.wait();

		errorWrap.hidden = true;
	}

	const target = search(url, searchEngine.value);

	if (!activeTab.frame) {
		const frame = createScramjetFrame(activeTab);
		activeTab.frame = frame;
		activeTab.element = frame.element;
		frameHost.appendChild(frame.element);
		activeTab.lastUrl = target;
		homeScreen.hidden = true;
		frameHost.hidden = false;
		activateTab(activeTab);
	}

	const tab = activeTab;
	tab.frame.go(target);
	tab.lastUrl = target;
	tab.loading = true;
	renderTabs();
	clearError();
	if (tab.loadTimer) clearTimeout(tab.loadTimer);
	tab.loadTimer = setTimeout(() => {
		if (!tab.loading) return;
		tab.loading = false;
		tab.loadTimer = 0;
		renderTabs();
		if (tab !== activeTab) return;
		showError(
			"Request timed out.",
			`${target}\n\nThe proxy never responded. The host may be blocking this site (common on shared hosting IPs), or the Wisp connection dropped. Check the server logs, then retry or try another search engine.`
		);
	}, LOAD_TIMEOUT_MS);
	syncTitle(tab);
}

createTab();

// Paint the toggle initial states (engine badge updates itself).
if (window.Adblock) window.Adblock.updateBadge();

(async () => {
	const goto = new URL(location.href).searchParams.get("goto");
	if (goto) {
		try {
			await navigate(goto);
			history.replaceState(null, "", location.pathname || "/");
		} catch (err) {
			showError("Request failed.", err.toString());
		}
	}
})();

window.addEventListener("load", () => {
	for (const tab of tabs) syncTitle(tab);
});

setInterval(() => {
	for (const tab of tabs) syncTitle(tab);
}, 750);
