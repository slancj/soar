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
 * @type {HTMLInputElement}
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

	const [{ default: libcurlTransport }, { Controller }, utils] =
		await Promise.all([
			import("/libcurl/index.mjs"),
			$scramjetController,
			Promise.resolve($scramjetUtils),
		]);
	LibcurlClient = libcurlTransport;

	return {
		Controller,
		defaultConfig: $scramjet.defaultConfig,
		HttpCachePlugin: utils.HttpCachePlugin,
		UrlWatcherPlugin: utils.UrlWatcherPlugin,
		CatchEscapedLinksPlugin: utils.CatchEscapedLinksPlugin,
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
				navigator.serviceWorker.addEventListener(
					"controllerchange",
					resolve,
					{ once: true }
				);
			}),
			new Promise((resolve) => setTimeout(resolve, 500)),
		]);
	}

	return navigator.serviceWorker.controller;
}

/** @type {{ id: number, frame: any, element: HTMLIFrameElement | null, title: string, lastUrl: string }[]} */
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
		(url) =>
			new URL(`/?goto=${encodeURIComponent(url.href)}`, location.origin)
	);
	const frame = controller.createFrame(element, {
		plugins: [urlWatcher, catchEscapedLinks],
	});

	element.addEventListener("load", () => {
		syncTitle(tab);
		if (tab === activeTab) {
			updateButtons();
			try {
				address.value = tab.lastUrl;
			} catch (err) {
				// keep current value
			}
		}
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
	el.className = "sj-tab" + (tab === activeTab ? " active" : "");

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

backButton.addEventListener("click", () => activeTab?.frame?.back());
forwardButton.addEventListener("click", () => activeTab?.frame?.forward());
reloadButton.addEventListener("click", () => activeTab?.frame?.reload());
homeButton.addEventListener("click", showHome);
newTabButton.addEventListener("click", createTab);

form.addEventListener("submit", async (event) => {
	event.preventDefault();

	try {
		await navigate(address.value);
	} catch (err) {
		error.textContent = "Request failed.";
		errorCode.textContent = err.toString();
		errorWrap.hidden = false;
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

	activeTab.frame.go(target);
	syncTitle(activeTab);
}

createTab();

(async () => {
	const goto = new URL(location.href).searchParams.get("goto");
	if (goto) {
		try {
			await navigate(goto);
			history.replaceState(null, "", location.pathname || "/");
		} catch (err) {
			error.textContent = "Request failed.";
			errorCode.textContent = err.toString();
			errorWrap.hidden = false;
		}
	}
})();

window.addEventListener("load", () => {
	for (const tab of tabs) syncTitle(tab);
});

setInterval(() => {
	for (const tab of tabs) syncTitle(tab);
}, 750);