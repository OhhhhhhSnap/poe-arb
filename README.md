# PoE Arb — Currency Arbitrage Overlay

A Windows system-tray app that detects profitable currency arbitrage cycles in Path of Exile 2 using live poe.ninja data.

## How to install (one-time setup)

**Requirements:** [Node.js LTS](https://nodejs.org) — just install it, no configuration needed.

1. Extract this folder anywhere on your PC (e.g. `C:\PoE Arb\`)
2. Double-click **`build.bat`**
3. Wait ~2 minutes for npm to download Electron and build the installer
4. The `release\` folder opens automatically — run **`PoE Arb Setup 1.0.0.exe`**
5. App installs and starts — look for the **◆** icon in your system tray

## Usage

- **Click** the tray icon to open/close the overlay
- **Right-click** the tray icon for league selection and quick actions
- The overlay auto-refreshes every 5 minutes
- Works at any resolution, stays on top of PoE

## How it works

1. Fetches live currency exchange rates from `poe.ninja` (PoE2 exchange endpoint)
2. Builds a graph of all currency pairs
3. Detects profitable 2-hop cycles: A → B → A
4. Applies **whole-number trade constraints** so every trade is actually executable
5. Shows real margin after rounding (not theoretical float margin)

## Leagues

Supported leagues (selectable via tray right-click):
- Dawn of the Hunt / HC Dawn of the Hunt
- Fate of the Vaal / HC Fate of the Vaal
- Standard / Hardcore

## Files

```
poe-arb-overlay/
├── main.js          — Electron main process (tray, window, IPC)
├── preload.js       — Secure bridge to renderer
├── src/
│   ├── ninja-client.js  — poe.ninja API client
│   └── arbitrage.js     — Arbitrage engine + whole-number constraint
├── renderer/
│   ├── index.html   — Overlay UI
│   ├── app.js       — Renderer logic
│   └── style.css    — Dark PoE-themed styling
├── assets/
│   └── icon.ico     — App icon
└── build.bat        — Build script (double-click to build)
```
