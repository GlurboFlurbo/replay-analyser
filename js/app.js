/*
 * UI glue: file selection -> background worker -> tables/charts.
 *
 * The worker returns EVERY freeze run of every player. Which of them is a "fail" is decided
 * here, from the threshold input, so changing it re-renders instantly with no re-parsing.
 */
(function () {
  'use strict';

  const TICKS_PER_SECOND = 50;
  const $ = (id) => document.getElementById(id);

  const state = {
    result: null,       // data from the worker
    thresholdTicks: 50, // 1 s
    saveThresholdTicks: 100, // the saved must live 2 s without failing again for the save to count
    includeDeep: true,
    team: null,         // active team tab; null = nothing listed yet (or no team players)
    team0: false,       // include players never in a team (team 0) as an extra list (always offered, next to the team tabs)
    savior: null,       // active "Who saved whom" tab
    sortKey: 'fails',
    sortDesc: true,
    unfSortKey: 'total',
    unfSortDesc: true,
    selected: null,     // player name (fails detail)
    aliveSelected: null, // player name (time alive detail)
    detailed: false,    // detail chart at 1% sections instead of 3%
    aliveDetailed: false, // time alive chart at 1% sections instead of 3%
    heat: { mode: 'freeze', player: null, chunk: 6 }, // heatmap layer, isolated player, area size (tiles)
    file: null,         // the analysed File, kept so the replay player can read it again
  };

  // ---------- replay player -------------------------------------------------------------
  //
  // The player is the real DDNet client. It runs either in a same-origin iframe over this
  // page or in its own tab (the "New tab" button); either way it is created lazily (the
  // ~51 MB client must not load until asked for), kept alive between demos so neither
  // reopening nor analysing another demo pays for the download or the boot again. Only
  // one of the two is alive at a time, because two running clients would double the
  // memory for no benefit.

  // Absolute, because a freshly opened tab starts on about:blank, where a
  // relative URL has nothing to resolve against.
  const REPLAY_URL = new URL('client/replay.html?v=20261029h', location.href).href;
  const REPLAY_TAB = 'ddnet-demo-replay';

  const replay = {
    frame: null,       // in-page player iframe, once created
    frameReady: false, // that player has said hello and can take a demo
    tab: null,         // player tab, when it was popped out
    tabReady: false,   // that player has said hello and can take a demo
    mode: 'frame',     // where the next ▶ opens the player ('frame' or 'tab')
    frameDemo: null,   // demo the in-page client currently has loaded
    tabDemo: null,     // demo the popped-out client currently has loaded
    pendingSeek: null, // tick to jump to as soon as the demo is loaded
    token: 0,          // guards against stale arrayBuffer() promises after a reset
    sending: false,    // a demo is being read and posted right now
  };

  // ---------- small helpers -------------------------------------------------------------

  /** Formats seconds as m:ss or h:mm:ss. */
  function clock(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), rr = String(r).padStart(2, '0');
    return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
  }
  const secs = (ticks) => ticks / TICKS_PER_SECOND;
  const fmtSec = (ticks) => secs(ticks).toFixed(1) + ' s';

  /**
   * Middle value of a list (mean of the two middle values for an even count).
   * Used instead of the average for durations: one long outlier (a very long
   * fail, or a long wait on a platform) must not distort the typical value.
   */
  function median(values) {
    if (!values.length) return 0;
    const v = values.slice().sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  /** Creates an element; text goes in via textContent, so player names can never inject HTML. */
  function el(tag, opts = {}, ...children) {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = opts.text;
    for (const c of children) node.append(c);
    return node;
  }

  // ---------- statistics ----------------------------------------------------------------

  /**
   * A freeze run counts as a fail under the current threshold/deep settings.
   * Runs marked as a "continuation" (r[4]) are the same freeze the player entered
   * before spectating - they come back still frozen, so they are not a new fail.
   */
  const isFailRun = (r) => r[1] > state.thresholdTicks && (state.includeDeep || !r[2]) && !r[4];

  /** Freeze runs per player, sorted by start — the save-survival gate reads this. */
  function freezeRunsByPlayer() {
    const m = new Map();
    for (const p of state.result.players) m.set(p.name, p.runs.slice().sort((a, b) => a[0] - b[0]));
    return m;
  }

  /** Tick of the player's next counted fail after `after`, or Infinity if never. */
  function nextFailAfter(runsByPlayer, victim, after) {
    const runs = runsByPlayer.get(victim) || [];
    let lo = 0, hi = runs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (runs[mid][0] <= after) lo = mid + 1; else hi = mid;
    }
    while (lo < runs.length && !isFailRun(runs[lo])) lo++;
    return lo < runs.length ? runs[lo][0] : Infinity;
  }

  /**
   * The saves that count under the current settings: only on freezes that are also
   * fails, only one per freeze run (the earliest event on that run wins), and only
   * when the saved player then lives at least saveThresholdTicks without failing
   * again (no later fail = still alive at the end of the recording, which counts).
   * The collector deliberately emits every candidate; the filtering lives here so the
   * threshold sliders stay instant.
   *
   * Memoised: computeStats() asks once per player and several renderers ask too, so
   * one pass is shared until a setting (or the result itself) changes.
   */
  let savesCache = null;

  function activeSaves() {
    const r = state.result;
    const key = [r, state.thresholdTicks, state.includeDeep, state.saveThresholdTicks];
    if (savesCache && savesCache.key.every((v, i) => v === key[i])) return savesCache.value;

    const runsByPlayer = freezeRunsByPlayer();

    const best = new Map();
    for (const s of r.saves) {
      if (s.end - s.start <= state.thresholdTicks) continue;
      if (!state.includeDeep && s.deep) continue;
      if (nextFailAfter(runsByPlayer, s.victim, s.end) - s.end < state.saveThresholdTicks) continue;
      const runKey = s.victim + '|' + s.start;
      const cur = best.get(runKey);
      if (!cur || s.tick < cur.tick) best.set(runKey, s);
    }
    const value = [...best.values()];
    savesCache = { key, value };
    return value;
  }

  /**
   * Time alive: from the first to the last moment the player was seen, minus
   * every freeze they went through - any length, deep or not, so the fail/save
   * sliders do not apply. The stretches between freezes give the longest/median.
   */
  function unfrozenStats() {
    const scope = new Set(activeGroup().players.map((p) => p.name));
    const runsOf = new Map(state.result.players.map((p) => [p.name, p.runs]));
    const rows = [];
    for (const q of state.result.presence) {
      if (!scope.has(q.name)) continue;
      const runs = (runsOf.get(q.name) || []).slice().sort((a, b) => a[0] - b[0]);
      // Bridged holes (r[3]) are not frozen time - only the observed freeze counts.
      const frozen = runs.reduce((sum, r) => sum + (r[1] - r[3]), 0);
      let longest = 0, prevEnd = q.first;
      const gaps = []; // every stretch not in freeze, for the median
      for (const r of runs) {
        const gap = Math.max(0, r[0] - prevEnd);
        gaps.push(gap);
        if (gap > longest) longest = gap;
        prevEnd = r[0] + r[1];
      }
      const tail = Math.max(0, q.last - prevEnd);
      gaps.push(tail);
      if (tail > longest) longest = tail;
      const total = Math.max(0, q.last - q.first - frozen);
      rows.push({ name: q.name, longest, total, median: median(gaps) });
    }
    return rows;
  }

  /**
   * [start, end) stretches where each active-group player was the only one not
   * in freeze: an event sweep over presence windows and freeze runs (any depth,
   * so the sliders do not apply). Needs at least two members seen, so a lone
   * player never counts. Every stretch counts separately - there is no cooldown,
   * so a quick re-entry after the others thaw does produce another "last".
   */
  function lastIntervals() {
    const names = new Set(activeGroup().players.map((p) => p.name));
    const runsOf = new Map(state.result.players.map((p) => [p.name, p.runs.slice().sort((a, b) => a[0] - b[0])]));
    const events = new Map(); // tick -> list of [name, kind]; the state only changes here
    const add = (tick, name, kind) => {
      if (!events.has(tick)) events.set(tick, []);
      events.get(tick).push([name, kind]);
    };
    for (const q of state.result.presence) {
      if (!names.has(q.name)) continue;
      add(q.first, q.name, 'seen+');
      add(q.last + 1, q.name, 'seen-');
      // The stretches where he was seen and not in freeze.
      let prevEnd = q.first;
      for (const r of (runsOf.get(q.name) || [])) {
        const end = Math.min(r[0] + r[1], q.last + 1);
        if (r[0] > prevEnd) { add(prevEnd, q.name, 'free+'); add(r[0], q.name, 'free-'); }
        if (end > prevEnd) prevEnd = end;
      }
      if (q.last + 1 > prevEnd) { add(prevEnd, q.name, 'free+'); add(q.last + 1, q.name, 'free-'); }
    }
    const out = new Map([...names].map((n) => [n, []]));
    const seen = new Set(), free = new Set();
    let prevSole = null, segStart = 0;
    for (const tick of [...events.keys()].sort((a, b) => a - b)) {
      for (const [name, kind] of events.get(tick)) {
        if (kind === 'seen+') seen.add(name);
        else if (kind === 'seen-') seen.delete(name);
        else if (kind === 'free+') free.add(name);
        else free.delete(name);
      }
      const sole = free.size === 1 && seen.size >= 2 ? free.values().next().value : null;
      if (sole !== prevSole) {
        if (prevSole !== null) out.get(prevSole).push([segStart, tick]);
        prevSole = sole;
        segStart = tick;
      }
    }
    if (prevSole !== null) out.get(prevSole).push([segStart, state.result.lastTick + 1]);
    return out;
  }

  /** Times each player of the active group was the only one not in freeze. */
  function lastCounts() {
    const counts = new Map();
    for (const [name, segs] of lastIntervals()) counts.set(name, segs.length);
    return counts;
  }

  /** Turns raw freeze runs into the numbers shown in the table, for the current settings. */
  function computeStats(player, last = new Map()) {
    const fails = player.runs.filter(isFailRun);
    const total = fails.reduce((sum, r) => sum + r[1], 0);
    const longest = fails.reduce((max, r) => Math.max(max, r[1]), 0);
    return {
      name: player.name,
      fails,
      saves: activeSaves().filter((s) => s.savior === player.name).length,
      last: last.get(player.name) || 0,
      longest,
      total,
      median: median(fails.map((r) => r[1])),
    };
  }

  /** Players who were never in a team (recorded as team 0, or not recorded at all). */
  function noTeamPlayers() {
    const r = state.result;
    return r.players.filter((p) => !r.teamPlayers[p.name]);
  }

  /**
   * Players grouped by the team they were in, lowest team number first,
   * from recorded team data alone (no team-0 fallback).
   */
  function realTeamGroups() {
    const r = state.result;
    const byTeam = new Map();
    for (const p of r.players) {
      const team = r.teamPlayers[p.name];
      if (!team) continue;
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team).push(p);
    }
    return [...byTeam].map(([team, players]) => ({ team, players }))
      .sort((a, b) => a.team - b.team);
  }

  /**
   * Like realTeamGroups, plus a leading "Team 0" list of players who were never
   * in one when the "Include team 0" toggle is on.
   */
  function teamGroups() {
    const groups = realTeamGroups();
    if (state.team0) {
      const rest = noTeamPlayers();
      if (rest.length) groups.unshift({ team: 0, players: rest });
    }
    return groups;
  }

  /** The list currently shown: the selected tab, or a sensible default for a fresh result. */
  function activeGroup() {
    const groups = teamGroups();
    if (!groups.length) return { team: null, players: [] };
    const found = groups.find((g) => g.team === state.team);
    if (found) return found;
    // Default: the team with the most players, ties go to the smaller team number.
    let best = groups[0];
    for (const g of groups) {
      if (g.players.length > best.players.length ||
          (g.players.length === best.players.length && g.team < best.team)) best = g;
    }
    state.team = best.team;
    return best;
  }

  function allStats() {
    const last = lastCounts();
    return activeGroup().players.map((p) => computeStats(p, last));
  }

  /** Who saved whom: one entry per savior/victim pair, most saves first. */
  function savePairs() {
    const counts = new Map();
    for (const s of activeSaves()) {
      const key = s.savior + '\u0000' + s.victim;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([key, count]) => {
        const i = key.indexOf('\u0000');
        return { savior: key.slice(0, i), victim: key.slice(i + 1), count };
      })
      .sort((a, b) => b.count - a.count || a.savior.localeCompare(b.savior) || a.victim.localeCompare(b.victim));
  }

  /** Pairs grouped by savior: tabs alphabetically, each list by number of saves. */
  function saveBySavior() {
    const bySavior = new Map();
    for (const p of savePairs()) {
      if (!bySavior.has(p.savior)) bySavior.set(p.savior, []);
      bySavior.get(p.savior).push({ victim: p.victim, count: p.count });
    }
    return [...bySavior.entries()]
      .map(([savior, rows]) => ({
        savior,
        rows: rows.sort((a, b) => b.count - a.count || a.victim.localeCompare(b.victim)),
      }))
      .sort((a, b) => a.savior.localeCompare(b.savior));
  }

  // ---------- rendering -----------------------------------------------------------------

  function renderSummary() {
    const r = state.result, h = r.header;
    const cards = [
      ['Map', h.mapName],
      ['Recorded', h.timestamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')],
      ['Analysed length', clock(secs(r.lastTick - r.firstTick))],
      ['Players', String(teamGroups().reduce((n, g) => n + g.players.length, 0))],
      ['Saves', String(activeSaves().length)],
    ];
    const box = $('summary');
    box.replaceChildren(...cards.map(([label, value]) =>
      el('div', { class: 'card' }, el('span', { class: 'label', text: label }), el('span', { class: 'value', text: value }))));
    if (r.skipped > 0) {
      box.append(el('div', { class: 'card' },
        el('span', { class: 'label', text: 'Skipped snapshots' }), el('span', { class: 'value', text: String(r.skipped) })));
    }
  }

  /** One tab button per team; the "Include team 0" toggle is always offered. */
  function renderTabs() {
    const r = state.result;
    const groups = teamGroups();
    const box = $('team-tabs'), heading = $('stats-heading');
    const wrap = $('stats-wrap'), hint = $('stats-hint'), bar = $('team0-bar');
    const toggle = $('team0-toggle');
    toggle.setAttribute('aria-pressed', String(state.team0));
    // Greyed out only when there is nobody outside a team to add to the tabs.
    toggle.disabled = noTeamPlayers().length === 0;
    bar.hidden = false;
    if (!groups.length) {
      state.team = null;
      box.hidden = true;
      box.replaceChildren();
      wrap.hidden = true;
      hint.hidden = true;
      heading.hidden = false;
      heading.textContent = r.teamsRecorded
        ? 'No players were in a team.'
        : 'No team information recorded in this demo.';
      return;
    }
    activeGroup(); // makes sure state.team points at a list that exists
    heading.hidden = true;
    wrap.hidden = false;
    hint.hidden = false;
    box.hidden = false;
    box.replaceChildren(...groups.map((g) => {
      const btn = el('button', { class: 'tab', text: 'Team ' + g.team });
      btn.type = 'button';
      btn.setAttribute('aria-selected', String(g.team === state.team));
      btn.addEventListener('click', () => { state.team = g.team; renderTabs(); renderTable(); renderUnfrozen(); renderHeat(); });
      return btn;
    }));
  }

  function renderTable() {
    const rows = allStats();
    const dir = state.sortDesc ? -1 : 1;
    rows.sort((a, b) => {
      const va = state.sortKey === 'fails' ? a.fails.length : a[state.sortKey];
      const vb = state.sortKey === 'fails' ? b.fails.length : b[state.sortKey];
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb) || a.name.localeCompare(b.name);
    });

    const maxFails = Math.max(1, ...rows.map((s) => s.fails.length));
    const body = $('stats-body');
    body.replaceChildren(...rows.map((s) => {
      const fill = el('div', { class: 'fill' });
      fill.style.width = (100 * s.fails.length) / maxFails + '%';
      const failsCell = el('td', { class: 'num fails-cell' }, fill, el('span', { text: String(s.fails.length) }));
      const tr = el('tr', s.name === state.selected ? { class: 'selected' } : {},
        el('td', { text: s.name }),
        failsCell,
        el('td', { class: 'num', text: String(s.saves) }),
        el('td', { class: 'num', text: String(s.last) }),
        el('td', { class: 'num', text: s.fails.length ? fmtSec(s.longest) : '–' }),
        el('td', { class: 'num', text: s.fails.length ? fmtSec(s.median) : '–' }),
        el('td', { class: 'num', text: s.fails.length ? clock(secs(s.total)) : '–' }));
      tr.addEventListener('click', () => {
        state.selected = state.selected === s.name ? null : s.name;
        renderTable();
        renderDetail();
      });
      return tr;
    }));

    document.querySelectorAll('#stats-table th').forEach((th) => {
      const active = th.dataset.sort === state.sortKey;
      th.classList.toggle('sorted', active);
      th.classList.toggle('asc', active && !state.sortDesc);
    });
  }

  /** Time alive: same shape as the fails table, but stretches without freeze instead. */
  function renderUnfrozen() {
    const dir = state.unfSortDesc ? -1 : 1;
    const rows = unfrozenStats();
    rows.sort((a, b) => {
      const va = a[state.unfSortKey], vb = b[state.unfSortKey];
      if (typeof va === 'string') return dir * va.localeCompare(vb);
      return dir * (va - vb) || a.name.localeCompare(b.name);
    });

    $('unfrozen').hidden = rows.length === 0;
    $('unfrozen-body').replaceChildren(...rows.map((s) => {
      const tr = el('tr', s.name === state.aliveSelected ? { class: 'selected' } : {},
        el('td', { text: s.name }),
        el('td', { class: 'num', text: fmtSec(s.longest) }),
        el('td', { class: 'num', text: fmtSec(s.median) }),
        el('td', { class: 'num', text: clock(secs(s.total)) }));
      tr.addEventListener('click', () => {
        state.aliveSelected = state.aliveSelected === s.name ? null : s.name;
        renderUnfrozen();
        renderAliveDetail();
      });
      return tr;
    }));
    document.querySelectorAll('#unfrozen-table th').forEach((th) => {
      const active = th.dataset.sort === state.unfSortKey;
      th.classList.toggle('sorted', active);
      th.classList.toggle('asc', active && !state.unfSortDesc);
    });
  }

  /** One tab per savior; below it, the players they saved, most saved first. */
  function renderSaves() {
    const leaders = saveBySavior();
    let active = leaders.find((l) => l.savior === state.savior);
    if (!active && leaders.length) active = leaders[0];
    state.savior = active ? active.savior : null;

    const box = $('saves-tabs');
    box.hidden = !leaders.length;
    box.replaceChildren(...leaders.map((l) => {
      const btn = el('button', { class: 'tab', text: l.savior });
      btn.type = 'button';
      btn.setAttribute('aria-selected', String(l.savior === state.savior));
      btn.addEventListener('click', () => { state.savior = l.savior; renderSaves(); });
      return btn;
    }));

    const body = $('saves-body');
    body.replaceChildren(...(active ? active.rows : []).map((p) => el('tr', {},
      el('td', { text: p.victim }),
      el('td', { class: 'num', text: String(p.count) }))));
  }

  // ---------- detail chart pieces (fail density, last moments, time alive) --
  const NS = 'http://www.w3.org/2000/svg';
  const H = 120, PAD = 12;
  // Alive palette: pale mint for mostly-frozen sections, deep teal for fully alive.
  const ALIVE_PALETTE = ['#E9F7F3', '#BEEAE0', '#8AD9C8', '#4CBFA9', '#2E9E8B', '#1F6E62'];

  /** Vertical grid lines for the detail charts. */
  function chartGrid(target) {
    for (let i = 1; i < 10; i++) {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'tick');
      line.setAttribute('x1', i * 100); line.setAttribute('x2', i * 100);
      line.setAttribute('y1', 0); line.setAttribute('y2', H);
      target.append(line);
    }
  }
  /** A bar with rounded top corners, clamped so tiny bars stay valid. */
  function barPath(x, y, w, h) {
    const r = Math.min(5, h / 2, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  /** "5% – 6% (0:12 – 0:15)" - the position label shared by the chart tooltips. */
  function binLabel(i, bins, binDur) {
    const lo = parseFloat((i * 100 / bins).toFixed(1));
    const hi = parseFloat(((i + 1) * 100 / bins).toFixed(1));
    return `${lo}% – ${hi}% (${clock(secs(i * binDur))} – ${clock(secs((i + 1) * binDur))})`;
  }

  function renderDetail() {
    const section = $('detail');
    const player = state.result.players.find((p) => p.name === state.selected);
    if (!player) { section.hidden = true; return; }
    section.hidden = false;

    const s = computeStats(player);
    $('detail-title').textContent = `${s.name} – ${s.fails.length} fails, ${s.saves} saves`;

    // Fail density per percentile of the run: 3% sections normally, or 1% when
    // "View detailed" is on for a closer look.
    const first = state.result.firstTick;
    const span = Math.max(1, state.result.lastTick - first);

    /** Fail runs of `pl` after the current threshold/deep filters. */
    const filteredRuns = (pl) => pl.runs.filter(isFailRun);

    /** Fail count of `pl` in each of `bins` equal sections of the demo. */
    const binFails = (pl, bins) => {
      const tally = new Array(bins).fill(0);
      for (const run of filteredRuns(pl)) {
        const bin = Math.max(0, Math.min(bins - 1, Math.floor(((run[0] - first) / span) * bins)));
        tally[bin]++;
      }
      return tally;
    };
    // Heat palette: pale cream for quiet slots, dark red for the record spike.
    const PALETTE = ['#FAEEDA', '#FAC775', '#EF9F27', '#E87B4A', '#E24B4A', '#A32D2D'];
    const pct = state.detailed ? 1 : 3;
    const bins = Math.round(100 / pct);
    const binW = 1000 / bins;
    const binDur = span / bins;
    const binCounts = binFails(player, bins);
    // Heights and colours compare against the busiest section of this width across
    // all players, so they mean the same thing on every player's chart.
    let globalMax = 1;
    for (const p of state.result.players)
      for (const c of binFails(p, bins)) if (c > globalMax) globalMax = c;

    // Chokepoint: the densest fixed 1% of the demo (independent of the chart
    // resolution), reported when that stretch runs at least twice the player's
    // own average fail rate.
    const starts = filteredRuns(player).map((run) => run[0]).sort((a, b) => a - b);
    const winTicks = 0.01 * span;
    let peakCount = 0, peakAt = 0;
    for (let L = 0, R = 0; L < starts.length; L++) {
      while (R < starts.length && starts[R] - starts[L] < winTicks) R++;
      if (R - L > peakCount) { peakCount = R - L; peakAt = L; }
    }
    const peakRatio = starts.length ? (peakCount / starts.length) * 100 : 0;
    const avgPerMin = starts.length / (secs(span) / 60);

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 1000 ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    chartGrid(svg);
    for (let i = 0; i < bins; i++) {
      if (!binCounts[i]) continue;
      const t = binCounts[i] / globalMax;
      const h = Math.max(2, Math.min(H - PAD, t * (H - PAD)));
      const x = i * binW + 1.5, w = binW - 3, y = H - h;
      const bar = document.createElementNS(NS, 'path');
      bar.setAttribute('class', 'fail');
      bar.setAttribute('fill', PALETTE[Math.min(PALETTE.length - 1, Math.floor(t * PALETTE.length))]);
      bar.setAttribute('d', barPath(x, y, w, h));
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${binLabel(i, bins, binDur)}: ${binCounts[i]} fails`;
      bar.append(title);
      svg.append(bar);
    }

    const axis = el('div', { class: 'axis' }, el('span', { text: '0:00' }), el('span', { text: clock(secs(span)) }));
    const notes = [];
    notes.push(el('p', { class: 'notice', text: `Fail rate: ${avgPerMin.toFixed(1)} per minute` }));
    if (peakCount && peakRatio >= 2) {
      const winEnd = Math.min(starts[peakAt] + winTicks, first + span); // never past the demo end
      notes.push(el('p', { class: 'notice', text:
        `Most fails around ${clock(secs(starts[peakAt] - first))} – ${clock(secs(winEnd - first))} ` +
        `(${peakRatio.toFixed(1)}× average rate)` }));
    }
    $('timeline').replaceChildren(svg, axis, ...notes);

    // Every moment he was the only one not in freeze: a marker on a timeline
    // lane, labelled with how long that stretch lasted (short ones are in the
    // tooltip only, so the labels do not collide).
    const segs = lastIntervals().get(player.name) || [];
    const lsvg = document.createElementNS(NS, 'svg');
    lsvg.setAttribute('viewBox', `0 0 1000 ${H}`);
    lsvg.setAttribute('preserveAspectRatio', 'none');
    const lane = document.createElementNS(NS, 'line');
    lane.setAttribute('class', 'lane');
    lane.setAttribute('x1', 0); lane.setAttribute('x2', 1000);
    lane.setAttribute('y1', H / 2); lane.setAttribute('y2', H / 2);
    lsvg.append(lane);
    const labels = [];
    let lastLabelX = -Infinity;
    for (const [s0, e0] of segs) {
      const pos = Math.min(998, Math.max(2, ((s0 - first) / span) * 1000));
      const mark = document.createElementNS(NS, 'rect');
      mark.setAttribute('class', 'last');
      mark.setAttribute('x', pos - 1.5);
      mark.setAttribute('y', H / 2 - 15);
      mark.setAttribute('width', 3);
      mark.setAttribute('height', 30);
      mark.setAttribute('rx', 1.5);
      mark.setAttribute('fill', ALIVE_PALETTE[3]);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${clock(secs(s0 - first))} – ${clock(secs(e0 - first))}: ${clock(secs(e0 - s0))} last`;
      mark.append(title);
      lsvg.append(mark);
      // Long runs can have hundreds of short stretches a few pixels apart; only
      // label the ones with room, so the text stays readable (the tooltip always
      // has the exact times).
      if (pos - lastLabelX < 40) continue;
      const len = secs(e0 - s0);
      const label = el('span', { class: 'last-label', text: len < 10 ? `${len.toFixed(1)}s` : `${Math.round(len)}s` });
      label.style.left = pos / 10 + '%';
      labels.push(label);
      lastLabelX = pos;
    }
    $('last-timeline').replaceChildren(lsvg, ...labels,
      el('div', { class: 'axis' }, el('span', { text: '0:00' }), el('span', { text: clock(secs(span)) })));

    // Full list, in chronological order.
    const sorted = s.fails.slice().sort((a, b) => a[0] - b[0]);
    $('fail-body').replaceChildren(...sorted.map((r, i) => {
      const seek = Math.max(state.result.firstTick, r[0] - 100); // two seconds of run-up
      const watch = el('button', {
        class: 'replay-btn', type: 'button', text: '▶',
        title: 'Watch this fail in the full client',
      });
      watch.setAttribute('aria-label', 'Watch this fail in the full client');
      watch.addEventListener('click', () => openReplay(seek));
      return el('tr', {},
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', { text: clock(secs(r[0] - first)) }),
        el('td', { class: 'num', text: fmtSec(r[1]) }),
        el('td', { class: 'replay-cell' }, watch));
    }));
  }

  /** The Time alive detail view: how much of each section the player spent alive. */
  function renderAliveDetail() {
    const section = $('alive-detail');
    const pres = state.result.presence.find((q) => q.name === state.aliveSelected);
    if (!pres) { section.hidden = true; return; }
    section.hidden = false;

    const player = state.result.players.find((p) => p.name === state.aliveSelected);
    const runs = player ? player.runs : [];
    const first = state.result.firstTick;
    const span = Math.max(1, state.result.lastTick - first);
    const total = Math.max(0, pres.last - pres.first - runs.reduce((sum, r) => sum + (r[1] - r[3]), 0));
    $('alive-detail-title').textContent = `${state.aliveSelected} – ${clock(secs(total))} alive`;

    // Alive time per percentile: 3% sections normally, or 1% when "View detailed"
    // is on. Bar height = share of the section seen and not frozen.
    const pct = state.aliveDetailed ? 1 : 3;
    const bins = Math.round(100 / pct);
    const binW = 1000 / bins;
    const binDur = span / bins;
    const tally = new Array(bins).fill(0);
    for (let i = 0; i < bins; i++) {
      const t0 = first + i * binDur, t1 = t0 + binDur;
      const seen = Math.min(pres.last, t1) - Math.max(pres.first, t0);
      let frozen = 0;
      for (const run of runs) {
        const ov = Math.min(run[0] + run[1], t1) - Math.max(run[0], t0);
        // Prorate the run's bridged gap over its length (its exact ticks are unknown here).
        if (ov > 0) frozen += ov * (run[1] - run[3]) / run[1];
      }
      tally[i] = Math.max(0, seen - frozen);
    }

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 1000 ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    chartGrid(svg);
    for (let i = 0; i < bins; i++) {
      if (!tally[i]) continue;
      const t = Math.min(1, tally[i] / binDur);
      const h = Math.max(2, t * (H - PAD));
      const x = i * binW + 1.5, w = binW - 3, y = H - h;
      const bar = document.createElementNS(NS, 'path');
      bar.setAttribute('class', 'alive');
      bar.setAttribute('fill', ALIVE_PALETTE[Math.min(ALIVE_PALETTE.length - 1, Math.floor(t * ALIVE_PALETTE.length))]);
      bar.setAttribute('d', barPath(x, y, w, h));
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${binLabel(i, bins, binDur)}: ${secs(tally[i]).toFixed(1)} s alive`;
      bar.append(title);
      svg.append(bar);
    }
    $('alive-timeline').replaceChildren(svg,
      el('div', { class: 'axis' }, el('span', { text: '0:00' }), el('span', { text: clock(secs(span)) })));
  }

  // ---------- heatmap -------------------------------------------------------------------
  //
  // Every character position in the demo is counted onto a map tile, 10 times per
  // second. Nobody stands on a single tile for long, so the heat is summed into
  // square areas of N x N tiles (6 x 6 by default) - "we got stuck in this room",
  // not "this one 32-pixel tile". The area size is switchable.
  //
  // Two layers come out of that: time spent in the area, and how much of that time
  // was spent frozen. The second one is the chokepoint view. The map itself is the
  // one embedded in the demo (see js/map-reader.js), so this needs no network.

  const HEAT_BG = {
    1: [52, 58, 72],    // solid
    2: [62, 70, 78],    // no hook
    3: [96, 42, 46],    // death
    9: [30, 76, 94],    // freeze
    11: [58, 52, 112],  // deep freeze
  };
  const HEAT_BG_DEFAULT = [19, 23, 30];
  // Yellow -> orange -> red, with the alpha growing too, so quiet spots stay quiet.
  const HEAT_RAMP = Array.from({ length: 64 }, (_, i) => {
    const q = i / 63;
    return [255, Math.round(235 - 200 * q), Math.round(60 - 60 * q), 0.55 + 0.45 * q];
  });

  const heatView = {
    data: null,       // last aggregate, kept so zoom/pan can redraw without recomputing
    canvas: null,     // offscreen, 1 pixel per tile
    ctx: null,        // 2d context of that offscreen canvas
    image: null,
    width: 0,         // CSS width the canvas was last sized for
    scale: 0, ox: 0, oy: 0, fit: 1,
    fitted: false,    // scale/ox/oy still need to be set for the current canvas size
    hover: null,      // chokepoint under the pointer
    pin: null,        // chokepoint clicked last
  };

  /** "38 s", "9:04" - heatmap durations. */
  function heatDur(ticks) {
    const s = secs(ticks);
    if (s >= 60) return clock(s);
    return (s < 10 ? s.toFixed(1) : String(Math.round(s))) + ' s';
  }

  /** Names of the active team that have position data. */
  function heatMembers() {
    const d = state.result && state.result.heat;
    if (!d) return [];
    const have = new Set(d.players.map((p) => p.name));
    const team = activeGroup().players.map((p) => p.name).filter((n) => have.has(n));
    // A lot of client demos carry no team info (teamsRecorded is false), yet they
    // clearly show a team run. Hiding the whole heatmap then loses the best part of
    // the analysis, so fall back to everyone whose position was recorded.
    return team.length ? team : d.players.map((p) => p.name);
  }

  /**
   * Sums the selected players' tiles into N x N areas, plus totals per player.
   * Called on every mode/selection/size change; costs little because only visited
   * tiles are stored (a few thousand).
   */
  function heatMapData() {
    const d = state.result.heat;
    const members = heatMembers();
    const isolated = state.heat.player && members.includes(state.heat.player) ? state.heat.player : null;
    const W = d.width, H = d.height;
    const chunk = state.heat.chunk;
    const cols = Math.ceil(W / chunk), rows = Math.ceil(H / chunk);
    const weights = new Float32Array(cols * rows);
    const totals = new Map(members.map((n) => [n, 0]));
    const areas = new Map();
    const cellsByName = new Map(d.players.map((p) => [p.name, p.cells]));
    const frozen = state.heat.mode === 'freeze';

    for (const name of members) {
      const cells = cellsByName.get(name);
      if (!cells) continue;
      const on = !isolated || name === isolated;
      for (let i = 0; i < cells.length; i += 3) {
        const ticks = frozen ? cells[i + 2] : cells[i + 1];
        if (!ticks) continue;
        totals.set(name, totals.get(name) + ticks);
        if (!on) continue;
        const tx = cells[i] % W, ty = Math.floor(cells[i] / W);
        const cx = Math.floor(tx / chunk), cy = Math.floor(ty / chunk);
        const key = cy * cols + cx;
        weights[key] += ticks;
        let a = areas.get(key);
        if (!a) {
          const bx = cx * chunk, by = cy * chunk;
          a = { key, bx, by, w: Math.min(chunk, W - bx), h: Math.min(chunk, H - by), total: 0, who: new Map() };
          areas.set(key, a);
        }
        a.total += ticks;
        a.who.set(name, (a.who.get(name) || 0) + ticks);
      }
    }

    let max = 1;
    for (let i = 0; i < weights.length; i++) if (weights[i] > max) max = weights[i];
    const top = [...areas.values()].sort((a, b) => b.total - a.total).slice(0, 6);
    return { W, H, chunk, cols, rows, weights, max, totals, top, isolated };
  }

  /** Paints background + heat into a 1-pixel-per-tile canvas; each area is one flat colour. */
  function paintHeat(view) {
    if (!heatView.canvas || heatView.canvas.width !== view.W || heatView.canvas.height !== view.H) {
      heatView.canvas = document.createElement('canvas');
      heatView.canvas.width = view.W;
      heatView.canvas.height = view.H;
      heatView.ctx = heatView.canvas.getContext('2d');
      heatView.image = heatView.ctx.createImageData(view.W, view.H);
    }
    const grid = state.result.heat.grid;
    const data = heatView.image.data;
    const { chunk, cols, weights } = view;
    for (let ty = 0; ty < view.H; ty++) {
      const row = Math.floor(ty / chunk) * cols;
      for (let tx = 0; tx < view.W; tx++) {
        const k = ty * view.W + tx;
        const bg = HEAT_BG[grid[k]] || HEAT_BG_DEFAULT;
        let r = bg[0], g = bg[1], b = bg[2];
        const value = weights[row + Math.floor(tx / chunk)];
        if (value) {
          const q = Math.sqrt(value / view.max); // square root: one huge spot must not hide the rest
          const c = HEAT_RAMP[Math.min(HEAT_RAMP.length - 1, Math.floor(q * HEAT_RAMP.length))];
          r += (c[0] - r) * c[3];
          g += (c[1] - g) * c[3];
          b += (c[2] - b) * c[3];
        }
        const o = k * 4;
        data[o] = r;
        data[o + 1] = g;
        data[o + 2] = b;
        data[o + 3] = 255;
      }
    }
    heatView.ctx.putImageData(heatView.image, 0, 0);
  }

  /** Gives the canvas a height that matches the map's aspect ratio. */
  function sizeHeatCanvas(view) {
    const canvas = $('heat-canvas');
    const width = canvas.parentElement.clientWidth;
    if (!width) return false;
    heatView.width = width;
    const natural = Math.round((width * view.H) / view.W);
    // Tall maps (e.g. 150x400 tiles) must not become a two-screen scroll box.
    const maxHeight = Math.max(240, Math.round(window.innerHeight * 0.72));
    const height = Math.max(120, Math.min(natural, maxHeight));
    canvas.style.height = height + 'px';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    return true;
  }

  function drawHeat(view) {
    const canvas = $('heat-canvas');
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch || !heatView.canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    heatView.fit = Math.min(cw / view.W, ch / view.H);
    if (!heatView.fitted) {
      heatView.scale = heatView.fit;
      heatView.ox = (cw - view.W * heatView.fit) / 2;
      heatView.oy = (ch - view.H * heatView.fit) / 2;
      heatView.fitted = true;
    }
    // Never lose the map by panning too far.
    const pad = 24, mw = view.W * heatView.scale, mh = view.H * heatView.scale;
    heatView.ox = mw <= cw ? (cw - mw) / 2 : Math.min(pad, Math.max(cw - mw - pad, heatView.ox));
    heatView.oy = mh <= ch ? (ch - mh) / 2 : Math.min(pad, Math.max(ch - mh - pad, heatView.oy));

    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = heatView.scale < 1; // big maps shrink smoothly, zoomed tiles stay crisp
    ctx.drawImage(heatView.canvas, heatView.ox, heatView.oy, mw, mh);

    const box = heatView.pin || heatView.hover;
    if (box) {
      ctx.strokeStyle = 'rgba(255, 255, 255, .85)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(
        heatView.ox + box.bx * heatView.scale + 0.75,
        heatView.oy + box.by * heatView.scale + 0.75,
        box.w * heatView.scale - 1.5, box.h * heatView.scale - 1.5);
    }
  }

  /** Zooms so that one area fills about a third of the view. */
  function zoomHeatTo(view, box) {
    const canvas = $('heat-canvas');
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return;
    const size = Math.max(box.w, box.h);
    heatView.scale = Math.min(48, Math.max(heatView.fit, Math.min(cw, ch) / (size * 3)));
    heatView.ox = cw / 2 - (box.bx + box.w / 2) * heatView.scale;
    heatView.oy = ch / 2 - (box.by + box.h / 2) * heatView.scale;
    drawHeat(view);
  }

  function heatCursor(view, event) {
    const canvas = $('heat-canvas');
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor((event.clientX - rect.left - heatView.ox) / heatView.scale);
    const ty = Math.floor((event.clientY - rect.top - heatView.oy) / heatView.scale);
    const out = $('heat-cursor');
    if (!heatView.scale || tx < 0 || ty < 0 || tx >= view.W || ty >= view.H) {
      out.textContent = 'Scroll to zoom, drag to move, double-click to reset.';
      return;
    }
    const cx = Math.floor(tx / view.chunk), cy = Math.floor(ty / view.chunk);
    const ticks = view.weights[cy * view.cols + cx];
    const label = state.heat.mode === 'freeze' ? 'frozen' : 'spent';
    out.textContent = `Area ${cx * view.chunk}, ${cy * view.chunk} — ${ticks ? heatDur(ticks) + ' ' + label : 'not visited'}`;
  }

  function renderHeatModes() {
    for (const btn of document.querySelectorAll('#heat-modes .tab')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.heat.mode));
    }
    for (const btn of document.querySelectorAll('#heat-chunks .tab')) {
      btn.setAttribute('aria-pressed', String(Number(btn.dataset.chunk) === state.heat.chunk));
    }
    $('heat-top-unit').textContent = state.heat.mode === 'freeze' ? 'Frozen' : 'Spent';
  }

  /** "Everyone" plus one chip per player, each with their total in the current layer. */
  function renderHeatPlayers(view) {
    const box = $('heat-players');
    const chip = (label, name, ticks) => {
      const btn = el('button', { class: 'tab heat-chip', text: `${label} · ${heatDur(ticks)}` });
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(state.heat.player === name));
      btn.title = name ? `Show only ${name}` : 'Show the whole team';
      btn.addEventListener('click', () => {
        state.heat.player = state.heat.player === name ? null : name;
        heatView.pin = null;
        renderHeat();
      });
      return btn;
    };
    let total = 0;
    for (const ticks of view.totals.values()) total += ticks;
    const chips = [chip('Everyone', null, total)];
    for (const [name, ticks] of [...view.totals].sort((a, b) => b[1] - a[1])) {
      chips.push(chip(name, name, ticks));
    }
    box.replaceChildren(...chips);
  }

  function renderHeatTop(view) {
    const body = $('heat-top-body');
    if (!view.top.length) {
      const td = el('td', { text: 'Nothing recorded for this team.' });
      td.colSpan = 4;
      body.replaceChildren(el('tr', {}, td));
      return;
    }
    const best = view.top[0].total;
    const frac = state.heat.mode === 'freeze' ? 'frozen' : 'spent';
    body.replaceChildren(...view.top.map((b, i) => {
      const fill = el('div', { class: 'fill' });
      fill.style.width = (100 * b.total) / best + '%';
      const people = [...b.who].sort((a, c) => c[1] - a[1]).slice(0, 3)
        .map(([name, ticks]) => `${name} ${heatDur(ticks)}`).join(' · ');
      const tr = el('tr', {},
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', { class: 'heat-spot', text: `${b.bx}, ${b.by}` }),
        el('td', { class: 'num fails-cell heat-cell' }, fill, el('span', { text: heatDur(b.total) })),
        el('td', { class: 'heat-people', text: people }));
      tr.title = `${heatDur(b.total)} ${frac} in tiles ${b.bx}–${b.bx + b.w - 1}, ` +
        `${b.by}–${b.by + b.h - 1} — click to zoom there`;
      tr.addEventListener('mouseenter', () => { heatView.hover = b; drawHeat(view); });
      tr.addEventListener('mouseleave', () => { heatView.hover = null; drawHeat(view); });
      tr.addEventListener('click', () => { heatView.pin = b; zoomHeatTo(view, b); });
      return tr;
    }));
  }

  function renderHeat() {
    const section = $('heatmap');
    const r = state.result;
    if (!r) { section.hidden = true; return; }

    const d = r.heat;
    if (!d) {
      section.hidden = false;
      $('heat-body').hidden = true;
      const note = $('heat-unavailable');
      note.hidden = false;
      note.textContent = r.heatError
        ? `No heatmap for this demo: ${r.heatError}.`
        : 'No heatmap for this demo: it has no embedded map.';
      return;
    }
    const members = heatMembers();
    if (!members.length) { section.hidden = true; return; }

    section.hidden = false;
    $('heat-body').hidden = false;
    $('heat-unavailable').hidden = true;
    if (state.heat.player && !members.includes(state.heat.player)) state.heat.player = null;

    const view = heatMapData();
    heatView.data = view;
    paintHeat(view);
    renderHeatModes();
    renderHeatPlayers(view);
    renderHeatTop(view);

    const layer = state.heat.mode === 'freeze' ? 'frozen' : 'spent';
    $('heat-note').textContent = view.top.length
      ? `Busiest ${view.chunk} × ${view.chunk} area: ${heatDur(view.top[0].total)} ${layer}`
      : `Nothing ${layer} recorded.`;
    $('heat-legend-max').textContent = heatDur(view.max);
    $('heat-cursor').textContent = 'Scroll to zoom, drag to move, double-click to reset.';

    // Directly, not in requestAnimationFrame: unhiding the section above already
    // put it in the layout, and rAF does not run in a background tab.
    sizeHeatCanvas(view);
    drawHeat(view);
  }

  function renderAll() {
    renderSummary();
    renderTabs();
    renderTable();
    renderUnfrozen();
    renderSaves();
    renderDetail();
    renderAliveDetail();
    $('results').hidden = false;
    renderHeat();
  }

  // ---------- file handling -------------------------------------------------------------

  function showError(message) {
    $('progress').hidden = true;
    const box = $('error');
    box.textContent = message;
    box.hidden = false;
  }

  /**
   * Keeps the fun-page data of the last analysed demo for this tab, so the
   * "Fun stats" link can show the same demo without asking for the file again.
   * sessionStorage survives navigation and disappears when the tab is closed;
   * only the small count arrays are stored, never the demo bytes.
   */
  const FUN_CACHE_KEY = 'dda:lastFun';
  function rememberFun(result, name) {
    if (!result.fun) return;
    try {
      sessionStorage.setItem(FUN_CACHE_KEY, JSON.stringify({ name, header: result.header, fun: result.fun }));
    } catch (e) {
      // Private mode or a full quota: the fun page simply asks for the file.
    }
  }

  /** Puts a worker result on screen, whether it is fresh or restored from the cache. */
  function applyResult(result) {
    state.result = result;
    state.selected = null;
    state.aliveSelected = null;
    state.team = null;
    // Demos without any recorded team state (older 0.6 recordings, some
    // tournament clients) would otherwise show "Players 0" and no table at
    // all. Everyone recorded is then the only sensible group.
    state.team0 = !result.teamsRecorded;
    state.savior = null;
    state.heat.player = null;
    heatView.fitted = false;
    heatView.pin = null;
    heatView.hover = null;
    heatView.data = null;
    renderAll();
  }

  async function handleFile(file) {
    $('error').hidden = true;
    $('results').hidden = true;
    if (!file) return;
    if (!/\.demo$/i.test(file.name)) return showError('Please choose a .demo file.');
    if (file.size > 500 * 1024 * 1024) return showError('That file is larger than 500 MB.');
    try { sessionStorage.removeItem(FUN_CACHE_KEY); } catch (e) { /* ignore */ }
    $('restore-note').hidden = true;
    DDA.DemoCache.clear(); // the previous demo's cached result is obsolete now
    destroyReplay(); // a different demo makes the running client useless
    state.file = file;

    $('progress').hidden = false;
    $('progress-label').textContent = `Analysing ${file.name} …`;
    $('progress-bar').style.width = '0%';

    let buffer;
    try { buffer = await file.arrayBuffer(); } catch (e) { return showError('Could not read the file.'); }

    const worker = new Worker('js/worker.js?v=20261110i');
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        $('progress-bar').style.width = (msg.fraction * 100).toFixed(0) + '%';
      } else if (msg.type === 'done') {
        worker.terminate();
        rememberFun(msg, file.name);
        $('progress').hidden = true;
        applyResult(msg);
        // Background write; the page never waits for it.
        DDA.DemoCache.save(msg, file);
      } else if (msg.type === 'error') {
        worker.terminate();
        showError(msg.message);
      }
    };
    worker.onerror = () => { worker.terminate(); showError('The analysis failed unexpectedly.'); };
    worker.postMessage({ buffer }, [buffer]); // "transfer" = hand over the memory instead of copying it
  }

  // ---------- replay player -------------------------------------------------------------

  function ensureReplayFrame() {
    if (replay.frame) return replay.frame;
    const frame = document.createElement('iframe');
    frame.id = 'replay-frame';
    frame.title = 'DDNet replay';
    frame.allow = 'fullscreen';
    frame.src = REPLAY_URL;
    $('replay-stage').append(frame);
    replay.frame = frame;
    replay.frameReady = false;
    replay.frameDemo = null;
    return frame;
  }

  /** True while `win` is one of our two players (the iframe or the tab). */
  function isPlayer(win) {
    if (!win) return false;
    if (replay.frame && win === replay.frame.contentWindow) return true;
    return !!(replay.tab && !replay.tab.closed && win === replay.tab);
  }

  /** Hands the analysed file to a player. Called on every "hello", i.e. once per load. */
  async function sendDemo(seekTick, target) {
    if (!state.file || !state.result || replay.sending) return;
    const win = target ||
      (replay.mode === 'tab'
        ? (replay.tab && !replay.tab.closed ? replay.tab : null)
        : (replay.frame ? replay.frame.contentWindow : null));
    if (!win) return;
    const isFrame = !!replay.frame && win === replay.frame.contentWindow;
    const token = ++replay.token;
    const name = state.file.name;
    replay.sending = true;
    let buffer;
    try {
      buffer = await state.file.arrayBuffer();
    } catch (error) {
      replay.sending = false;
      if (token === replay.token) showReplayError('The demo file could not be read again.');
      return;
    }
    replay.sending = false;
    // A new analysis (or a reload) happened while the file was being read.
    if (token !== replay.token || !isPlayer(win)) return;
    try {
      win.postMessage(
        { type: 'demo', name, buffer, seekTick: seekTick ?? null },
        location.origin,
        [buffer]); // transfer, so even a 100 MB demo costs no copy
      if (isFrame) replay.frameDemo = name; else replay.tabDemo = name;
    } catch (error) {
      showReplayError('The demo could not be handed to the replay player.');
    }
  }

  function showReplayError(message) {
    const box = $('replay-error');
    box.textContent = message;
    box.hidden = false;
  }

  /** Frees the in-page client's memory. Used when the player moves to a tab. */
  function dropReplayFrame() {
    if (!replay.frame) return;
    replay.frame.remove();
    replay.frame = null;
    replay.frameReady = false;
    replay.frameDemo = null;
  }

  /** Closes the player tab (it was opened by this page, so this is allowed). */
  function closeReplayTab() {
    const tab = replay.tab;
    replay.tab = null;
    replay.tabReady = false;
    replay.tabDemo = null;
    if (tab && !tab.closed) {
      try { tab.close(); } catch (error) { /* already gone */ }
    }
  }

  /**
   * Plays the demo in this page, over the statistics. The client is kept alive
   * between demos: a new analysis swaps the demo into the running instance
   * instead of throwing the whole 51 MB client away and booting it again.
   */
  function openReplayHere(tick) {
    replay.mode = 'frame';
    closeReplayTab(); // one client at a time
    const frame = ensureReplayFrame();
    $('replay-overlay').hidden = false;
    document.body.classList.add('replay-open');
    replay.pendingSeek = tick;
    if (!replay.frameReady) return; // the player's "hello" will hand over the demo
    const win = frame.contentWindow;
    if (replay.frameDemo === state.file.name) {
      if (tick !== null) win.postMessage({ type: 'seekTick', tick }, location.origin);
      win.postMessage({ type: 'play' }, location.origin);
    } else {
      sendDemo(tick, win);
    }
    win.focus();
  }

  /**
   * Plays the demo in its own tab, so the statistics stay visible. The tab is
   * reused for every later ▶ click while it is open. Returns false when the
   * browser blocks the popup, so the caller can fall back to the overlay.
   */
  function openReplayInTab(tick) {
    let tab = replay.tab;
    if (!tab || tab.closed) {
      let opened = null;
      try { opened = window.open('', REPLAY_TAB); } catch (error) { opened = null; }
      if (!opened) return false;
      tab = replay.tab = opened;
      replay.tabReady = false;
      replay.tabDemo = null;
      // A fresh window starts on about:blank; a tab left over from an earlier
      // page load is sent back to the player so it says hello again.
      try { tab.location.replace(REPLAY_URL); } catch (error) { return false; }
    }
    replay.mode = 'tab';
    replay.pendingSeek = tick;
    dropReplayFrame();
    $('replay-overlay').hidden = true;
    document.body.classList.remove('replay-open');
    try { tab.focus(); } catch (error) { /* the tab is gone */ }

    // A player that is already running does not say hello again, so hand it
    // the new demo (or only the new position) directly.
    if (replay.tabReady) {
      if (replay.tabDemo === state.file.name) {
        if (tick !== null) tab.postMessage({ type: 'seekTick', tick }, location.origin);
        tab.postMessage({ type: 'play' }, location.origin);
        replay.pendingSeek = null;
      } else {
        sendDemo(tick);
      }
    }
    return true;
  }

  /** Opens the player, optionally jumping to an absolute tick (e.g. just before a fail). */
  function openReplay(tick, where = replay.mode) {
    if (!state.result) return;
    if (!state.file) {
      showReplayError('The demo file is no longer loaded. Drop it again to use the replay.');
      return;
    }
    $('replay-error').hidden = true;
    const target = Number.isFinite(tick) ? tick : null;
    if (where === 'tab') {
      replay.mode = 'tab';
      if (openReplayInTab(target)) return;
      showReplayError('The new tab was blocked, so the replay opened here instead.');
    }
    openReplayHere(target);
  }

  function closeReplay() {
    $('replay-overlay').hidden = true;
    document.body.classList.remove('replay-open');
    if (replay.frame && replay.frameReady) {
      replay.frame.contentWindow.postMessage({ type: 'pause' }, location.origin);
    }
    $('watch-replay').focus();
  }

  /**
   * Stops any running player and marks the loaded demo as stale. Called when
   * another demo is analysed. The client itself is kept alive, so the next
   * replay swaps the new demo into it instead of loading and booting the
   * ~51 MB client again.
   */
  function destroyReplay() {
    replay.token++;
    replay.pendingSeek = null;
    replay.frameDemo = null;
    replay.tabDemo = null;
    replay.sending = false;
    if (replay.frame && replay.frameReady) {
      try { replay.frame.contentWindow.postMessage({ type: 'pause' }, location.origin); } catch (error) { /* gone */ }
    }
    if (replay.tab && !replay.tab.closed) {
      try { replay.tab.postMessage({ type: 'pause' }, location.origin); } catch (error) { /* closed */ }
    }
    $('replay-error').hidden = true;
    $('replay-overlay').hidden = true;
    document.body.classList.remove('replay-open');
  }

  // The player says hello when its page (re)loads, including the one reload the
  // cross-origin-isolation service worker performs, and repeats it until a demo
  // arrives. That also covers a page that was already open when this page reloaded.
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const fromFrame = !!replay.frame && event.source === replay.frame.contentWindow;
    const fromTab = !!replay.tab && !replay.tab.closed && event.source === replay.tab;
    if (!fromFrame && !fromTab) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'hello') {
      if (fromFrame) replay.frameReady = true; else replay.tabReady = true;
      sendDemo(replay.pendingSeek, event.source);
    } else if (message.type === 'playing') {
      replay.pendingSeek = null;
    } else if (message.type === 'close') {
      if (fromFrame) {
        closeReplay();
      } else {
        replay.tab = null;
        replay.tabReady = false;
        replay.tabDemo = null;
      }
    } else if (message.type === 'error') {
      if (fromFrame) showReplayError(String(message.message || 'The replay player failed.'));
    }
  });

  // ---------- wiring --------------------------------------------------------------------

  const zone = $('drop-zone'), input = $('file-input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  $('threshold').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    if (!(value >= 0)) return;
    state.thresholdTicks = Math.round(value * TICKS_PER_SECOND);
    if (state.result) renderAll();
  });
  $('save-threshold').addEventListener('input', (e) => {
    const value = parseFloat(e.target.value);
    if (!(value >= 0)) return;
    state.saveThresholdTicks = Math.round(value * TICKS_PER_SECOND);
    if (state.result) renderAll();
  });
  $('include-deep').addEventListener('change', (e) => {
    state.includeDeep = e.target.checked;
    if (state.result) renderAll();
  });
  $('watch-replay').addEventListener('click', () => openReplay(null, 'frame'));
  $('watch-replay-tab').addEventListener('click', () => openReplay(null, 'tab'));
  $('team0-toggle').addEventListener('click', () => {
    state.team0 = !state.team0;
    renderAll();
  });
  $('detail-zoom').addEventListener('click', () => {
    state.detailed = !state.detailed;
    $('detail-zoom').textContent = state.detailed ? 'View basic' : 'View detailed';
    $('detail-zoom').setAttribute('aria-pressed', String(state.detailed));
    renderDetail();
  });
  $('alive-zoom').addEventListener('click', () => {
    state.aliveDetailed = !state.aliveDetailed;
    $('alive-zoom').textContent = state.aliveDetailed ? 'View basic' : 'View detailed';
    $('alive-zoom').setAttribute('aria-pressed', String(state.aliveDetailed));
    renderAliveDetail();
  });
  // ---------- heatmap controls ------------------------------------------------------------

  $('heat-modes').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn || !state.result) return;
    state.heat.mode = btn.dataset.mode;
    heatView.pin = null;
    renderHeat();
  });
  $('heat-chunks').addEventListener('click', (event) => {
    const btn = event.target.closest('button[data-chunk]');
    if (!btn || !state.result) return;
    const chunk = Number(btn.dataset.chunk);
    if (!chunk || chunk === state.heat.chunk) return;
    state.heat.chunk = chunk;
    // The pinned/hovered box belonged to the old grid; keep the zoom though, so
    // switching area size does not throw you back to the whole map.
    heatView.pin = null;
    heatView.hover = null;
    renderHeat();
  });
  $('heat-reset').addEventListener('click', () => {
    heatView.fitted = false;
    heatView.pin = null;
    if (heatView.data) drawHeat(heatView.data);
  });

  const heatCanvas = $('heat-canvas');
  heatCanvas.addEventListener('wheel', (event) => {
    const view = heatView.data;
    if (!view || !heatView.scale) return;
    event.preventDefault();
    const rect = heatCanvas.getBoundingClientRect();
    const mx = event.clientX - rect.left, my = event.clientY - rect.top;
    const next = Math.min(48, Math.max(heatView.fit, heatView.scale * Math.exp(-event.deltaY * 0.0015)));
    const k = next / heatView.scale;
    heatView.ox = mx - (mx - heatView.ox) * k;
    heatView.oy = my - (my - heatView.oy) * k;
    heatView.scale = next;
    drawHeat(view);
    heatCursor(view, event);
  }, { passive: false });

  let heatDrag = null;
  heatCanvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !heatView.data || !heatView.scale) return;
    heatDrag = { x: event.clientX, y: event.clientY, ox: heatView.ox, oy: heatView.oy };
    heatCanvas.setPointerCapture(event.pointerId);
    heatCanvas.classList.add('dragging');
  });
  heatCanvas.addEventListener('pointermove', (event) => {
    if (!heatView.data) return;
    if (heatDrag) {
      heatView.ox = heatDrag.ox + event.clientX - heatDrag.x;
      heatView.oy = heatDrag.oy + event.clientY - heatDrag.y;
      drawHeat(heatView.data);
      return;
    }
    heatCursor(heatView.data, event);
  });
  const endHeatDrag = (event) => {
    if (!heatDrag) return;
    heatDrag = null;
    heatCanvas.classList.remove('dragging');
    if (heatCanvas.hasPointerCapture(event.pointerId)) heatCanvas.releasePointerCapture(event.pointerId);
  };
  heatCanvas.addEventListener('pointerup', endHeatDrag);
  heatCanvas.addEventListener('pointercancel', endHeatDrag);
  heatCanvas.addEventListener('pointerleave', () => {
    if (!heatDrag) $('heat-cursor').textContent = 'Scroll to zoom, drag to move, double-click to reset.';
  });
  heatCanvas.addEventListener('dblclick', () => {
    heatView.fitted = false;
    heatView.pin = null;
    if (heatView.data) drawHeat(heatView.data);
  });

  if (window.ResizeObserver) {
    new ResizeObserver(() => {
      const view = heatView.data;
      if (!view || $('heatmap').hidden) return;
      // Our own height changes also fire this; only a new width needs a refit.
      if (heatCanvas.parentElement.clientWidth === heatView.width) return;
      heatView.fitted = false;
      sizeHeatCanvas(view);
      drawHeat(view);
    }).observe(heatCanvas.parentElement);
  }

  document.querySelectorAll('#stats-table th').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.sortDesc = state.sortKey === key ? !state.sortDesc : key !== 'name';
    state.sortKey = key;
    if (state.result) renderTable();
  }));
  document.querySelectorAll('#unfrozen-table th').forEach((th) => th.addEventListener('click', () => {
    const key = th.dataset.sort;
    state.unfSortDesc = state.unfSortKey === key ? !state.unfSortDesc : key !== 'name';
    state.unfSortKey = key;
    if (state.result) renderUnfrozen();
  }));

  // Reloaded or came back from the fun page? Show this tab's last analysis again.
  (async () => {
    try {
      const saved = await DDA.DemoCache.load();
      if (!saved || !saved.result || state.result) return;
      if (saved.file) {
        state.file = saved.file instanceof File
          ? saved.file
          : new File([saved.file], saved.name, { lastModified: saved.lastModified });
      }
      applyResult(saved.result);
      rememberFun(saved.result, saved.name);
      const note = $('restore-note');
      note.hidden = false;
      note.textContent = `Restored ${saved.name} from this tab's last analysis. ` +
        (saved.file
          ? 'Drop another .demo file to replace it.'
          : 'The file itself was too large to keep, so the replay needs it again.');
    } catch (e) {
      // No cache or storage unavailable: the normal drop zone is all we need.
    }
  })();

  // Exposed only so the logic can be smoke-tested without a browser.
  window.__ddaTest = { state, renderAll };
})();

