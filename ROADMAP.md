# PoE Arb — Roadmap

Items are sorted by priority (P0 = do next, P3 = nice-to-have).
Check off items as they ship.

---

## ✅ Shipped

- [x] System tray icon + F9 global hotkey toggle
- [x] asar-unpack fix so tray icon works in installed build
- [x] PoE2 poe.ninja exchange API integration
- [x] Stern-Brocot rationalization for whole-number trade constraints
- [x] 2-hop arbitrage cycle detection with floor arithmetic
- [x] Volume filtering (min divine/day threshold)
- [x] Sparkline drop filter (skip currencies in freefall)
- [x] Item icons via web.poecdn.com CDN
- [x] Compact 2-row card layout (icons, names, margin badge, steps, volume)
- [x] Click card → open poe.ninja exchange page in browser
- [x] Inline SVG sparkline (7-day price history of intermediate currency)

---

## P0 — Next Up

- [ ] **Settings panel** — sliders/inputs for:
  - Min volume threshold (divine/day) — currently hardcoded at 1.0
  - Max lot size — currently hardcoded at 200
  - Min margin % threshold — currently shows all, including negatives
  - Sparkline drop filter — currently hardcoded at -50%
  - Settings persisted via electron-store

---

## P1 — High Value

- [ ] **3-hop cycle detection** — A→B→C→A paths; more opportunities, higher margins possible
- [ ] **Desktop notification on new high-margin opp** — notify when a new opportunity
      appears above a user-defined % threshold (e.g. +3%)
- [ ] **Per-currency poe.ninja deep-link** — clicking a currency name opens its
      specific currency detail page, not just the exchange overview

---

## P2 — Quality of Life

- [ ] **Copy trade to clipboard** — button on each card copies the two trade steps
      as formatted text (e.g. "WTB 50 Chaos → 1 Divine, then WTB 1 Divine → 52 Chaos")
- [ ] **Currency blacklist** — right-click a card to hide that pair permanently;
      persisted in electron-store
- [ ] **Tooltip on hover** — show full step details, theoretical vs actual margin,
      and sparkline % change label on mouse-over
- [ ] **Adjustable refresh interval** — currently fixed at 5 min; let user set 1–30 min
- [ ] **Opportunity history** — remember the best margin seen per pair over the session

---

## P3 — Polish

- [ ] **Auto-update via electron-updater** — GitHub Releases integration so users
      get updates without reinstalling
- [ ] **Dark/light theme toggle** — currently only dark gold; add a lighter reading mode
- [ ] **Font size preference** — small / medium / large
- [ ] **Minimize to tray on startup** — option to start hidden (currently always shows)
- [ ] **Multiple league tabs** — compare opportunities across Standard and the current
      temp league side by side

---

## Known Issues / Tech Debt

- Tray menu "Show/Hide" accelerator shows CmdOrCtrl+Shift+A but the registered
  shortcut is F9 — should be consistent
- Icons occasionally fail to load if CDN is slow; onerror hides the element rather
  than showing a placeholder
- Margins are typically small (±2%) because PoE2 exchange rates are nearly symmetric
  through divine orb — 3-hop detection (P1) should surface larger real opportunities
