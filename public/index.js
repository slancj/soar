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

const { ScramjetController } = $scramjetLoadController();

const scramjet = new ScramjetController({
	files: {
		wasm: "/scram/scramjet.wasm.wasm",
		all: "/scram/scramjet.all.js",
		sync: "/scram/scramjet.sync.js",
	},
});

scramjet.init();

const connection = new BareMux.BareMuxConnection("/baremux/worker.js");

/** @type {{ id: number, frame: any, window: Window | null, title: string, lastUrl: string }[]} */
const tabs = [];
/** @type {typeof tabs[number]} */
let activeTab = null;
let tabIdCounter = 1;

function ensureTransport() {
	let wispUrl =
		(location.protocol === "https:" ? "wss" : "ws") +
		"://" +
		location.host +
		"/wisp/";
	return connection.getTransport().then((transport) => {
		if (transport !== "/libcurl/index.mjs")
			return connection.setTransport("/libcurl/index.mjs", [
				{ websocket: wispUrl },
			]);
	});
}

function createScramjetFrame(tab) {
	const frame = scramjet.createFrame();
	frame.frame.id = "sj-frame";
	frame.frame.addEventListener("load", () => {
		updateTitle(tab);
		if (tab === activeTab) {
			updateButtons();
			try {
				address.value = scramjet.decodeUrl(frame.url);
			} catch (err) {
				// keep current value
			}
		}
	});
	frame.addEventListener("navigate", (event) => {
		tab.lastUrl = scramjet.decodeUrl(event.url);
		if (tab === activeTab) {
			address.value = tab.lastUrl;
			updateTitle(tab);
		}
	});
	frame.addEventListener("urlchange", (event) => {
		tab.lastUrl = scramjet.decodeUrl(event.url);
		if (tab === activeTab) {
			address.value = tab.lastUrl;
			updateTitle(tab);
		}
	});
	frame.addEventListener("contextInit", (event) => {
		tab.window = event.window;
		try {
			const observer = new event.window.MutationObserver(() =>
				updateTitle(tab)
			);
			observer.observe(event.window.document.head, {
				childList: true,
				subtree: true,
				characterData: true,
			});
		} catch (err) {
			// title updates won't propagate, hostname will be used instead
		}
	});
	return frame;
}

function inferHostname(tab) {
	try {
		return new URL(tab.lastUrl || address.value).hostname;
	} catch (err) {
		return "New Tab";
	}
}

function updateTitle(tab) {
	let title = "";
	try {
		title = (tab.window?.document?.title || "").trim();
	} catch (err) {
		// fall through to hostname
	}
	if (!title) title = inferHostname(tab);
	if (title !== tab.title) {
		tab.title = title;
		if (tab === activeTab) document.title = title;
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
		window: null,
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

	if (tab.frame) {
		homeScreen.hidden = true;
		frameHost.hidden = false;
		frameHost.appendChild(tab.frame.frame);
		try {
			address.value = scramjet.decodeUrl(tab.frame.url);
		} catch (err) {
			address.value = tab.lastUrl || "";
		}
	} else {
		frameHost.hidden = true;
		homeScreen.hidden = false;
		address.value = "";
	}

	updateButtons();
	updateTitle(tab);
}

function closeTab(tab) {
	const index = tabs.indexOf(tab);
	if (index === -1) return;

	const wasActive = tab === activeTab;
	tabs.splice(index, 1);
	if (tab.frame) tab.frame.frame.remove();

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
		await registerSW();
	} catch (err) {
		error.textContent = "Failed to register service worker.";
		errorCode.textContent = err.toString();
		errorWrap.hidden = false;
		throw err;
	}

	errorWrap.hidden = true;

	const url = search(address.value, searchEngine.value);

	if (!activeTab.frame) {
		await ensureTransport();
		activeTab.frame = createScramjetFrame(activeTab);
		activeTab.lastUrl = url;
		homeScreen.hidden = true;
		frameHost.hidden = false;
		frameHost.appendChild(activeTab.frame.frame);
		updateButtons();
	}

	activeTab.frame.go(url);
	address.blur();
});

createTab();
address.focus();