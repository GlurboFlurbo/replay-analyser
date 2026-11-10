/*
 * UI for the fun page: one demo in, silly counters out.
 *
 * It talks to the same worker as the main analyzer, but asks for the lightweight
 * "funOnly" mode, which parses snapshots and messages without unpacking the map
 * or collecting heat/save data.
 */
(function () {
  'use strict';

  const TICKS_PER_SECOND = 50;
  const $ = (id) => document.getElementById(id);

  const state = {
    result: null,
    emoteSortKey: 'total', // 'name', 'total' or an emote index
    emoteSortDesc: true,
  };
  let worker = null;
  let emoteColumns = []; // [{ key, th }] so the sort arrow can be updated without rebuilding icons

  /** Formats seconds as m:ss or h:mm:ss. */
  function clock(seconds) {
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const mm = String(m).padStart(h ? 2 : 1, '0'), rr = String(r).padStart(2, '0');
    return h ? `${h}:${mm}:${rr}` : `${mm}:${rr}`;
  }

  /** Creates an element; text goes in via textContent, so player names can never inject HTML. */
  function el(tag, opts = {}, ...children) {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = opts.text;
    for (const c of children) node.append(c);
    return node;
  }

  // ===========================================================================
  //  EMOTE ICONS - EDIT THIS BLOCK
  // ===========================================================================
  // The keys are the emote names from the DDNet protocol and must not be
  // renamed - the analyzer matches them exactly. Put the URL of each icon in the
  // matching slot, for example:
  //   HEARTS: 'img/emotes/hearts.svg',
  // The image is loaded from this site (CSP allows 'self' and data: URLs).
  // Leave a slot empty ('') and the emote name is shown as text instead.
  // Use forward slashes in paths, never single backslashes (JS escape chars).
  //
  // If your icons are CSS sprites or inline SVG, edit emoteIcon() below: every
  // column also has the classes `emote-col emote-hearts` (etc.) on its <th>, and
  // every cell has `emote-hearts`, so you can target them from css/style.css.
  // ===========================================================================
  const EMOTE_ICON_URLS = {
    OOP: 'Assets/Icons/emote_01.png',
    EXCLAMATION: 'Assets/Icons/emote_02.png',
    HEARTS: 'Assets/Icons/emote_03.png',
    DROP: 'Assets/Icons/emote_04.png',
    DOTDOT: 'Assets/Icons/emote_05.png',
    MUSIC: 'Assets/Icons/emote_06.png',
    SORRY: 'Assets/Icons/emote_07.png',
    GHOST: 'Assets/Icons/emote_08.png',
    SUSHI: 'Assets/Icons/emote_09.png',
    SPLATTEE: 'Assets/Icons/emote_10.png',
    DEVILTEE: 'Assets/Icons/emote_11.png',
    ZOMG: 'Assets/Icons/emote_12.png',
    ZZZ: 'Assets/Icons/emote_13.png',
    WTF: 'Assets/Icons/emote_14.png',
    EYES: 'Assets/Icons/emote_15.png',
    QUESTION: 'Assets/Icons/emote_16.png',
  };

  // Optional pretty names, used only for tooltips and as the text fallback when
  // an icon slot is empty. Keys must still be the protocol names above.
  const EMOTE_LABELS = {
    SUSHI: 'ANNOYED',
    SPLATTEE: 'FURIOUS',
    DEVILTEE: 'DEVIL',
    ZOMG: 'FUCK',
    EYES: 'HAPPY',
  };

  /** The display name for an emote: the override if there is one, else the protocol name. */
  function emoteLabel(name) {
    return EMOTE_LABELS[name] || name;
  }

  /** Builds one emote column header; replace the body if you need custom markup. */
  function emoteIcon(name) {
    const span = el('span', { class: 'emote-icon emote-' + name.toLowerCase() });
    span.setAttribute('aria-hidden', 'true');
    const url = EMOTE_ICON_URLS[name];
    if (url) {
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      span.append(img);
    } else {
      span.textContent = emoteLabel(name);
    }
    return span;
  }
  // ===========================================================================
  //  end of emote icon block
  // ===========================================================================

  function showError(message) {
    $('progress').hidden = true;
    const box = $('error');
    box.textContent = message;
    box.hidden = false;
  }

  /**
   * The analyzer stores the fun data of the last demo it analysed for this tab
   * (sessionStorage survives the navigation). Reusing it means moving from the
   * statistics to the fun page does not ask for the same file again.
   */
  function readCarriedFun() {
    try {
      const raw = sessionStorage.getItem('dda:lastFun');
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !data.header || !data.fun || !data.fun.jumps || !data.fun.emotes) return null;
      return data;
    } catch (e) {
      return null;
    }
  }

  function showCarriedNote(data) {
    const note = $('carry-note');
    note.textContent = `Showing ${data.name || data.header.mapName}, the demo you just analysed. ` +
      'Drop another .demo file to replace it.';
    note.hidden = false;
  }

  async function handleFile(file) {
    $('error').hidden = true;
    $('results').hidden = true;
    $('carry-note').hidden = true;
    if (!file) return;
    if (!/\.demo$/i.test(file.name)) return showError('Please choose a .demo file.');
    if (file.size > 500 * 1024 * 1024) return showError('That file is larger than 500 MB.');

    if (worker) worker.terminate();
    $('progress').hidden = false;
    $('progress-label').textContent = `Analysing ${file.name} …`;
    $('progress-bar').style.width = '0%';

    let buffer;
    try { buffer = await file.arrayBuffer(); } catch (e) { return showError('Could not read the file.'); }

    worker = new Worker('js/worker.js?v=20261110i');
    worker.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'progress') {
        $('progress-bar').style.width = (msg.fraction * 100).toFixed(0) + '%';
      } else if (msg.type === 'done') {
        worker.terminate();
        worker = null;
        state.result = msg;
        $('progress').hidden = true;
        render();
      } else if (msg.type === 'error') {
        worker.terminate();
        worker = null;
        showError(msg.message);
      }
    };
    worker.onerror = () => {
      worker.terminate();
      worker = null;
      showError('The analysis failed unexpectedly.');
    };
    worker.postMessage({ buffer, funOnly: true }, [buffer]);
  }

  function render() {
    const result = state.result;
    const jumps = result.fun.jumps;
    const emotes = result.fun.emotes;
    const header = result.header;
    $('results').hidden = false;

    const totalJumps = jumps.players.reduce((n, p) => n + p.double, 0);
    const playerCount = new Set([
      ...jumps.players.map((p) => p.name),
      ...emotes.players.map((p) => p.name),
    ]).size;
    const cards = [
      ['Map', header.mapName],
      ['Recorded', header.timestamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2')],
      ['Analysed length', clock((jumps.lastTick - jumps.firstTick) / TICKS_PER_SECOND)],
      ['Players', String(playerCount)],
      ['Double jumps', String(totalJumps)],
      ['Emotes', String(emotes.total)],
    ];
    $('summary').replaceChildren(...cards.map(([label, value]) =>
      el('div', { class: 'card' }, el('span', { class: 'label', text: label }), el('span', { class: 'value', text: value }))));

    renderJumps(jumps, totalJumps);
    renderEmotes(emotes);
  }

  function renderJumps(jumps, total) {
    const body = $('jumps-body');
    if (!jumps.available) {
      $('jumps-wrap').hidden = true;
      const note = $('jumps-unavailable');
      note.hidden = false;
      note.textContent = 'This demo does not report jump counts. Its server or client version ' +
        'predates the jump display data (m_JumpedTotal).';
      body.replaceChildren();
      return;
    }
    $('jumps-wrap').hidden = false;
    $('jumps-unavailable').hidden = true;

    if (!jumps.players.length) {
      const td = el('td', { text: 'No players with a character were found.' });
      td.colSpan = 5;
      body.replaceChildren(el('tr', {}, td));
      return;
    }

    const best = jumps.players[0].double || 1;
    body.replaceChildren(...jumps.players.map((p, i) => {
      const fill = el('div', { class: 'fill' });
      fill.style.width = (100 * p.double) / best + '%';
      const cell = el('td', { class: 'num fails-cell jumps-cell' }, fill, el('span', { text: String(p.double) }));
      cell.title = `${p.double} air ${p.double === 1 ? 'jump' : 'jumps'} in ` +
        `${clock((p.last - p.first) / TICKS_PER_SECOND)} visible`;
      const rateCell = el('td', { class: 'num', text: rate(p).toFixed(1) });
      rateCell.title = 'Air jumps per 10 minutes of being visible';
      return el('tr', {},
        el('td', { class: 'num', text: String(i + 1) }),
        el('td', { text: p.name }),
        cell,
        rateCell,
        el('td', { class: 'num', text: total ? Math.round((100 * p.double) / total) + '%' : '0%' }));
    }));
  }

  /** Air jumps per 10 minutes of being visible in the recording. */
  function rate(p) {
    const seconds = Math.max(1, (p.last - p.first) / TICKS_PER_SECOND);
    return (p.double * 600) / seconds;
  }

  // ---------- emote table ----------------------------------------------------------------

  function renderEmotes(emotes) {
    buildEmoteHeader(emotes.types);

    const wrap = $('emotes-wrap');
    const note = $('emotes-note');
    const body = $('emotes-body');
    const foot = $('emotes-foot');

    if (!emotes.total) {
      wrap.hidden = true;
      body.replaceChildren();
      foot.replaceChildren();
      note.hidden = false;
      note.textContent = emotes.unresolved
        ? `No emote could be matched to a player (${emotes.unresolved} message` +
          `${emotes.unresolved === 1 ? '' : 's'} came from an unknown client id).`
        : 'No emote bubbles were used in this recording.';
      return;
    }

    wrap.hidden = false;
    if (emotes.unresolved) {
      note.hidden = false;
      note.textContent = `${emotes.unresolved} emote message${emotes.unresolved === 1 ? '' : 's'} ` +
        'could not be matched to a player name and are not shown.';
    } else {
      note.hidden = true;
    }
    renderEmoteRows();
  }

  /** One header cell per emote, built once per demo so icons are not reloaded on every sort. */
  function buildEmoteHeader(types) {
    const row = $('emotes-head');
    const cells = [];
    emoteColumns = [];

    const player = el('th', { class: 'sortable', text: 'Player' });
    player.dataset.sort = 'name';
    player.scope = 'col';
    cells.push(player);
    emoteColumns.push({ key: 'name', th: player });

    types.forEach((name, index) => {
      const th = el('th', { class: 'emote-col sortable emote-' + name.toLowerCase() });
      th.dataset.sort = String(index);
      th.dataset.emote = name;
      th.scope = 'col';
      th.title = emoteLabel(name);
      th.setAttribute('aria-label', emoteLabel(name));
      th.append(emoteIcon(name));
      cells.push(th);
      emoteColumns.push({ key: index, th });
    });

    const total = el('th', { class: 'num sortable', text: 'Total' });
    total.dataset.sort = 'total';
    total.scope = 'col';
    cells.push(total);
    emoteColumns.push({ key: 'total', th: total });

    row.replaceChildren(...cells);
    updateEmoteSortMarks();
  }

  function updateEmoteSortMarks() {
    for (const column of emoteColumns) {
      const active = column.key === state.emoteSortKey;
      column.th.classList.toggle('sorted', active);
      column.th.classList.toggle('asc', active && !state.emoteSortDesc);
    }
  }

  /**
   * One row per player. The jump collector already knows every player that had a
   * character, so players who never emoted still appear with a row of zeros;
   * emoting players the jump collector missed are appended rather than lost.
   */
  function emoteRows(emotes, jumps) {
    const byName = new Map(emotes.players.map((p) => [p.name, p]));
    const rows = jumps.players.map((p) => {
      const e = byName.get(p.name);
      if (e) byName.delete(p.name);
      return { name: p.name, counts: e ? e.counts : null, total: e ? e.total : 0 };
    });
    for (const e of byName.values()) {
      rows.push({ name: e.name, counts: e.counts, total: e.total });
    }
    return rows;
  }

  function sortedEmoteRows(rows) {
    const key = state.emoteSortKey;
    if (key === 'name') {
      return rows.slice().sort((a, b) =>
        (state.emoteSortDesc ? -1 : 1) * a.name.localeCompare(b.name));
    }
    return rows.slice().sort((a, b) => {
      const av = key === 'total' ? a.total : (a.counts ? a.counts[key] : 0);
      const bv = key === 'total' ? b.total : (b.counts ? b.counts[key] : 0);
      return (state.emoteSortDesc ? 1 : -1) * (bv - av) || a.name.localeCompare(b.name);
    });
  }

  function renderEmoteRows() {
    const result = state.result;
    if (!result) return;
    const emotes = result.fun.emotes;
    const types = emotes.types;
    const rows = sortedEmoteRows(emoteRows(emotes, result.fun.jumps));

    const totals = new Array(types.length).fill(0);
    let grand = 0;
    for (const r of rows) {
      grand += r.total;
      for (let i = 0; i < types.length; i++) totals[i] += r.counts ? r.counts[i] : 0;
    }

    const body = $('emotes-body');
    body.replaceChildren(...rows.map((r) => {
      const cells = [el('td', { text: r.name })];
      types.forEach((name, i) => {
        const count = r.counts ? r.counts[i] : 0;
        const td = el('td', {
          class: 'emote-col emote-' + name.toLowerCase() + (count ? '' : ' zero'),
          text: String(count),
        });
        td.dataset.emote = name;
        if (count) td.title = `${r.name} used ${emoteLabel(name)} ${count} time${count === 1 ? '' : 's'}`;
        cells.push(td);
      });
      cells.push(el('td', { class: 'num', text: String(r.total) }));
      return el('tr', {}, ...cells);
    }));

    const footCells = [el('td', { text: 'All players' })];
    types.forEach((name, i) => {
      const td = el('td', { class: 'emote-col emote-' + name.toLowerCase(), text: String(totals[i]) });
      td.dataset.emote = name;
      footCells.push(td);
    });
    footCells.push(el('td', { class: 'num', text: String(grand) }));
    $('emotes-foot').replaceChildren(el('tr', {}, ...footCells));

    updateEmoteSortMarks();
  }

  // ---------- wiring ----------------------------------------------------------------------

  const zone = $('drop-zone'), input = $('file-input');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => handleFile(input.files[0]));
  ['dragenter', 'dragover'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach((t) => zone.addEventListener(t, (e) => { e.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  $('emotes-head').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th || !state.result) return;
    const raw = th.dataset.sort;
    const key = raw === 'name' ? 'name' : raw === 'total' ? 'total' : Number(raw);
    if (state.emoteSortKey === key) {
      state.emoteSortDesc = !state.emoteSortDesc;
    } else {
      state.emoteSortKey = key;
      state.emoteSortDesc = key !== 'name'; // counts start with the biggest, names A-Z
    }
    renderEmoteRows();
  });

  // Coming from the analyzer? Its last demo is already analysed and stored.
  const carried = readCarriedFun();
  if (carried) {
    state.result = carried;
    render();
    showCarriedNote(carried);
  }
})();
