(function () {
  'use strict';

  // ─── AFFILIATE CONFIG ─────────────────────────────────────────────────────────
  // Paste your affiliate IDs here once approved. Leave blank to use plain links.
  //
  // Amazon Associates:  affiliate-program.amazon.com  → your tag looks like "pineswiffle-20"
  // Target (Impact):    impact.com  → search "Target Affiliates" → your ID is a number
  // Walmart (Impact):   impact.com  → search "Walmart" → your ID is a number
  // Dick's (CJ):        cj.com      → search "Dick's Sporting Goods" → grab your PID

  const AFFILIATES = {
    amazon:  '',   // e.g. 'pineswiffle-20'
    target:  '',   // e.g. '1234567'  (Impact publisher ID)
    walmart: '',   // e.g. '1234567'  (Impact publisher ID)
    dicks:   '',   // e.g. '1234567'  (CJ PID)
  };

  function amazonUrl(query) {
    const base = 'https://www.amazon.com/s?k=' + encodeURIComponent(query);
    return AFFILIATES.amazon ? base + '&tag=' + AFFILIATES.amazon : base;
  }
  function targetUrl(query) {
    const base = 'https://www.target.com/s?searchTerm=' + encodeURIComponent(query);
    return AFFILIATES.target
      ? 'https://goto.target.com/c/' + AFFILIATES.target + '/wiffle?' + encodeURIComponent(base)
      : base;
  }
  function walmartUrl(query) {
    const base = 'https://www.walmart.com/search?q=' + encodeURIComponent(query);
    return AFFILIATES.walmart
      ? 'https://goto.walmart.com/c/' + AFFILIATES.walmart + '/wiffle?' + encodeURIComponent(base)
      : base;
  }
  function dicksUrl(query) {
    const base = 'https://www.dickssportinggoods.com/search?searchTerm=' + encodeURIComponent(query);
    return AFFILIATES.dicks
      ? base + '&PID=' + AFFILIATES.dicks
      : base;
  }

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
  let fbScheduleRef = null;
  let isViewer = false;
  let fbReady = false;

  // Local schedule storage (fallback when no Firebase)
  let schedule = loadSchedule();

  function loadSchedule() {
    try {
      return JSON.parse(localStorage.getItem('pines-wiffle-schedule') || '[]');
    } catch (_) { return []; }
  }

  function saveScheduleLocal() {
    try { localStorage.setItem('pines-wiffle-schedule', JSON.stringify(schedule)); } catch (_) {}
  }

  function fbInit(cfg) {
    if (typeof firebase === 'undefined') return false;
    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      const db = firebase.database();
      fbRef = db.ref('games/' + state.gameId);
      fbReady = true;

      // Shared schedule ref — same for all users
      fbScheduleRef = db.ref('schedule');
      fbScheduleRef.on('value', snap => {
        const data = snap.val();
        schedule = data ? Object.values(data) : [];
        saveScheduleLocal();
        renderSchedule();
        renderUpcomingBanner();
      });

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

  function fbSyncSchedule() {
    if (!fbScheduleRef) return;
    // Write each game by its id so merges work cleanly
    const obj = {};
    schedule.forEach(g => { obj[g.id] = g; });
    fbScheduleRef.set(obj).catch(() => {});
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
    renderUpcomingBanner();
  }

  function nextUpcomingGame() {
    const now = Date.now();
    return schedule
      .filter(g => new Date(g.date + 'T' + (g.time || '23:59')).getTime() >= now)
      .sort((a, b) => new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00')))[0] || null;
  }

  function renderUpcomingBanner() {
    const banner = document.getElementById('upcoming-banner');
    const next = nextUpcomingGame();
    if (!next) { banner.classList.add('hidden'); return; }

    const d = new Date(next.date + 'T' + (next.time || '12:00'));
    const dateStr = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const timeStr = next.time ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

    document.getElementById('upcoming-title').textContent = `${next.away} vs ${next.home}`;
    document.getElementById('upcoming-meta').textContent =
      [dateStr, timeStr, next.location].filter(Boolean).join(' · ');
    banner.classList.remove('hidden');
  }

  function renderSchedule() {
    const list = document.getElementById('schedule-list');
    const notice = document.getElementById('firebase-notice');

    // Show Firebase notice if not connected
    if (!fbReady) {
      notice.classList.remove('hidden');
    } else {
      notice.classList.add('hidden');
    }

    const sorted = [...schedule].sort((a, b) =>
      new Date(a.date + 'T' + (a.time || '00:00')) - new Date(b.date + 'T' + (b.time || '00:00'))
    );

    if (sorted.length === 0) {
      list.innerHTML = '<p class="empty">No games scheduled</p>';
      return;
    }

    const now = Date.now();
    list.innerHTML = '';
    sorted.forEach(g => {
      const dt = new Date(g.date + 'T' + (g.time || '12:00'));
      const isPast = dt.getTime() < now;
      const dateStr = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      const timeStr = g.time ? dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

      const div = document.createElement('div');
      div.className = 'schedule-item' + (isPast ? ' past' : '');
      div.innerHTML =
        `<div class="schedule-date-badge">${dateStr}</div>` +
        `<div class="schedule-matchup">${esc(g.away)} <span style="color:var(--text-muted)">vs</span> ${esc(g.home)}</div>` +
        `<div class="schedule-details">` +
          (timeStr   ? `<span class="schedule-detail">&#128336; ${timeStr}</span>` : '') +
          (g.location ? `<span class="schedule-detail">&#128205; ${esc(g.location)}</span>` : '') +
          (g.notes    ? `<span class="schedule-detail">&#128221; ${esc(g.notes)}</span>` : '') +
        `</div>` +
        `<div class="schedule-actions">` +
          `<button class="btn btn-xs btn-ghost" data-action="edit-game" data-id="${g.id}">Edit</button>` +
          `<button class="btn btn-xs btn-danger" data-action="del-game" data-id="${g.id}">Delete</button>` +
        `</div>`;
      list.appendChild(div);
    });
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

  function renderLeaderboard() {
    const players = Object.values(state.players);

    const categories = [
      { id: 'lb-avg',  label: 'AVG', key: s => parseFloat(s.AVG.replace(/^\./, '0.')), fmt: s => s.AVG, minAB: 1 },
      { id: 'lb-hr',   label: 'HR',  key: s => s.HR,  fmt: s => s.HR,  minAB: 0 },
      { id: 'lb-rbi',  label: 'RBI', key: s => s.RBI, fmt: s => s.RBI, minAB: 0 },
      { id: 'lb-hits', label: 'H',   key: s => s.H,   fmt: s => s.H,   minAB: 0 },
      { id: 'lb-obp',  label: 'OBP', key: s => parseFloat(s.OBP.replace(/^\./, '0.')), fmt: s => s.OBP, minAB: 1 },
      { id: 'lb-slg',  label: 'SLG', key: s => parseFloat(s.SLG.replace(/^\./, '0.')), fmt: s => s.SLG, minAB: 1 },
    ];

    const rankClasses = ['gold', 'silver', 'bronze'];
    const rankSymbols = ['1', '2', '3', '4', '5'];

    categories.forEach(cat => {
      const el = document.getElementById(cat.id);
      const ranked = players
        .map(p => ({ p, s: playerStats(p.id) }))
        .filter(({ s }) => s.AB >= cat.minAB || cat.minAB === 0)
        .filter(({ s }) => cat.key(s) > 0)
        .sort((a, b) => cat.key(b.s) - cat.key(a.s))
        .slice(0, 5);

      if (ranked.length === 0) {
        el.innerHTML = '<li class="lb-empty">No data yet</li>';
        return;
      }
      el.innerHTML = '';
      ranked.forEach(({ p, s }, i) => {
        const li = document.createElement('li');
        li.className = 'lb-item';
        li.innerHTML =
          `<span class="lb-rank ${rankClasses[i] || ''}">${rankSymbols[i]}</span>` +
          `<span class="lb-name">${esc(p.name)}</span>` +
          `<span class="lb-val">${cat.fmt(s)}</span>`;
        el.appendChild(li);
      });
    });
  }

  function renderGear() {
    function gearLink(icon, name, desc, url) {
      return `<a class="gear-item" href="${url}" target="_blank" rel="noopener noreferrer">` +
        `<div class="gear-icon">${icon}</div>` +
        `<div class="gear-info"><div class="gear-name">${name}</div><div class="gear-desc">${desc}</div></div>` +
        `<div class="gear-arrow">&#8250;</div>` +
        `</a>`;
    }

    document.getElementById('gear-bats').innerHTML = [
      gearLink('&#9733;', 'Official Wiffle Ball Site', 'Bats, balls, and sets direct from the source', 'https://www.wiffle.com'),
      gearLink('&#128230;', 'Amazon — Wiffle Ball Bats', 'Wide selection, fast shipping, Prime eligible', amazonUrl('wiffle ball bat')),
      gearLink('&#127919;', 'Target — Wiffle Ball Bats', 'In-store pickup or delivery available', targetUrl('wiffle ball bat')),
      gearLink('&#128717;', 'Walmart — Wiffle Ball Bats', 'Budget-friendly options, store pickup available', walmartUrl('wiffle ball bat')),
      gearLink('&#127944;', "Dick's Sporting Goods", 'Sports-focused selection, in-store and online', dicksUrl('wiffle ball')),
    ].join('');

    document.getElementById('gear-sets').innerHTML = [
      gearLink('&#128230;', 'Amazon — Wiffle Ball Sets', 'Complete bat and ball combo sets', amazonUrl('wiffle ball set')),
      gearLink('&#128230;', 'Amazon — Bulk Wiffle Balls', 'Stock up — bulk packs for leagues', amazonUrl('wiffle balls bulk')),
      gearLink('&#127919;', 'Target — Wiffle Ball Sets', 'Sets with bases and everything you need', targetUrl('wiffle ball set')),
    ].join('');
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
      if (btn.dataset.tab === 'stats')       renderStats();
      if (btn.dataset.tab === 'lineup')      renderLineup();
      if (btn.dataset.tab === 'history')     renderHistory();
      if (btn.dataset.tab === 'leaderboard') renderLeaderboard();
      if (btn.dataset.tab === 'schedule')    renderSchedule();
      if (btn.dataset.tab === 'gear')        renderGear();
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

  // ─── SCHEDULE EVENTS ─────────────────────────────────────────────────────────

  let editingGameId = null;

  document.getElementById('add-game-btn').addEventListener('click', () => {
    editingGameId = null;
    document.getElementById('schedule-modal-title').textContent = 'Schedule Game';
    document.getElementById('sc-date').value     = '';
    document.getElementById('sc-time').value     = '';
    document.getElementById('sc-home').value     = state.teams.home.name !== 'Home Team' ? state.teams.home.name : '';
    document.getElementById('sc-away').value     = state.teams.away.name !== 'Away Team' ? state.teams.away.name : '';
    document.getElementById('sc-location').value = '';
    document.getElementById('sc-notes').value    = '';
    openModal('schedule-modal');
    setTimeout(() => document.getElementById('sc-date').focus(), 80);
  });

  document.getElementById('sc-cancel').addEventListener('click', () => closeModal('schedule-modal'));

  document.getElementById('sc-save').addEventListener('click', () => {
    const date = document.getElementById('sc-date').value;
    const home = document.getElementById('sc-home').value.trim();
    const away = document.getElementById('sc-away').value.trim();
    if (!date || !home || !away) {
      alert('Please fill in date, home team, and away team.');
      return;
    }

    const game = {
      id:       editingGameId || uid(),
      date,
      time:     document.getElementById('sc-time').value,
      home,
      away,
      location: document.getElementById('sc-location').value.trim(),
      notes:    document.getElementById('sc-notes').value.trim(),
      ts:       Date.now(),
    };

    const idx = schedule.findIndex(g => g.id === game.id);
    if (idx >= 0) schedule[idx] = game;
    else schedule.push(game);

    saveScheduleLocal();
    fbSyncSchedule();
    renderSchedule();
    renderUpcomingBanner();
    closeModal('schedule-modal');
  });

  document.getElementById('schedule-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;

    if (btn.dataset.action === 'del-game') {
      if (!confirm('Delete this scheduled game?')) return;
      schedule = schedule.filter(g => g.id !== id);
      saveScheduleLocal();
      fbSyncSchedule();
      renderSchedule();
      renderUpcomingBanner();
    }

    if (btn.dataset.action === 'edit-game') {
      const g = schedule.find(x => x.id === id);
      if (!g) return;
      editingGameId = id;
      document.getElementById('schedule-modal-title').textContent = 'Edit Game';
      document.getElementById('sc-date').value     = g.date;
      document.getElementById('sc-time').value     = g.time || '';
      document.getElementById('sc-home').value     = g.home;
      document.getElementById('sc-away').value     = g.away;
      document.getElementById('sc-location').value = g.location || '';
      document.getElementById('sc-notes').value    = g.notes    || '';
      openModal('schedule-modal');
    }
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
  renderGear();

  // Register service worker for PWA / offline support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }

})();
