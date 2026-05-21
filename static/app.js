'use strict';

// === STATE ===
const state = {
  version: localStorage.getItem('poe-arb:version') || 'poe2',
  league: localStorage.getItem('poe-arb:league') || '',
  opportunities: [],
  flips: [],
  sessionTotal: 0,
  config: {},
  leagues: { poe1: [], poe2: [] },
  pollTimer: null,
  budget: 1000,
  currentModal: null,
  knownIds: new Set(),
  activeBase: '',  // '' = show all base currencies
};

// === AUDIO ===
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;

function playChime() {
  if (!state.config.sound_alerts) return;
  try {
    if (!audioCtx) audioCtx = new AudioCtx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.setValueAtTime(880, audioCtx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audioCtx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.18, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.5);
    osc.start(audioCtx.currentTime);
    osc.stop(audioCtx.currentTime + 0.5);
  } catch (e) {}
}

// === API ===
async function apiFetch(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadConfig() {
  state.config = await apiFetch('/api/config');
  applyConfigToSettings();
}

async function saveConfig(partial) {
  const res = await apiFetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  });
  state.config = res.config;
  applyConfigToSettings();
}

async function loadLeagues(force) {
  try {
    const url = force ? '/api/leagues?force=1' : '/api/leagues';
    const data = await apiFetch(url);
    state.leagues = data;
    renderLeagueSelect();
  } catch (e) {
    console.warn('League fetch failed, using fallback', e);
    state.leagues = {
      poe1: [
        { id: 'Settlers of Kalguur', name: 'Settlers of Kalguur', start: null, active: true },
        { id: 'Standard', name: 'Standard', start: null, active: true },
        { id: 'Hardcore', name: 'Hardcore', start: null, active: true },
      ],
      poe2: [
        { id: 'Fate of the Vaal', name: 'Fate of the Vaal', start: null, active: true },
        { id: 'Standard', name: 'Standard', start: null, active: true },
      ],
    };
    renderLeagueSelect();
    showWarning('League list unavailable — using fallback');
  }
}

async function loadOpportunities() {
  try {
    const data = await apiFetch('/api/opportunities');
    handleOpportunitiesData(data);
  } catch (e) {
    showError('Failed to load opportunities: ' + e.message);
  }
}

async function loadFlips() {
  const data = await apiFetch('/api/flips');
  state.flips = data.flips;
  state.sessionTotal = data.session_total;
  renderFlips();
  updateStatBar();
}

async function forceRefresh() {
  const btn = document.getElementById('btn-force-refresh');
  btn.style.animation = 'spin 0.5s linear';
  try {
    await apiFetch('/api/refresh');
    await loadOpportunities();
  } catch (e) {
    showError('Refresh failed: ' + e.message);
  }
  setTimeout(() => { btn.style.animation = ''; }, 600);
}

async function loadStatus() {
  try {
    const data = await apiFetch('/api/status');
    if (data.bind_all && data.lan_ip) {
      const el = document.getElementById('lan-ip');
      el.textContent = `LAN: ${data.lan_ip}:5000`;
      el.classList.remove('lan-hidden');
    }
  } catch (e) {}
}

// === DATA HANDLING ===
function handleOpportunitiesData(data) {
  const opps = data.opportunities || [];
  const newIds = new Set(opps.map(o => o.id));

  // Detect new opps for flash + chime
  const brandNew = opps.filter(o => !state.knownIds.has(o.id));
  const shouldChime = brandNew.some(o =>
    o.margin_pct >= (state.config.notify_min_margin_pct || 5)
  );
  if (shouldChime && state.knownIds.size > 0) playChime();
  state.knownIds = newIds;

  state.opportunities = opps;

  // Stale banner
  if (data.stale) {
    const age = data.data_age_seconds;
    const mins = age ? Math.floor(age / 60) : '?';
    document.getElementById('stale-age').textContent = `${mins}m`;
    document.getElementById('stale-banner').classList.remove('hidden');
  } else {
    document.getElementById('stale-banner').classList.add('hidden');
  }

  if (data.error) {
    showError(data.error);
  } else {
    hideError();
  }

  if (data.last_refresh) {
    const dt = new Date(data.last_refresh);
    document.getElementById('last-updated').textContent = dt.toLocaleTimeString();
  }

  if (data.data_age_seconds !== null && data.data_age_seconds !== undefined) {
    document.getElementById('stat-age').textContent = `${data.data_age_seconds}s`;
  }

  updateBaseFilterChips();
  renderCards(brandNew.map(o => o.id));
  updateStatBar();
  renderCalcResults();
}

// === BASE FILTER CHIPS ===
function updateBaseFilterChips() {
  const bar = document.getElementById('base-filter-chips');
  if (!bar) return;

  // Collect unique base currencies from current opportunities
  const bases = ['', ...new Set(state.opportunities.map(o => o.base_currency).filter(Boolean))];

  // Preserve active selection if still valid
  if (state.activeBase && !bases.includes(state.activeBase)) {
    state.activeBase = '';
  }

  bar.innerHTML = '';
  bases.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'base-chip' + (state.activeBase === b ? ' active' : '');
    btn.dataset.base = b;
    btn.textContent = b || 'All';
    btn.addEventListener('click', () => {
      state.activeBase = b;
      updateBaseFilterChips();
      renderCards();
    });
    bar.appendChild(btn);
  });
}

function visibleOpportunities() {
  if (!state.activeBase) return state.opportunities;
  return state.opportunities.filter(o => o.base_currency === state.activeBase);
}

// === RENDER CARDS ===
function renderCards(newIds = []) {
  const area = document.getElementById('cards-area');
  const empty = document.getElementById('empty-state');
  const visible = visibleOpportunities();

  if (visible.length === 0) {
    empty.style.display = 'flex';
    empty.querySelector('.empty-title').textContent =
      state.activeBase
        ? `No opportunities starting with ${state.activeBase}`
        : 'Scanning for opportunities...';
    // Remove all cards except empty state
    [...area.children].forEach(c => {
      if (c !== empty) c.remove();
    });
    return;
  }

  empty.style.display = 'none';

  const existingById = {};
  [...area.children].forEach(c => {
    if (c.dataset.oppId) existingById[c.dataset.oppId] = c;
  });

  const rendered = new Set();
  visible.forEach((opp, idx) => {
    rendered.add(opp.id);
    let card = existingById[opp.id];
    const isNew = newIds ? newIds.includes(opp.id) : false;
    if (!card) {
      card = buildCard(opp, isNew);
      // Insert at correct position
      const cards = [...area.querySelectorAll('.opp-card')];
      if (idx < cards.length) {
        area.insertBefore(card, cards[idx]);
      } else {
        area.appendChild(card);
      }
    } else {
      updateCard(card, opp, isNew);
    }
  });

  // Remove stale cards
  Object.entries(existingById).forEach(([id, el]) => {
    if (!rendered.has(id)) el.remove();
  });
}

function buildCard(opp, isNew) {
  const card = document.createElement('div');
  card.className = 'opp-card' + (isNew ? ' new-flash' : '');
  card.dataset.oppId = opp.id;
  card.innerHTML = cardHtml(opp);
  wireCardButtons(card, opp);
  return card;
}

function updateCard(card, opp, isNew) {
  card.innerHTML = cardHtml(opp);
  if (isNew) {
    card.classList.add('new-flash');
    setTimeout(() => card.classList.remove('new-flash'), 1000);
  }
  wireCardButtons(card, opp);
}

function cardHtml(opp) {
  const isChain = opp.type === 'multihop' && opp.path.length > 3;
  const marginClass = opp.margin_pct >= 5 ? 'green' : 'yellow';
  const budget = state.budget || 1000;
  const calcProfit = (budget * opp.absolute_profit_chaos).toFixed(1);
  const spottedAgo = timeSince(opp.spotted_at);
  const base = opp.base_currency || 'Chaos Orb';
  const baseIcon = opp.icons && opp.icons[0] ? opp.icons[0] : '';

  // Path icons — show all nodes in the cycle, including repeated start at end
  let pathHtml = '';
  opp.path.forEach((cur, i) => {
    if (i > 0) pathHtml += '<span class="path-arrow">→</span>';
    if (opp.icons && opp.icons[i]) {
      pathHtml += `<img class="currency-icon" src="${escHtml(opp.icons[i])}" alt="${escHtml(cur)}" title="${escHtml(cur)}" onerror="this.style.display='none'">`;
    } else {
      pathHtml += `<span class="path-label" title="${escHtml(cur)}">${escHtml(cur.split(' ')[0])}</span>`;
    }
  });

  // Base currency badge (only show if not "All" filter and base != Chaos)
  const baseBadgeHtml = `<span class="base-badge">${
    baseIcon ? `<img class="base-icon" src="${escHtml(baseIcon)}" alt="">` : ''
  }start: ${escHtml(base)}</span>`;

  return `
    ${isChain ? '<span class="chain-badge">CHAIN</span>' : ''}
    <div class="card-top">
      <div class="card-path-icons">${pathHtml}</div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.25rem">
        <span class="margin-badge ${marginClass}">+${opp.margin_pct.toFixed(2)}%</span>
        ${opp.urgency ? `<span class="urgency-badge">${escHtml(opp.urgency)}</span>` : ''}
      </div>
    </div>
    <div class="card-rates">
      <div class="rate-line">Buy: <span>${escHtml(opp.buy_rate)}</span></div>
      <div class="rate-line">Sell: <span>${escHtml(opp.sell_rate)}</span></div>
    </div>
    <div class="card-profit">${escHtml(opp.profit_per_trade)}</div>
    <div class="card-meta">
      ${baseBadgeHtml}
      <span class="conf-dot ${opp.confidence}" title="${opp.confidence} confidence"></span>
      <span class="abs-profit">${opp.absolute_profit_chaos.toFixed(3)}c abs</span>
      <span class="spotted">${spottedAgo}</span>
    </div>
    <div class="calc-profit-hint">Budget calc: ~<span>${calcProfit}c</span> profit</div>
    <div class="card-actions">
      <button class="btn-whisper" data-opp-id="${escHtml(opp.id)}">Copy Whisper</button>
      <button class="btn-log-flip" data-opp-id="${escHtml(opp.id)}">Log Flip</button>
    </div>
  `;
}

function wireCardButtons(card, opp) {
  card.querySelector('.btn-whisper').addEventListener('click', e => {
    const whisper = opp.trade_whisper || '';
    if (whisper) {
      navigator.clipboard.writeText(whisper).then(() => {
        const btn = e.currentTarget;
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.textContent = 'Copy Whisper';
          btn.classList.remove('copied');
        }, 1500);
      });
    }
  });

  card.querySelector('.btn-log-flip').addEventListener('click', () => {
    openLogFlipModal(opp);
  });
}

// === FLIP MODAL ===
function openLogFlipModal(opp) {
  state.currentModal = opp;
  document.getElementById('modal-path').textContent = (opp.path || []).join(' → ');
  document.getElementById('modal-expected').value = opp.absolute_profit_chaos.toFixed(4);
  document.getElementById('modal-actual').value = opp.absolute_profit_chaos.toFixed(4);
  document.getElementById('log-flip-modal').classList.remove('hidden');
  document.getElementById('modal-actual').focus();
}

function closeModal() {
  document.getElementById('log-flip-modal').classList.add('hidden');
  state.currentModal = null;
}

async function confirmFlip() {
  const opp = state.currentModal;
  if (!opp) return;
  const expected = parseFloat(document.getElementById('modal-expected').value) || 0;
  const actual = parseFloat(document.getElementById('modal-actual').value) || 0;
  await apiFetch('/api/flips', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      opportunity_id: opp.id,
      path: opp.path,
      expected_profit_chaos: expected,
      actual_profit_chaos: actual,
    }),
  });
  closeModal();
  await loadFlips();
}

// === RENDER FLIPS ===
function renderFlips() {
  const tbody = document.getElementById('flip-tbody');
  tbody.innerHTML = '';
  state.flips.forEach(f => {
    const tr = document.createElement('tr');
    const dt = new Date(f.timestamp);
    const dClass = f.delta >= 0 ? 'delta-pos' : 'delta-neg';
    tr.innerHTML = `
      <td>${dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
      <td>${(f.path || []).slice(0, 2).join('→').substring(0, 12)}</td>
      <td>${f.expected_profit.toFixed(1)}</td>
      <td>${f.actual_profit.toFixed(1)}</td>
      <td class="${dClass}">${f.delta >= 0 ? '+' : ''}${f.delta.toFixed(1)}</td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById('flip-total-val').textContent = `${state.sessionTotal.toFixed(2)}c`;
}

// === STATS BAR ===
function updateStatBar() {
  const visible = visibleOpportunities();
  const all = state.opportunities;
  document.getElementById('stat-opps').textContent =
    state.activeBase ? `${visible.length} / ${all.length}` : all.length;
  if (visible.length > 0) {
    document.getElementById('stat-best').textContent = `${visible[0].margin_pct.toFixed(2)}%`;
  } else if (all.length > 0) {
    document.getElementById('stat-best').textContent = `${all[0].margin_pct.toFixed(2)}%`;
  } else {
    document.getElementById('stat-best').textContent = '—';
  }
  document.getElementById('stat-session').textContent = `${state.sessionTotal.toFixed(2)}c`;
}

// === CALC RESULTS ===
function renderCalcResults() {
  const budget = parseInt(document.getElementById('calc-budget').value) || 1000;
  state.budget = budget;
  const container = document.getElementById('calc-results');
  container.innerHTML = '';
  const visible = visibleOpportunities();
  visible.slice(0, 8).forEach(opp => {
    const profit = (budget * opp.absolute_profit_chaos).toFixed(1);
    const chip = document.createElement('div');
    chip.className = 'calc-chip';
    const label = opp.base_currency !== 'Chaos Orb'
      ? `${opp.base_currency.split(' ')[0]}→…`
      : `${opp.path[0]}→${opp.path[opp.path.length - 1]}`;
    chip.textContent = `${label}: ~${profit}c`;
    container.appendChild(chip);
  });
  // Also update calc hints in cards
  document.querySelectorAll('.calc-profit-hint span').forEach((el, i) => {
    const opp = visible[i];
    if (opp) {
      el.textContent = `${(budget * opp.absolute_profit_chaos).toFixed(1)}c`;
    }
  });
}

// === SETTINGS ===
function applyConfigToSettings() {
  const c = state.config;
  setVal('s-base-currency', c.preferred_base || '');
  setVal('s-min-margin', c.min_margin_pct);
  setVal('s-min-abs', c.min_absolute_profit_chaos);
  setVal('s-min-volume', c.min_volume);
  setVal('s-max-depth', c.max_hop_depth);
  setVal('s-notify-margin', c.notify_min_margin_pct);
  setVal('s-webhook', c.discord_webhook_url || '');
  setCheck('s-sound', c.sound_alerts);
  setCheck('s-discord-notify', c.notify_on_new_opportunity);
  setCheck('s-lan', c.bind_all_interfaces);
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}

function setCheck(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}

// === LEAGUE SELECT ===
function renderLeagueSelect() {
  const sel = document.getElementById('league-select');
  const list = state.leagues[state.version] || [];
  const current = state.league;

  sel.innerHTML = '';
  const isStandard = ['Standard', 'Hardcore', 'HC SSF', 'SSF'];
  list.forEach((l, i) => {
    const opt = document.createElement('option');
    opt.value = l.id;
    opt.textContent = l.name;
    if (l.id === current) opt.selected = true;
    sel.appendChild(opt);
  });

  // Default: first non-standard league, or first in list
  if (!current || !list.find(l => l.id === current)) {
    const def = list.find(l => !isStandard.includes(l.name)) || list[0];
    if (def) {
      sel.value = def.id;
      state.league = def.id;
      localStorage.setItem('poe-arb:league', def.id);
    }
  }
}

// === ERROR/WARNING BANNERS ===
function showError(msg) {
  document.getElementById('error-msg').textContent = msg;
  document.getElementById('error-banner').classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function showWarning(msg) {
  // Reuse stale banner for warnings
  document.getElementById('stale-banner').textContent = '⚠ ' + msg;
  document.getElementById('stale-banner').classList.remove('hidden');
}

// === UTILS ===
function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function timeSince(iso) {
  if (!iso) return '';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// === POLL ===
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  const interval = (state.config.refresh_interval_seconds || 60) * 1000;
  state.pollTimer = setInterval(loadOpportunities, interval);
}

// === INIT ===
async function init() {
  // Set up version toggle
  const v = state.version;
  document.getElementById('btn-poe2').classList.toggle('active', v === 'poe2');
  document.getElementById('btn-poe1').classList.toggle('active', v === 'poe1');

  await loadConfig();
  await loadLeagues(false);
  await loadOpportunities();
  await loadFlips();
  await loadStatus();

  // If config has a different league, sync UI
  const cfgLeague = state.config.league_name;
  if (cfgLeague) {
    state.league = cfgLeague;
    const sel = document.getElementById('league-select');
    if (sel) sel.value = cfgLeague;
    localStorage.setItem('poe-arb:league', cfgLeague);
  }

  startPolling();

  // === EVENT LISTENERS ===

  // Version toggle
  document.querySelectorAll('.vtoggle').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ver = btn.dataset.version;
      state.version = ver;
      localStorage.setItem('poe-arb:version', ver);
      document.querySelectorAll('.vtoggle').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // Reset league to default for this version
      state.league = '';
      renderLeagueSelect();
      const league = document.getElementById('league-select').value;
      await saveConfig({ game_version: ver, league_name: league });
      await loadOpportunities();
    });
  });

  // League select
  document.getElementById('league-select').addEventListener('change', async e => {
    state.league = e.target.value;
    localStorage.setItem('poe-arb:league', state.league);
    await saveConfig({ league_name: state.league });
    await loadOpportunities();
  });

  // Refresh leagues
  document.getElementById('btn-refresh-leagues').addEventListener('click', async () => {
    await loadLeagues(true);
  });

  // Force refresh
  document.getElementById('btn-force-refresh').addEventListener('click', forceRefresh);

  // Apply filters
  document.getElementById('btn-apply-filters').addEventListener('click', async () => {
    const baseCurrency = (document.getElementById('s-base-currency').value || '').trim();
    await saveConfig({
      preferred_base: baseCurrency,
      min_margin_pct: parseFloat(document.getElementById('s-min-margin').value) || 0,
      min_absolute_profit_chaos: parseFloat(document.getElementById('s-min-abs').value) || 0,
      min_volume: parseInt(document.getElementById('s-min-volume').value) || 0,
      max_hop_depth: parseInt(document.getElementById('s-max-depth').value) || 4,
    });
    // Sync quick-filter chip to match preferred base
    state.activeBase = baseCurrency;
    updateBaseFilterChips();
    await loadOpportunities();
  });

  // Save settings
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    await saveConfig({
      sound_alerts: document.getElementById('s-sound').checked,
      notify_on_new_opportunity: document.getElementById('s-discord-notify').checked,
      notify_min_margin_pct: parseFloat(document.getElementById('s-notify-margin').value) || 5,
      discord_webhook_url: document.getElementById('s-webhook').value.trim(),
      bind_all_interfaces: document.getElementById('s-lan').checked,
    });
  });

  // Budget calculator
  document.getElementById('calc-budget').addEventListener('input', () => {
    state.budget = parseInt(document.getElementById('calc-budget').value) || 1000;
    renderCalcResults();
  });

  // Sidebar toggle (mobile)
  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const content = document.getElementById('sidebar-content');
    content.classList.toggle('collapsed');
    document.getElementById('sidebar-toggle').textContent =
      content.classList.contains('collapsed') ? '⚙ Settings ▼' : '⚙ Settings ▲';
  });

  // Clear flips
  document.getElementById('btn-clear-flips').addEventListener('click', async () => {
    await apiFetch('/api/flips', { method: 'DELETE' });
    await loadFlips();
  });

  // Log flip modal
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-confirm').addEventListener('click', confirmFlip);
  document.getElementById('log-flip-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });
}

document.addEventListener('DOMContentLoaded', init);
