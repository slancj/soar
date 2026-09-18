<p align="center"><h1 align="center">Soar</h1></p>

A lightweight browser frontend for the [Scramjet](https://github.com/MercuryWorkshop/scramjet) web proxy. Soar provides a tabbed, browser-style UI for evading internet censorship and bypassing arbitrary web browser restrictions.

## Features

- Tabbed browsing with per-tab history, back/forward/reload, and live page titles
- Address bar with search engine support (DuckDuckGo by default)
- Full-screen browser layout with a new-tab home page
- Tabs keep running in the background and don't unload when switched
- Built-in adblock (EasyList + EasyPrivacy via `@ghostery/adblocker`) with a toolbar toggle

## Setup / Usage

You will need Node.js 22.x (see `.nvmrc`) and Git installed.

Install dependencies

```
pnpm install
```

Run the server

```
pnpm start
```

The app will be served on `http://localhost:8080`.

## Adblock lists

Filter lists are prebuilt into `public/adblock/engine.dat`. Refresh them with:

```
node scripts/update-adblock-lists.js
```

Re-run after bumping `@ghostery/adblocker` (serialized engines are version-pinned).
The library itself is bundled for browsers with:

```
node scripts/bundle-adblocker.js
```

which regenerates `public/adblock/adblocker.bundle.js` (re-run after bumps too).

## Supported Sites

Scramjet has CAPTCHA support. Some of the popular websites that Scramjet supports include:

- [Google](https://google.com)
- [Twitter](https://twitter.com)
- [Instagram](https://instagram.com)
- [Youtube](https://youtube.com)
- [Discord](https://discord.com)
- [Reddit](https://reddit.com)

Ensure you are not hosting on a datacenter IP for CAPTCHAs to work reliably along with YouTube. Heavy amounts of traffic will make some sites NOT work on a single IP. Consider rotating IPs or routing through Wireguard using a project like [wireproxy](https://github.com/whyvl/wireproxy).

See the [Scramjet](https://github.com/MercuryWorkshop/scramjet), [scramjet-controller](https://github.com/MercuryWorkshop/scramjet-controller), and [libcurl-transport](https://github.com/MercuryWorkshop/libcurl-transport) documentation for more information.
