# PoE Arb — Currency Arbitrage Overlay

A Windows system-tray overlay that detects profitable currency arbitrage cycles in Path of Exile 2 using live poe.ninja exchange data.

![Electron](https://img.shields.io/badge/Electron-30-blue) ![PoE2](https://img.shields.io/badge/PoE2-0.5%20Return%20of%20the%20Ancients-gold)

## Features

- **2-hop & 3-hop cycle detection** — finds A→B→A and A→B→C→A arbitrage cycles
- **Realistic trade ratios** — only shows pairs with whole-number ratios that actually exist on the exchange (no fake millions-of-orbs results)
- **Live sparklines** — 7-day trend chart for the intermediate currency on every card
- **Settings panel** — tune min volume, max lot size, min margin %, sparkline drop filter, refresh interval, and notification threshold
- **Desktop notifications** — alerts when new opportunities above your threshold appear; mutable via 🔔 button or tray menu
- **Blacklist** — right-click any pair to hide it; undo within 4 seconds
- **Keyboard navigation** — Tab through cards, Enter/Space to open on poe.ninja
- **F9 hotkey** — toggle the overlay from anywhere (including in-game)
- **Always on top** — works over PoE2 in Windowed Fullscreen mode

## Install

**Requirements:** [Node.js LTS](https://nodejs.org)

```
git clone https://github.com/OhhhhhhSnap/poe-arb.git
cd poe-arb
npm install
npm run dist
```

Run `release\PoE Arb Setup 1.0.1.exe` — one-click install, no config needed.

## Dev / quick run

```
npm start        # run from source (no build needed)
npm test         # run unit tests (38 tests)
npm run dist     # build installer to release\
```

## Usage

- **Click** tray icon **◆** to open/close the overlay
- **F9** anywhere to toggle
- **Right-click** a card to hide that pair (undo toast appears)
- **Click** a card to open it on poe.ninja
- **⚙** Settings — adjust all thresholds, refresh interval, notification threshold
- **🔔** Bell — mute/unmute desktop notifications
- **?** Legend — explains every badge and symbol

## Leagues

Current league: **Return of the Ancients** (PoE2 0.5)

Also supported: HC Return of the Ancients, Runes of Aldur, HC Runes of Aldur, Standard, Hardcore, and previous leagues as fallback. League list auto-detects which ones have live data on startup.

> **Note:** PoE2 must run in **Windowed Fullscreen** mode (Options → Display) for the overlay to appear over the game.

## How it works

1. Fetches live exchange rates from `poe.ninja` (PoE2 exchange endpoint, all anchored to Divine Orb)
2. Builds a directed graph of all liquid currency pairs
3. Detects 2-hop cycles (A→B→A) and 3-hop cycles (A→B→C→A)
4. Applies **realistic trade ratio constraints** — finds the simplest whole-number ratio within 2% of the market rate; skips pairs that would require unrealistic lot sizes
5. Simulates floor arithmetic to compute actual executable margin
6. Filters by volume, sparkline trend, and user-configured thresholds

## Project structure

```
poe-arb/
├── main.js              — Electron main (tray, window, IPC, notifications)
├── preload.js           — Secure contextBridge to renderer
├── src/
│   ├── ninja-client.js  — poe.ninja API client with retry + league probing
│   └── arbitrage.js     — 2-hop + 3-hop engine, realistic ratio finder
├── renderer/
│   ├── index.html       — Overlay UI
│   ├── app.js           — Renderer logic (cards, settings, blacklist, legend)
│   └── style.css        — Dark PoE-themed styling
├── test/
│   ├── rationalize.test.js   — 25 unit tests for ratio functions
│   └── threehop.test.js      — 13 unit tests for 3-hop engine
└── assets/              — Icons
```
