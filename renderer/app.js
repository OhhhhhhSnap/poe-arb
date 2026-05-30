'use strict';

const leagueSelect      = document.getElementById('league-select');
const btnRefresh        = document.getElementById('btn-refresh');
const btnClose          = document.getElementById('btn-close');
const btnToggleLosses   = document.getElementById('btn-toggle-losses');
const btnDismissNotice  = document.getElementById('btn-dismiss-notice');
const firstRunBanner    = document.getElementById('first-run-banner');
const statusText        = document.getElementById('status-text');
const countBadge        = document.getElementById('count-badge');
const oppList           = document.getElementById('opp-list');
const tooltip           = document.getElementById('tooltip');
const toast             = document.getElementById('toast');
const toastMsg          = document.getElementById('toast-msg');
const btnUndo           = document.getElementById('btn-undo');

// Bell / notifications
const btnBell           = document.getElementById('btn-bell');

// Settings panel
const btnSettings       = document.getElementById('btn-settings');
const settingsPanel     = document.getElementById('settings-panel');
const btnSettingsClose  = document.getElementById('btn-settings-close');
const sMinVolume        = document.getElementById('s-min-volume');
const sMinVolumeVal     = document.getElementById('s-min-volume-val');
const sMaxLot           = document.getElementById('s-max-lot');
const sMaxLotVal        = document.getElementById('s-max-lot-val');
const sMinMargin        = document.getElementById('s-min-margin');
const sMinMarginVal     = document.getElementById('s-min-margin-val');
const sSparkDrop        = document.getElementById('s-spark-drop');
const sSparkDropVal     = document.getElementById('s-spark-drop-val');
const btnApplySettings      = document.getElementById('btn-apply-settings');
const btnResetSettings      = document.getElementById('btn-reset-settings');
const sRefreshInterval      = document.getElementById('s-refresh-interval');
const sRefreshIntervalVal   = document.getElementById('s-refresh-interval-val');
const sNotifThreshold       = document.getElementById('s-notif-threshold');
const sNotifThresholdVal    = document.getElementById('s-notif-threshold-val');
const btnBlacklistToggle    = document.getElementById('btn-blacklist-toggle');
const blacklistList         = document.getElementById('blacklist-list');
const blacklistItems        = document.getElementById('blacklist-items');
const blacklistEmpty        = document.getElementById('blacklist-empty');
const blacklistCountBadge   = document.getElementById('blacklist-count-badge');
const btnLegend             = document.getElementById('btn-legend');
const legendPopup           = document.getElementById('legend-popup');

const SETTINGS_DEFAULTS = {
  minVolumeDivine:       1.0,
  maxLotSize:            200,
  minMarginPct:          -100,
  maxSparklineDrop:      -50,
  refreshIntervalMin:    5,
  notificationThreshold: 2.0,
};

let notificationsMuted = false;

let currentLeague    = '';
let showLosses       = true;
let blacklist        = new Set();
let allOpportunities = [];
let toastTimer       = null;
let lastBlacklisted  = null; // { key, op } for undo
let store_refreshMs  = 300000; // mirrors persisted value for status bar display

// ─── Bell helper ──────────────────────────────────────────────────────────────
function applyBellState(muted) {
  btnBell.textContent = muted ? '🔕' : '🔔';
  btnBell.setAttribute('aria-label', muted ? 'Unmute notifications' : 'Mute notifications');
  btnBell.classList.toggle('bell-active', !muted);
  btnBell.classList.toggle('bell-muted',   muted);
}

// ─── Refresh label helper ─────────────────────────────────────────────────────
function updateRefreshLabel(intervalMin) {
  store_refreshMs = intervalMin * 60000;
}

// ─── Blacklist UI helper ──────────────────────────────────────────────────────
async function renderBlacklistUI() {
  const bl = await window.poeArb.getBlacklist();
  blacklistCountBadge.textContent = bl.length > 0 ? bl.length : '';
  blacklistCountBadge.style.display = bl.length > 0 ? '' : 'none';

  if (bl.length === 0) {
    blacklistItems.innerHTML = '';
    blacklistEmpty.style.display = 'block';
    return;
  }
  blacklistEmpty.style.display = 'none';

  blacklistItems.innerHTML = bl.map(key => {
    const label = key.split('|||').join(' ⇄ ');
    return `<div class="bl-item">
      <span class="bl-item-label" title="${escAttr(label)}">${escHtml(label)}</span>
      <button class="bl-item-remove" data-key="${escAttr(key)}" aria-label="Unhide ${escAttr(label)}" title="Unhide">✕</button>
    </div>`;
  }).join('');

  blacklistItems.querySelectorAll('.bl-item-remove').forEach(btn => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.key;
      blacklist.delete(key);
      await window.poeArb.removeFromBlacklist(key);
      renderList(allOpportunities);
      renderBlacklistUI();
    });
  });
}

// ─── Settings helpers ─────────────────────────────────────────────────────────
function applySettingsToUI({ minVolumeDivine, maxLotSize, minMarginPct, maxSparklineDrop, refreshIntervalMin, notificationThreshold }) {
  sMinVolume.value      = minVolumeDivine;
  sMinVolumeVal.textContent = parseFloat(minVolumeDivine).toFixed(1);

  sMaxLot.value         = maxLotSize;
  sMaxLotVal.textContent = maxLotSize;

  // minMarginPct: slider goes -10..5; values <= -10 mean "no filter" (shown as –∞)
  const clampedMargin   = Math.max(-10, Math.min(5, minMarginPct));
  sMinMargin.value      = minMarginPct <= -10 ? -10 : clampedMargin;
  sMinMarginVal.textContent = minMarginPct <= -10 ? '–∞'
    : (minMarginPct >= 0 ? '+' : '') + minMarginPct.toFixed(1) + '%';

  sSparkDrop.value          = maxSparklineDrop;
  sSparkDropVal.textContent = maxSparklineDrop + '%';

  const rMin = refreshIntervalMin ?? SETTINGS_DEFAULTS.refreshIntervalMin;
  sRefreshInterval.value          = rMin;
  sRefreshIntervalVal.textContent = rMin + ' min';

  const thr = notificationThreshold ?? SETTINGS_DEFAULTS.notificationThreshold;
  sNotifThreshold.value          = thr;
  sNotifThresholdVal.textContent = '+' + parseFloat(thr).toFixed(1) + '%';
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  const [leagues, data, bl, savedLosses, firstRunDone,
         savedMinVol, savedMaxLot, savedMinMargin, savedSparkDrop,
         savedRefreshMs, savedNotifThreshold, savedMuted] = await Promise.all([
    window.poeArb.getLeagues(),
    window.poeArb.getData(),
    window.poeArb.getBlacklist(),
    window.poeArb.getPref('showLosses', true),
    window.poeArb.getPref('firstRunDone', false),
    window.poeArb.getPref('minVolumeDivine',       SETTINGS_DEFAULTS.minVolumeDivine),
    window.poeArb.getPref('maxLotSize',            SETTINGS_DEFAULTS.maxLotSize),
    window.poeArb.getPref('minMarginPct',          SETTINGS_DEFAULTS.minMarginPct),
    window.poeArb.getPref('maxSparklineDrop',      SETTINGS_DEFAULTS.maxSparklineDrop),
    window.poeArb.getPref('refreshIntervalMs',     SETTINGS_DEFAULTS.refreshIntervalMin * 60000),
    window.poeArb.getPref('notificationThreshold', SETTINGS_DEFAULTS.notificationThreshold),
    window.poeArb.getPref('notificationsMuted',    false),
  ]);

  notificationsMuted = savedMuted;
  store_refreshMs    = savedRefreshMs;
  applyBellState(notificationsMuted);

  // Init settings sliders to persisted values
  applySettingsToUI({
    minVolumeDivine: savedMinVol, maxLotSize: savedMaxLot,
    minMarginPct: savedMinMargin, maxSparklineDrop: savedSparkDrop,
    refreshIntervalMin: Math.round(savedRefreshMs / 60000),
    notificationThreshold: savedNotifThreshold,
  });

  currentLeague = data.league ?? '';
  blacklist     = new Set(bl);
  showLosses    = savedLosses;
  btnToggleLosses.classList.toggle('active', showLosses);

  if (!firstRunDone) {
    firstRunBanner.style.display = 'flex';
  }

  leagues.forEach((l) => {
    const opt = document.createElement('option');
    opt.value = l; opt.textContent = l;
    opt.selected = l === currentLeague;
    leagueSelect.appendChild(opt);
  });

  render(data);

  // ── Button listeners ──────────────────────────────────────────────────────
  btnRefresh.addEventListener('click', () => {
    btnRefresh.disabled = true;
    window.poeArb.refresh();
  });
  btnClose.addEventListener('click', () => window.poeArb.closeWindow());
  leagueSelect.addEventListener('change', () => {
    currentLeague = leagueSelect.value;
    window.poeArb.setLeague(leagueSelect.value);
  });
  btnToggleLosses.addEventListener('click', () => {
    showLosses = !showLosses;
    window.poeArb.setPref('showLosses', showLosses);
    btnToggleLosses.classList.toggle('active', showLosses);
    renderList(allOpportunities);
  });
  btnDismissNotice.addEventListener('click', () => {
    firstRunBanner.style.display = 'none';
    window.poeArb.setPref('firstRunDone', true);
  });

  // ── Bell: mute/unmute ─────────────────────────────────────────────────────
  btnBell.addEventListener('click', async () => {
    notificationsMuted = !notificationsMuted;
    applyBellState(notificationsMuted);
    await window.poeArb.setNotificationsMuted(notificationsMuted);
    showToast(notificationsMuted ? 'Notifications muted 🔕' : 'Notifications on 🔔');
  });
  // Sync bell if user toggles via tray menu
  window.poeArb.onNotificationsMutedChanged((muted) => {
    notificationsMuted = muted;
    applyBellState(muted);
  });

  // ── Settings panel ────────────────────────────────────────────────────────
  btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = open ? 'none' : 'block';
  });
  btnSettingsClose.addEventListener('click', () => {
    settingsPanel.style.display = 'none';
  });
  // Close panel when clicking outside
  document.addEventListener('click', (e) => {
    if (settingsPanel.style.display !== 'none' &&
        !settingsPanel.contains(e.target) && e.target !== btnSettings) {
      settingsPanel.style.display = 'none';
    }
  });

  // Live-update value labels as sliders move
  sMinVolume.addEventListener('input',  () => { sMinVolumeVal.textContent = parseFloat(sMinVolume.value).toFixed(1); });
  sMaxLot.addEventListener('input',     () => { sMaxLotVal.textContent = sMaxLot.value; });
  sMinMargin.addEventListener('input',  () => {
    const v = parseFloat(sMinMargin.value);
    sMinMarginVal.textContent = v <= -10 ? '–∞' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  });
  sSparkDrop.addEventListener('input', () => { sSparkDropVal.textContent = sSparkDrop.value + '%'; });
  sRefreshInterval.addEventListener('input', () => {
    sRefreshIntervalVal.textContent = sRefreshInterval.value + ' min';
  });
  sNotifThreshold.addEventListener('input', () => {
    sNotifThresholdVal.textContent = '+' + parseFloat(sNotifThreshold.value).toFixed(1) + '%';
  });

  btnApplySettings.addEventListener('click', async () => {
    const minVol      = parseFloat(sMinVolume.value);
    const maxLot      = parseInt(sMaxLot.value, 10);
    const minMargin   = parseFloat(sMinMargin.value) <= -10 ? -100 : parseFloat(sMinMargin.value);
    const sparkDrop   = parseInt(sSparkDrop.value, 10);
    const refreshMs   = parseInt(sRefreshInterval.value, 10) * 60000;
    const notifThr    = parseFloat(sNotifThreshold.value);
    await Promise.all([
      window.poeArb.setPref('minVolumeDivine',       minVol),
      window.poeArb.setPref('maxLotSize',            maxLot),
      window.poeArb.setPref('minMarginPct',          minMargin),
      window.poeArb.setPref('maxSparklineDrop',      sparkDrop),
      window.poeArb.setPref('notificationThreshold', notifThr),
      window.poeArb.setRefreshInterval(refreshMs),
    ]);
    // Update status bar to reflect new interval
    updateRefreshLabel(parseInt(sRefreshInterval.value, 10));
    settingsPanel.style.display = 'none';
    btnRefresh.disabled = true;
    window.poeArb.refresh();
  });

  btnResetSettings.addEventListener('click', async () => {
    applySettingsToUI(SETTINGS_DEFAULTS);
    const refreshMs = SETTINGS_DEFAULTS.refreshIntervalMin * 60000;
    await Promise.all([
      window.poeArb.setPref('minVolumeDivine',       SETTINGS_DEFAULTS.minVolumeDivine),
      window.poeArb.setPref('maxLotSize',            SETTINGS_DEFAULTS.maxLotSize),
      window.poeArb.setPref('minMarginPct',          SETTINGS_DEFAULTS.minMarginPct),
      window.poeArb.setPref('maxSparklineDrop',      SETTINGS_DEFAULTS.maxSparklineDrop),
      window.poeArb.setPref('notificationThreshold', SETTINGS_DEFAULTS.notificationThreshold),
      window.poeArb.setRefreshInterval(refreshMs),
    ]);
    updateRefreshLabel(SETTINGS_DEFAULTS.refreshIntervalMin);
    settingsPanel.style.display = 'none';
    btnRefresh.disabled = true;
    window.poeArb.refresh();
  });

  // ── Undo toast ────────────────────────────────────────────────────────────
  btnUndo.addEventListener('click', () => {
    if (!lastBlacklisted) return;
    blacklist.delete(lastBlacklisted.key);
    window.poeArb.removeFromBlacklist(lastBlacklisted.key);
    hideToast();
    renderList(allOpportunities);
  });

  // ── Image error delegation (avoids CSP-blocked inline onerror) ───────────
  oppList.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'IMG') e.target.style.display = 'none';
  }, true);

  // ── Clicks: copy button → card click ─────────────────────────────────────
  oppList.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('.btn-copy');
    if (copyBtn) {
      e.stopPropagation();
      const card = copyBtn.closest('.opp-card');
      if (card?.dataset.trade) {
        navigator.clipboard.writeText(card.dataset.trade).then(() => {
          copyBtn.textContent = '✓';
          copyBtn.classList.add('copied');
          setTimeout(() => { copyBtn.textContent = '⎘'; copyBtn.classList.remove('copied'); }, 1200);
        });
      }
      return;
    }
    const card = e.target.closest('.opp-card');
    if (card?.dataset.url) openCard(card);
  });

  // ── Keyboard nav: Enter/Space on focused card ─────────────────────────────
  oppList.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      const card = e.target.closest('.opp-card');
      if (card?.dataset.url) { e.preventDefault(); openCard(card); }
    }
  });

  // ── Right-click → blacklist with undo ────────────────────────────────────
  oppList.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const card = e.target.closest('.opp-card');
    if (!card?.dataset.pair) return;
    const key = card.dataset.pair;
    const label = card.dataset.label ?? key;
    blacklist.add(key);
    window.poeArb.addToBlacklist(key);
    lastBlacklisted = { key };
    renderList(allOpportunities);
    showToast(`Hidden: ${label}`);
  });

  // ── Tooltip on hover ──────────────────────────────────────────────────────
  oppList.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.opp-card');
    if (!card?.dataset.tip) return;
    tooltip.innerHTML = card.dataset.tip;
    tooltip.style.display = 'block';
    positionTooltip(card);
  });
  oppList.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget?.closest?.('#opp-list')) tooltip.style.display = 'none';
  });

  // ── Blacklist manager ─────────────────────────────────────────────────────
  btnBlacklistToggle.addEventListener('click', () => {
    const open = blacklistList.style.display !== 'none';
    blacklistList.style.display = open ? 'none' : 'block';
    btnBlacklistToggle.setAttribute('aria-expanded', String(!open));
    if (!open) renderBlacklistUI();
  });

  // ── Legend popup ──────────────────────────────────────────────────────────
  btnLegend.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = legendPopup.style.display !== 'none';
    legendPopup.style.display = open ? 'none' : 'block';
    // Position below the status bar
    const rect = document.getElementById('status-bar').getBoundingClientRect();
    legendPopup.style.top = (rect.bottom + 4) + 'px';
  });
  document.addEventListener('click', (e) => {
    if (legendPopup.style.display !== 'none' && !legendPopup.contains(e.target) && e.target !== btnLegend)
      legendPopup.style.display = 'none';
  });

  window.poeArb.onDataUpdate((d) => { currentLeague = d.league ?? currentLeague; render(d); });
}

function openCard(card) {
  card.classList.add('clicking');
  setTimeout(() => card.classList.remove('clicking'), 150);
  window.poeArb.openUrl(card.dataset.url);
}

// ─── Toast ────────────────────────────────────────────────────────────────────
function showToast(msg) {
  toastMsg.textContent = msg;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 4000);
}
function hideToast() {
  toast.classList.remove('visible');
  toastTimer = null;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function render(data) {
  const { opportunities = [], loading, lastUpdated, error, league } = data;
  if (league && leagueSelect.value !== league) leagueSelect.value = league;

  if (loading) {
    statusText.innerHTML = '<span class="loading-dot"></span> Fetching…';
    btnRefresh.disabled = true;
    btnRefresh.classList.add('spinning');
  } else {
    btnRefresh.disabled = false;
    btnRefresh.classList.remove('spinning');
    if (error) {
      statusText.innerHTML = `<span class="error-text">⚠ ${escHtml(error)}</span>`;
    } else if (lastUpdated) {
      const t = new Date(lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const intervalMin = Math.round((store_refreshMs ?? 300000) / 60000);
      statusText.textContent = `Updated ${t} · auto-refresh ${intervalMin} min`;
    } else {
      statusText.textContent = 'Ready';
    }
  }

  allOpportunities = opportunities;
  renderList(opportunities);
}

function renderList(opportunities) {
  const visible = opportunities.filter(op => {
    if (blacklist.has(pairKey(op))) return false;
    if (!showLosses && op.actualMarginPct < 0) return false;
    return true;
  });

  if (visible.length > 0) {
    countBadge.textContent = `${visible.length} pairs`;
    countBadge.style.display = '';
  } else {
    countBadge.style.display = 'none';
  }

  if (visible.length === 0 && allOpportunities.length === 0) {
    oppList.innerHTML = `
      <div class="empty-state">
        <div class="icon" aria-hidden="true">◇</div>
        <div>No exchange data for this league</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          poe.ninja may not have indexed it yet — try Standard or refresh in a few hours
        </div>
      </div>`;
    return;
  }

  if (visible.length === 0) {
    oppList.innerHTML = `
      <div class="empty-state">
        <div class="icon" aria-hidden="true">◆</div>
        <div>All pairs hidden</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">
          Toggle <strong>Losses</strong> or right-click a pair to unhide it
        </div>
      </div>`;
    return;
  }

  // Error boundary: render cards individually, skip malformed ones
  const cards = [];
  for (const op of visible) {
    try {
      cards.push(cardHtml(op, currentLeague));
    } catch (err) {
      console.warn('[renderer] Skipped malformed opportunity:', err.message, op);
    }
  }
  oppList.innerHTML = cards.join('');
}

// ─── Sparkline SVG ────────────────────────────────────────────────────────────
function sparklinePoints(pts, W = 56, H = 18) {
  if (!pts || pts.length < 2) return '';
  const prices = pts.map(d => 100 * (1 + (d ?? 0) / 100));
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 1;
  return prices.map((p, i) => {
    const x = (i / (prices.length - 1)) * W;
    const y = (H - 2) - ((p - min) / range) * (H - 4) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// ─── Card ─────────────────────────────────────────────────────────────────────
function cardHtml(op, league) {
  const margin = op.actualMarginPct;
  const sign   = margin >= 0 ? '+' : '';
  const is3hop = op.type === '3hop';
  let badgeClass;
  if      (margin >= 3)  badgeClass = 'good';
  else if (margin >= 1)  badgeClass = 'okay';
  else if (margin >= 0)  badgeClass = 'warn';
  else                   badgeClass = 'loss';

  const slug     = (league ?? '').toLowerCase().replace(/\s+/g, '-');
  const ninjaUrl = `https://poe.ninja/poe2/economy/${slug}/currency?type=${encodeURIComponent(op.viaCurrency)}`;

  const profit    = (op.returnAmount ?? 0) - (op.minLot ?? 0);
  const profitStr = profit > 0 ? ` (+${profit} ${op.fromCurrency})` : '';

  // Copy text: full chain
  const tradeText = is3hop
    ? `${op.step1} | ${op.step2} | ${op.step3}  [${sign}${margin.toFixed(2)}%]`
    : `${op.step1} → ${op.returnAmount} ${op.fromCurrency}${profitStr}  [${sign}${margin.toFixed(2)}%]`;

  const vol     = op.volumeB ?? 0;
  const volText = vol >= 1000 ? `${(vol / 1000).toFixed(1)}k◆`
                : vol >= 1   ? `${Math.round(vol)}◆` : '<1◆';

  const sparkPct   = op.sparklineB ?? 0;
  const sparkPts   = sparklinePoints(op.sparklineDataB);
  const sparkColor = sparkPct >= 0 ? '#52a84f' : '#b84444';
  const sparkLabel = (sparkPct >= 0 ? '+' : '') + sparkPct.toFixed(1) + '%';
  const svgSpark   = sparkPts
    ? `<svg class="sparkline" width="56" height="18" viewBox="0 0 56 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
      `<polyline points="${sparkPts}" fill="none" stroke="${sparkColor}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `</svg><span class="spark-pct" style="color:${sparkColor}">${escHtml(sparkLabel)}</span>`
    : '';

  const iconA = op.iconA
    ? `<img class="curr-icon" src="${escAttr(op.iconA)}" loading="lazy" alt="${escAttr(op.fromCurrency)}">`
    : `<span class="icon-fallback" aria-hidden="true">◆</span>`;
  const iconB = op.iconB
    ? `<img class="curr-icon" src="${escAttr(op.iconB)}" loading="lazy" alt="${escAttr(op.viaCurrency)}">`
    : `<span class="icon-fallback" aria-hidden="true">◆</span>`;
  const iconC = is3hop
    ? (op.iconC
        ? `<img class="curr-icon" src="${escAttr(op.iconC)}" loading="lazy" alt="${escAttr(op.viaCurrency2)}">`
        : `<span class="icon-fallback" aria-hidden="true">◆</span>`)
    : '';

  const tipTheo = op.theoreticalMarginPct != null
    ? `<div class="tip-row"><span>Theoretical</span><span>${(op.theoreticalMarginPct >= 0 ? '+' : '')}${op.theoreticalMarginPct.toFixed(3)}%</span></div>` : '';

  const tipSteps = is3hop
    ? `<div class="tip-row"><span>Step 1</span><span>${escHtml(op.step1)}</span></div>
       <div class="tip-row"><span>Step 2</span><span>${escHtml(op.step2)}</span></div>
       <div class="tip-row"><span>Step 3</span><span>${escHtml(op.step3)}</span></div>`
    : `<div class="tip-row"><span>Step 1</span><span>${escHtml(op.step1)}</span></div>
       <div class="tip-row"><span>Step 2</span><span>${escHtml(op.step2)}</span></div>`;

  const chainLabel = is3hop
    ? `${op.fromCurrency} → ${op.viaCurrency} → ${op.viaCurrency2} → ${op.fromCurrency}`
    : `${op.fromCurrency} ⇄ ${op.viaCurrency}`;

  const tipHtml = `
    <div class="tip-title">${escHtml(chainLabel)}</div>
    ${tipSteps}
    <div class="tip-row"><span>Profit</span><span class="${badgeClass}">${profit > 0 ? '+' : ''}${profit} ${escHtml(op.fromCurrency)}</span></div>
    <div class="tip-divider"></div>
    <div class="tip-row"><span>Actual margin</span><span class="${badgeClass}">${sign}${margin.toFixed(3)}%</span></div>
    ${tipTheo}
    <div class="tip-row"><span>Volume (via)</span><span>${volText}/day</span></div>
    <div class="tip-row"><span>7-day trend</span><span style="color:${sparkColor}">${escHtml(sparkLabel)}</span></div>
    <div class="tip-footer">Right-click to hide · Click to open poe.ninja</div>`;

  const pKey  = pairKey(op);
  const label = chainLabel;

  // Card name display
  const namesHtml = is3hop
    ? `<span class="curr-a">${escHtml(op.fromCurrency)}</span>
       <span class="arrow" aria-hidden="true">→</span>
       <span class="curr-b">${escHtml(op.viaCurrency)}</span>
       <span class="arrow" aria-hidden="true">→</span>
       <span class="curr-b">${escHtml(op.viaCurrency2)}</span>`
    : `<span class="curr-a">${escHtml(op.fromCurrency)}</span>
       <span class="arrow" aria-hidden="true">⇄</span>
       <span class="curr-b">${escHtml(op.viaCurrency)}</span>`;

  const stepsInline = is3hop
    ? `${escHtml(op.step1)} → ${escHtml(op.cAmount)} ${escHtml(op.viaCurrency2)} → ${escHtml(op.returnAmount)} ${escHtml(op.fromCurrency)}`
    : `${escHtml(op.step1)} → ${escHtml(op.returnAmount)} ${escHtml(op.fromCurrency)}`;

  return `
    <div class="opp-card${margin < 0 ? ' card-loss' : ''}${is3hop ? ' card-3hop' : ''}"
         role="listitem" tabindex="0"
         aria-label="${escAttr(label + ' ' + sign + margin.toFixed(2) + '%')}"
         data-url="${escAttr(ninjaUrl)}"
         data-pair="${escAttr(pKey)}"
         data-label="${escAttr(label)}"
         data-trade="${escAttr(tradeText)}"
         data-tip="${escAttr(tipHtml)}">
      <div class="card-row-top">
        <div class="card-icons">${iconA}${iconB}${iconC}</div>
        <div class="card-names">${namesHtml}</div>
        <span class="lot-badge" title="Minimum trade: ${escAttr(op.minLot + ' ' + op.fromCurrency)}">⊕${op.minLot}</span>
        <span class="margin-badge ${badgeClass}" aria-label="Margin ${sign}${margin.toFixed(2)} percent">${sign}${margin.toFixed(2)}%</span>
      </div>
      <div class="card-row-bot">
        <span class="steps-inline">${stepsInline}${profitStr ? `<span class="profit-inline">${escHtml(profitStr)}</span>` : ''}</span>
        <span class="card-meta">${volText}${svgSpark ? ' ' + svgSpark : ''}</span>
        <button class="btn-copy" title="Copy trade to clipboard" aria-label="Copy trade">⎘</button>
      </div>
    </div>`;
}

// ─── Tooltip positioning ──────────────────────────────────────────────────────
function positionTooltip(card) {
  const rect = card.getBoundingClientRect();
  const tW   = 220;
  const vW   = window.innerWidth;
  const vH   = window.innerHeight;
  tooltip.style.width = tW + 'px';

  let left = rect.left;
  let top  = rect.bottom + 4;
  const tH = tooltip.offsetHeight || 130;

  if (left + tW > vW - 4) left = vW - tW - 4;
  if (top  + tH > vH - 4) top  = rect.top - tH - 4;

  tooltip.style.left = left + 'px';
  tooltip.style.top  = top  + 'px';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pairKey(op) {
  const currencies = op.type === '3hop'
    ? [op.fromCurrency, op.viaCurrency, op.viaCurrency2]
    : [op.fromCurrency, op.viaCurrency];
  return currencies.sort().join('|||');
}
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

init().catch(console.error);
