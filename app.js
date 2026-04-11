(function () {
  'use strict';

  // ─── UTILITIES ───────────────────────────────────────────────────────────────

  function uid() {
    return Math.random().toString(36).slice(2, 10);
  }

  function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  function fmt(num, denom) {
    if (denom === 0) return '.000';
    const val = (num / denom).toFixed(3);
    return val.startsWith('1') ? '1.000' : val.replace(/^0/, '');
  }

  // ─── DEFAULT STATE ────────────────────────────────────────────────────────────

  function defaultState(innings) {
    const n = innings || 5;
    return {
      gameId:       uid(),
      date:         new Date().toISOString(),
      totalInnings: n,
      currentInning: 1,
      currentHalf:  'top',   // top = away bats, bottom = home bats
      outs:         0,
      status:       'active',
      teams: {
        away: { name: 'Away Team' },
        home: { name: 'Home Team' },
      },
      inningScores: Array.from({ length: n }, () => ({ away: 0, home: 0 })),
      players:  {},   // { [id]: { id, name, number, position, team, order } }
      atBats:   [],   // { id, playerId, result, rbi, inning, half, ts }
      gameHistory:   [],
      firebaseConfig: null,
    };
  }

  // ─── PERSISTENCE ─────────────────────────────────────────────────────────────

  const STORE_KEY = 'pines-wiffle-v1';

  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) {}
    fbSync();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Patch any missing fields from a fresh default
        return Object.assign(defaultState(parsed.totalInnings), parsed);
      }
    } catch (_) {}
    return defaultState();
  }

  let state = loadState();

  // ─── COMPUTED ────────────────────────────────────────────────────────────────

  function teamRuns(team) {
    return state.inningScores.reduce((s, inn) => s + (inn[team] || 0), 0);
  }

  function teamHits(team) {
    return Object.values(state.players)
      .filter(p => p.team === team)
      .reduce((s, p) => s + playerStats(p.id).H, 0);
  }

  function playerStats(id) {
    const abs = state.atBats.filter(ab => ab.playerId === id);
    let AB = 0, H = 0, s1 = 0, s2 = 0, s3 = 0, HR = 0,
        RBI = 0, BB = 0, HBP = 0, K = 0, SF = 0;

    for (const ab of abs) {
      const r = ab.result;
      if (r !== 'BB' && r !== 'HBP') AB++;
      if      (r === '1B')  { H++; s1++; }
      else if (r === '2B')  { H++; s2++; }
      else if (r === '3B')  { H++; s3++; }
      else if (r === 'HR')  { H++; HR++; }
      else if (r === 'BB')  BB++;
      else if (r === 'HBP') HBP++;
      else if (r === 'K')   K++;
      else if (r === 'SF')  SF++;
      RBI += (ab.rbi || 0);
    }

    const PA = AB + BB + HBP + SF;
    const TB = s1 + s2 * 2 + s3 * 3 + HR * 4;
    return {
      AB, H, s1, s2, s3, HR, RBI, BB, HBP, K, SF,
      AVG: fmt(H, AB),
      OBP: fmt(H + BB + HBP, PA),
      SLG: fmt(TB, AB),
    };
  }

  function battingTeam() {
    return state.currentHalf === 'top' ? 'away' : 'home';
  }

  // ─── FIREBASE ────────────────────────────────────────────────────────────────

  let fbRef = null;
  let isViewer = false;
  let fbReady = false;

  function fbInit(cfg) {
    if (typeof firebase === 'undefined') return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      const db = firebase.database();
      fbRef = db.ref('games/' + state.gameId);
      fbReady = true;
      if (isViewer) {
        fbRef.on('value', snap => {
          const data = snap.val();
          if (data) { state = data; renderAll(); }
        });
      }
      document.getElementById('live-indicator').classList.remove('hidden');
      return true;
    } catch (e) {
      console.warn('Firebase init error:', e);
      return false;
    }
  }

  function fbSync() {
    if (!fbRef || !fbReady || isViewer) return;
    fbRef.set(state).catch(() => {});
  }

  // ─── RENDER ──────────────────────────────────────────────────────────────────

  function renderAll() {
    renderScoreboard();
    renderGameBar();
    renderQuickScore();
    renderBatterSelect();
    renderPlayLog();
    renderLineup();
    renderStats();
    renderHistory();
  }

  function renderScoreboard() {
    const { totalInnings, currentInning, currentHalf, inningScores, teams } = state;

    // Headers
    const hdrs = document.getElementById('sb-inning-headers');
    hdrs.innerHTML = '';
    for (let i = 1; i <= totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell-header';
      el.textContent = i;
      hdrs.appendChild(el);
    }

    // Away scores
    const awayEl = document.getElementById('sb-away-scores');
    awayEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'top') el.classList.add('active');
      el.textContent = inningScores[i]?.away ?? 0;
      awayEl.appendChild(el);
    }

    // Home scores
    const homeEl = document.getElementById('sb-home-scores');
    homeEl.innerHTML = '';
    for (let i = 0; i < totalInnings; i++) {
      const el = document.createElement('div');
      el.className = 'sb-cell';
      if (i + 1 === currentInning && currentHalf === 'bottom') el.classList.add('active');
      el.textContent = inningScores[i]?.home ?? 0;
      homeEl.appendChild(el);
    }

    document.getElementById('sb-away-name').textContent = teams.away.name;
    document.getElementById('sb-home-name').textContent = teams.home.name;
    document.getElementById('sb-away-runs').textContent = teamRuns('away');
    document.getElementById('sb-home-runs').textContent = teamRuns('home');
    document.getElementById('sb-away-hits').textContent = teamHits('away');
    document.getElementById('sb-home-hits').textContent = teamHits('home');
  }

  function renderGameBar() {
    const { currentInning, currentHalf, outs } = state;
    document.getElementById('inning-label').textContent =
      ordinal(currentInning) + ' ' + (currentHalf === 'top' ? '▲' : '▼');

    for (let i = 1; i <= 3; i++) {
      const dot = document.getElementById('out' + i);
      dot.classList.toggle('filled', i <= outs);
    }
  }

  function renderQuickScore() {
    document.getElementById('qs-away-name').textContent = state.teams.away.name;
    document.getElementById('qs-home-name').textContent = state.teams.home.name;
    document.getElementById('qs-away-score').textContent = teamRuns('away');
    document.getElementById('qs-home-score').textContent = teamRuns('home');
  }

  function renderBatterSelect() {
    const sel = document.getElementById('batter-select');
    const team = battingTeam();
    const players = Object.values(state.players)
      .filter(p => p.team === team)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    sel.innerHTML = '<option value="">Select batter\u2026</option>';
    players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = (p.number ? '#' + p.number + ' ' : '') + p.name;
      sel.appendChild(opt);
    });
  }

  function renderPlayLog() {
    const log = document.getElementById('play-log');
    if (state.atBats.length === 0) {
      log.innerHTML = '<p class="empty">No plays logged yet</p>';
      return;
    }
    log.innerHTML = '';
    const recents = [...state.atBats].reverse().slice(0, 20);
    recents.forEach((ab, ri) => {
      const realIdx = state.atBats.length - 1 - ri;
      const p = state.players[ab.playerId];
      const pName = p ? p.name : 'Unknown';
      const teamName = p ? state.teams[p.team].name : '';

      const r = ab.result;
      let cls = 'badge-hit';
      if (r === 'HR') cls = 'badge-hr';
      else if (['K', 'Out', 'SF', 'E'].includes(r)) cls = 'badge-out';
      else if (['BB', 'HBP'].includes(r)) cls = 'badge-walk';

      const div = document.createElement('div');
      div.className = 'play-item';
      div.innerHTML =
        `<span class="play-badge ${cls}">${r}</span>` +
        `<div class="play-info">` +
          `<div class="play-player">${esc(pName)}</div>` +
          `<div class="play-meta">${esc(teamName)} &middot; Inn ${ab.inning}${ab.half === 'top' ? '▲' : '▼'}` +
          (ab.rbi ? ` &middot; ${ab.rbi} RBI` : '') + `</div>` +
        `</div>` +
        `<button class="play-del" data-idx="${realIdx}">&#10005;</button>`;
      log.appendChild(div);
    });
  }

  // Escape HTML to avoid XSS from player names
  function esc(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let lineupTeam = 'away';

  function renderLineup() {
    document.getElementById('lineup-title').textContent = state.teams[lineupTeam].name;
    const list = document.getElementById('lineup-list');
    const players = Object.values(state.players)
      .filter(p => p.team === lineupTeam)
      .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));

    if (players.length === 0) {
      list.innerHTML = '<p class="empty">No players yet</p>';
      return;
    }
    list.innerHTML = '';
    players.forEach(p => {
      const div = document.createElement('div');
      div.className = 'lineup-item';
      div.innerHTML =
        `<span class="player-num">${esc(p.number || '—')}</span>` +
        `<span class="player-name">${esc(p.name)}</span>` +
        (p.position ? `<span class="player-pos">${esc(p.position)}</span>` : '') +
        `<div class="player-acts">` +
          `<button class="player-act-btn" data-action="edit" data-id="${p.id}">&#9998;</button>` +
          `<button class="player-act-btn del" data-action="del" data-id="${p.id}">&#128465;</button>` +
        `</div>`;
      list.appendChild(div);
    });
  }

  let statsTeam = 'away';

  function renderStats() {
    const tbody = document.getElementById('batting-body');
    let players = Object.values(state.players);
    if (statsTeam !== 'all') players = players.filter(p => p.team === statsTeam);

    if (players.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">No players</td></tr>';
      return;
    }
    tbody.innerHTML = '';
    players.forEach(p => {
      const s = playerStats(p.id);
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td class="name-col">${esc(p.name)}</td>` +
        `<td>${s.AB}</td><td>${s.H}</td><td>${s.AVG}</td>` +
        `<td>${s.HR}</td><td>${s.RBI}</td><td>${s.BB}</td><td>${s.K}</td>` +
        `<td>${s.OBP}</td><td>${s.SLG}</td>`;
      tbody.appendChild(tr);
    });
  }

  function renderHistory() {
    const list = document.getElementById('history-list');
    if (!state.gameHistory || state.gameHistory.length === 0) {
      list.innerHTML = '<p class="empty">No past games</p>';
      return;
    }
    list.innerHTML = '';
    [...state.gameHistory].reverse().forEach(g => {
      const awayR = g.inningScores.reduce((s, i) => s + (i.away || 0), 0);
      const homeR = g.inningScores.reduce((s, i) => s + (i.home || 0), 0);
      const date  = new Date(g.date).toLocaleDateString();
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML =
        `<div class="history-score">${esc(g.teams.away.name)} ${awayR} – ${homeR} ${esc(g.teams.home.name)}</div>` +
        `<div class="history-meta">${date} &middot; ${g.status === 'final' ? 'Final' : 'In Progress'}</div>`;
      list.appendChild(div);
    });
  }

  // ─── AT-BAT ENTRY STATE ──────────────────────────────────────────────────────

  let selectedResult = null;
  let rbiCount = 0;

  function resetAtBatUI() {
    document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
    document.getElementById('rbi-row').classList.add('hidden');
    document.getElementById('batter-select').value = '';
    document.getElementById('rbi-count').textContent = '0';
    selectedResult = null;
    rbiCount = 0;
  }

  // ─── EVENT WIRING ────────────────────────────────────────────────────────────

  // Tab nav
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'stats')   renderStats();
      if (btn.dataset.tab === 'lineup')  renderLineup();
      if (btn.dataset.tab === 'history') renderHistory();
    });
  });

  // Inning navigation
  document.getElementById('next-half').addEventListener('click', () => {
    if (state.currentHalf === 'top') {
      state.currentHalf = 'bottom';
    } else {
      if (state.currentInning < state.totalInnings) {
        state.currentInning++;
        state.currentHalf = 'top';
      } else {
        state.status = 'final';
      }
    }
    state.outs = 0;
    saveState();
    renderScoreboard();
    renderGameBar();
    renderBatterSelect();
    resetAtBatUI();
  });

  document.getElementById('prev-half').addEventListener('click', () => {
    if (state.currentHalf === 'bottom') {
      state.currentHalf = 'top';
    } else if (state.currentInning > 1) {
      state.currentInning--;
      state.currentHalf = 'bottom';
    }
    state.outs = 0;
    saveState();
    renderScoreboard();
    renderGameBar();
    renderBatterSelect();
    resetAtBatUI();
  });

  // Outs
  document.getElementById('add-out-btn').addEventListener('click', () => {
    state.outs = Math.min(3, state.outs + 1);
    saveState();
    renderGameBar();
  });
  document.getElementById('undo-out-btn').addEventListener('click', () => {
    state.outs = Math.max(0, state.outs - 1);
    saveState();
    renderGameBar();
  });

  // Quick score
  document.querySelectorAll('.btn-score').forEach(btn => {
    btn.addEventListener('click', () => {
      const team = btn.dataset.team;
      const dir  = parseInt(btn.dataset.dir);
      const idx  = state.currentInning - 1;
      state.inningScores[idx][team] = Math.max(0, (state.inningScores[idx][team] || 0) + dir);
      saveState();
      renderScoreboard();
      renderQuickScore();
    });
  });

  // Result buttons
  document.querySelectorAll('.result-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!document.getElementById('batter-select').value) {
        document.getElementById('batter-select').focus();
        document.getElementById('batter-select').style.borderColor = 'var(--danger)';
        setTimeout(() => document.getElementById('batter-select').style.borderColor = '', 1200);
        return;
      }
      document.querySelectorAll('.result-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      selectedResult = btn.dataset.result;
      rbiCount = 0;
      document.getElementById('rbi-count').textContent = '0';
      document.getElementById('rbi-row').classList.remove('hidden');
    });
  });

  document.getElementById('rbi-plus').addEventListener('click', () => {
    rbiCount = Math.min(4, rbiCount + 1);
    document.getElementById('rbi-count').textContent = rbiCount;
  });
  document.getElementById('rbi-minus').addEventListener('click', () => {
    rbiCount = Math.max(0, rbiCount - 1);
    document.getElementById('rbi-count').textContent = rbiCount;
  });

  document.getElementById('log-btn').addEventListener('click', () => {
    const pid = document.getElementById('batter-select').value;
    if (!pid || !selectedResult) return;

    state.atBats.push({
      id:       uid(),
      playerId: pid,
      result:   selectedResult,
      rbi:      rbiCount,
      inning:   state.currentInning,
      half:     state.currentHalf,
      ts:       Date.now(),
    });

    // Auto-increment outs
    if (['K', 'Out', 'SF', 'E'].includes(selectedResult)) {
      state.outs = Math.min(3, state.outs + 1);
    }

    saveState();
    renderScoreboard();
    renderGameBar();
    renderPlayLog();
    resetAtBatUI();
  });

  // Delete play
  document.getElementById('play-log').addEventListener('click', e => {
    const btn = e.target.closest('.play-del');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    state.atBats.splice(idx, 1);
    saveState();
    renderScoreboard();
    renderPlayLog();
  });

  // ─── LINEUP EVENTS ───────────────────────────────────────────────────────────

  document.querySelectorAll('#tab-lineup .team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-lineup .team-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      lineupTeam = btn.dataset.team;
      renderLineup();
    });
  });

  let editingPlayerId = null;

  document.getElementById('add-player-btn').addEventListener('click', () => {
    editingPlayerId = null;
    document.getElementById('player-modal-title').textContent = 'Add Player';
    document.getElementById('pm-name').value = '';
    document.getElementById('pm-number').value = '';
    document.getElementById('pm-position').value = '';
    openModal('player-modal');
    setTimeout(() => document.getElementById('pm-name').focus(), 80);
  });

  document.getElementById('pm-save').addEventListener('click', () => {
    const name = document.getElementById('pm-name').value.trim();
    if (!name) { document.getElementById('pm-name').focus(); return; }

    const id = editingPlayerId || uid();
    const existing = editingPlayerId ? state.players[editingPlayerId] : null;
    state.players[id] = {
      id,
      name,
      number:   document.getElementById('pm-number').value.trim(),
      position: document.getElementById('pm-position').value,
      team:     lineupTeam,
      order:    existing ? existing.order : Object.values(state.players).filter(p => p.team === lineupTeam).length,
    };

    saveState();
    renderLineup();
    renderBatterSelect();
    closeModal('player-modal');
  });
  document.getElementById('pm-cancel').addEventListener('click', () => closeModal('player-modal'));

  document.getElementById('lineup-list').addEventListener('click', e => {
    const btn = e.target.closest('.player-act-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') {
      const p = state.players[id];
      editingPlayerId = id;
      document.getElementById('player-modal-title').textContent = 'Edit Player';
      document.getElementById('pm-name').value     = p.name;
      document.getElementById('pm-number').value   = p.number || '';
      document.getElementById('pm-position').value = p.position || '';
      openModal('player-modal');
    } else if (btn.dataset.action === 'del') {
      if (!confirm('Remove ' + state.players[id].name + '?')) return;
      delete state.players[id];
      saveState();
      renderLineup();
      renderBatterSelect();
    }
  });

  // Team rename
  document.getElementById('edit-team-btn').addEventListener('click', () => {
    document.getElementById('tm-name').value = state.teams[lineupTeam].name;
    openModal('team-modal');
    setTimeout(() => document.getElementById('tm-name').focus(), 80);
  });
  document.getElementById('tm-save').addEventListener('click', () => {
    const name = document.getElementById('tm-name').value.trim();
    if (!name) return;
    state.teams[lineupTeam].name = name;
    saveState();
    renderAll();
    closeModal('team-modal');
  });
  document.getElementById('tm-cancel').addEventListener('click', () => closeModal('team-modal'));

  // ─── STATS EVENTS ────────────────────────────────────────────────────────────

  document.querySelectorAll('#tab-stats .team-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-stats .team-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      statsTeam = btn.dataset.team;
      renderStats();
    });
  });

  // ─── HISTORY / NEW GAME ───────────────────────────────────────────────────────

  document.getElementById('new-game-btn').addEventListener('click', () => openModal('new-game-modal'));
  document.getElementById('ng-cancel').addEventListener('click', () => closeModal('new-game-modal'));

  document.getElementById('ng-save').addEventListener('click', () => {
    const history = state.gameHistory || [];
    history.push({
      gameId: state.gameId, date: state.date, status: 'final',
      teams: state.teams, inningScores: state.inningScores,
      players: state.players, atBats: state.atBats,
    });
    const fresh = defaultState(state.totalInnings);
    fresh.teams = JSON.parse(JSON.stringify(state.teams));
    fresh.players = JSON.parse(JSON.stringify(state.players));
    // Reset player stats (keep roster, clear at-bats)
    fresh.atBats = [];
    fresh.gameHistory = history;
    fresh.firebaseConfig = state.firebaseConfig;
    state = fresh;
    saveState();
    renderAll();
    closeModal('new-game-modal');
  });

  document.getElementById('ng-discard').addEventListener('click', () => {
    const history = state.gameHistory || [];
    const fresh = defaultState(state.totalInnings);
    fresh.gameHistory = history;
    fresh.firebaseConfig = state.firebaseConfig;
    state = fresh;
    saveState();
    renderAll();
    closeModal('new-game-modal');
  });

  // ─── SHARE ───────────────────────────────────────────────────────────────────

  document.getElementById('share-btn').addEventListener('click', () => {
    // Build snapshot share URL (base64 encoded state, no backend needed)
    const snap = {
      gameId: state.gameId, date: state.date, status: state.status,
      teams: state.teams, inningScores: state.inningScores,
      players: state.players, atBats: state.atBats,
      totalInnings: state.totalInnings, currentInning: state.currentInning,
      currentHalf: state.currentHalf, outs: state.outs,
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(snap))));
    const url = location.origin + location.pathname + '?share=' + encoded;
    document.getElementById('share-url').value = url;

    if (state.firebaseConfig) {
      document.getElementById('fb-url').value     = state.firebaseConfig.databaseURL || '';
      document.getElementById('fb-key').value     = state.firebaseConfig.apiKey      || '';
      document.getElementById('fb-project').value = state.firebaseConfig.projectId   || '';
    }
    openModal('share-modal');
  });

  document.getElementById('copy-btn').addEventListener('click', () => {
    const url = document.getElementById('share-url').value;
    navigator.clipboard.writeText(url).catch(() => {
      document.getElementById('share-url').select();
      document.execCommand('copy');
    });
    const btn = document.getElementById('copy-btn');
    const prev = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = prev), 2000);
  });

  document.getElementById('fb-connect').addEventListener('click', () => {
    const cfg = {
      databaseURL: document.getElementById('fb-url').value.trim(),
      apiKey:      document.getElementById('fb-key').value.trim(),
      projectId:   document.getElementById('fb-project').value.trim(),
    };
    if (!cfg.databaseURL || !cfg.apiKey || !cfg.projectId) {
      alert('Please fill in all three Firebase fields.');
      return;
    }
    cfg.authDomain = cfg.projectId + '.firebaseapp.com';
    state.firebaseConfig = cfg;
    saveState();

    const ok = fbInit(cfg);
    const btn = document.getElementById('fb-connect');
    if (ok) {
      btn.textContent = 'Connected!';
      btn.style.background = 'var(--success)';
      // Switch share URL to live game link
      const liveUrl = location.origin + location.pathname + '?game=' + state.gameId;
      document.getElementById('share-url').value = liveUrl;
    } else {
      btn.textContent = 'Connection failed — check credentials';
      btn.style.background = 'var(--danger)';
    }
  });

  document.getElementById('share-close').addEventListener('click', () => closeModal('share-modal'));

  // ─── SETTINGS ────────────────────────────────────────────────────────────────

  document.getElementById('settings-btn').addEventListener('click', () => {
    document.getElementById('set-innings').value = state.totalInnings;
    openModal('settings-modal');
  });
  document.getElementById('set-cancel').addEventListener('click', () => closeModal('settings-modal'));
  document.getElementById('set-save').addEventListener('click', () => {
    const n = Math.max(1, Math.min(12, parseInt(document.getElementById('set-innings').value) || 5));
    const old = state.inningScores;
    state.totalInnings = n;
    state.inningScores = Array.from({ length: n }, (_, i) => old[i] || { away: 0, home: 0 });
    if (state.currentInning > n) state.currentInning = n;
    saveState();
    renderAll();
    closeModal('settings-modal');
  });

  // ─── MODAL HELPERS ───────────────────────────────────────────────────────────

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }
  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach(bd => {
    bd.addEventListener('click', () => bd.closest('.modal').classList.add('hidden'));
  });

  // ─── VIEWER MODE ─────────────────────────────────────────────────────────────

  function checkViewerMode() {
    const params = new URLSearchParams(location.search);

    if (params.has('share')) {
      try {
        const decoded = JSON.parse(decodeURIComponent(escape(atob(params.get('share')))));
        state = Object.assign(defaultState(decoded.totalInnings), decoded);
        isViewer = true;
        document.body.classList.add('viewer-mode');
        document.getElementById('share-btn').textContent = 'View Mode';
      } catch (e) {
        console.warn('Bad share data');
      }
    }

    if (params.has('game') && state.firebaseConfig) {
      state.gameId = params.get('game');
      isViewer = true;
      document.body.classList.add('viewer-mode');
      fbInit(state.firebaseConfig);
    }
  }

  // ─── INIT ────────────────────────────────────────────────────────────────────

  checkViewerMode();
  if (!isViewer && state.firebaseConfig) {
    fbInit(state.firebaseConfig);
  }
  renderAll();

})();
