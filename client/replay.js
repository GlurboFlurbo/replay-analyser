/*
 * Full demo playback with the real DDNet client, compiled to WebAssembly.
 *
 * The client files (DDNet.js / .wasm / .data) are the same build the official
 * https://ddnet.org/watch/ page plays. This page only boots it, hands it a demo
 * file, and drives the demo player through the console callbacks the build
 * exports:
 *
 *   EmscriptenCallbackDropFile(path)      open a demo from the client's FS
 *   EmscriptenCallbackConsoleExecute(cmd) run a console command
 *   EmscriptenCallbackDemoInfo()          "current first last paused speed" (ticks)
 *   EmscriptenCallbackPlayerInfo()        one "id<TAB>name<TAB>skin<TAB>..." line per tee
 *   EmscriptenCallbackLoadingInfo()       "percent<TAB>caption<TAB>content"
 *
 * The stats page embeds this page in an iframe and sends the demo bytes with
 * postMessage; no demo ever leaves the browser.
 */
(function () {
  'use strict';

  const TICKS_PER_SECOND = 50;
  const $ = (id) => document.getElementById(id);
  // The statistics page embeds this page in an iframe, or opens it in its own
  // tab and stays the opener. Either way it is who we talk to.
  const embedded = window.parent !== window;
  const host = embedded ? window.parent : window.opener;
  const post = (msg) => {
    if (!host) return; // opened directly, nobody to talk to
    try { host.postMessage(msg, location.origin); } catch (e) { /* the host page is gone */ }
  };

  const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
  const DEFAULT_SPEED = 3;
  let speedIndex = SPEEDS.indexOf(DEFAULT_SPEED);

  // Clean viewer, like watch mode: no chat, no HUD, no welcome popup, muted.
  const CONFIG = [
    'cl_show_welcome 0',
    'cl_showhud_timer 0',
    'cl_demo_keyboard_shortcuts 0', // the page's own bar drives playback
    'cl_demo_show_pause 0',         // no in-canvas pause/speed badges over the video
    'cl_demo_show_speed 0',
    'gfx_limit_aspect_ratio 0',
    'gfx_vsync 1',
    'cl_refresh_rate 60',
    'unbindall',
    'cl_offline 1',
    'cl_skin_download_url https://ddnet.org/skins/skin/',
    'cl_skin_community_download_url https://ddnet.org/skins/skin/community/',
    'cl_download_skins 1',
    'cl_download_community_skins 1',
    'cl_vanilla_skins_only 0',
    'cl_showhud_spectator 0',
    'cl_showhud_score 0',
    'cl_showkillmessages 0',
    'cl_showchat 0',
    'snd_chat 0',
    'cl_overlay_entities 0',
    'cl_show_direction 1',
    'snd_volume 0',
    ''
  ].join('\n');

  // ---------- state ---------------------------------------------------------------------

  let runtimeReady = false;
  let pendingDemo = null;   // { name, bytes, seekTick }
  let demoName = '';
  let demoStarted = false;
  let demoCount = 0;
  let loadingPoll = null;
  let pendingSeek = null;   // absolute tick, applied once the demo knows its length
  let dragging = false;     // the pointer is down on the slider right now
  let dragLost = false;     // its release never arrived; ignore the rest of that gesture
  let seekTarget = null;    // slider position (0..1000) the client is expected to reach
  let seekSince = 0;
  let lastSliderEvent = 0;  // last pointer/input activity on the slider (drag watchdog)
  let entities = false;
  let keys = true;

  const demo = { current: 0, first: 0, last: 0, paused: true, speed: 1 };

  // ---------- boot ----------------------------------------------------------------------

  window.Module = {
    locateFile: (path, prefix) => prefix + path,
    // Emscripten's pthread workers are created from the main script.
    mainScriptUrlOrBlob: 'DDNet.js',
    canvas: $('canvas'),
    arguments: [],
    preRun: [function () {
      FS.createPath('/', 'home/web_user/.local/share/ddnet', true, true);
      FS.writeFile('/home/web_user/.local/share/ddnet/settings_ddnet.cfg', CONFIG);
    }],
    print: (text) => console.log('[client] ' + text),
    printErr: (text) => console.error('[client] ' + text),
    onRuntimeInitialized: onRuntime
  };

  function boot() {
    if (!window.crossOriginIsolated) {
      // The threaded client needs SharedArrayBuffer. Static hosts get this from
      // the page-wide service worker; if that did not take effect the client
      // would fail in a way nobody can read.
      showError('The replay player needs a cross-origin isolated page. Reload the page and try again.');
      return;
    }
    setLoading(0.04, 'Downloading the DDNet client…');
    const script = document.createElement('script');
    script.src = 'DDNet.js';
    script.onerror = () => showError('The client files could not be loaded.');
    document.head.appendChild(script);
  }

  function onRuntime() {
    runtimeReady = true;
    setLoading(0.85, 'Starting the client…');
    if (pendingDemo) dropDemo();
    startPolling();
  }

  // ---------- demo hand-off -------------------------------------------------------------

  function receive(message) {
    if (message.type === 'demo') {
      stopHello(); // the host has found us
      const bytes = new Uint8Array(message.buffer);
      pendingDemo = { name: String(message.name || 'demo.demo'), bytes, seekTick: message.seekTick ?? null };
      demoName = pendingDemo.name;
      if (runtimeReady) dropDemo();
    } else if (message.type === 'seekTick') {
      seekToTick(Number(message.tick));
    } else if (message.type === 'exec') {
      exec(String(message.cmd || ''));
    } else if (message.type === 'pause') {
      pauseNow();
    } else if (message.type === 'play') {
      resumeNow();
    }
  }

  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin) return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    receive(message);
  });

  function dropDemo() {
    const { name, bytes, seekTick } = pendingDemo;
    pendingDemo = null;
    try {
      const dir = '/home/web_user/.local/share/ddnet/demos/replay';
      FS.createPath('/', dir.substring(1), true, true);
      demoCount++;
      const safe = name.replace(/[^A-Za-z0-9_.-]/g, '_');
      const path = `${dir}/${demoCount}_${safe}`;
      FS.writeFile(path, bytes);
      Module.ccall('EmscriptenCallbackDropFile', null, ['string'], [path]);
      demoName = name;
      pendingSeek = Number.isFinite(seekTick) ? seekTick : null;
      $('demo-title').textContent = name;
      $('demo-title').title = name;
      demoStarted = false;
      dragging = false;
      dragLost = false;
      seekTarget = null;
    } catch (error) {
      showError('The client could not open this demo: ' + error.message);
    }
  }

  // ---------- polling -------------------------------------------------------------------

  function startPolling() {
    if (loadingPoll) return;
    loadingPoll = setInterval(pollLoading, 150);
    setInterval(pollPlayback, 100);
  }

  function pollLoading() {
    let info = '';
    try { info = Module.ccall('EmscriptenCallbackLoadingInfo', 'string', [], []); } catch (e) { return; }
    if (!info) return;
    const [percent, caption, content] = info.split('\t');
    setLoading(0.85 + 0.14 * Math.min(1, Math.max(0, Number(percent) / 100)),
      (content || caption || 'Loading the map…').trim());
    if (demoStarted && loadingPoll) {
      clearInterval(loadingPoll);
      loadingPoll = null;
    }
  }

  function pollPlayback() {
    let info = '';
    try { info = Module.ccall('EmscriptenCallbackDemoInfo', 'string', [], []); } catch (e) { return; }
    if (!info) return;
    const [current, first, last, paused, speed] = info.split(' ').map(Number);
    if (!Number.isFinite(last) || last <= first) return;

    const wasPlaying = demo.paused === false;
    const wasAt = demo.current;
    const wasFirst = demo.first;

    demo.current = current;
    demo.first = first;
    demo.last = last;
    demo.paused = paused !== 0;
    demo.speed = speed || 1;

    if (!demoStarted) {
      demoStarted = true;
      $('loading').hidden = true;
      $('bar').hidden = false;
      applyDefaultSpeed();
      post({ type: 'playing' });
    }

    // At the end the demo player rewinds to the first tick and pauses. A
    // viewer should rest on the final frame instead of being thrown back to
    // the start, so put the player back on the end (still paused).
    if (demoStarted && wasPlaying && demo.paused && !choosingPosition() &&
        demo.current <= demo.first + 5 && wasAt > wasFirst + 5) {
      seekToFraction(1);
    }

    applyPendingSeek();
    updateBar();
  }

  function applyPendingSeek() {
    if (pendingSeek === null) return;
    seekToTick(pendingSeek);
    pendingSeek = null;
  }

  /**
   * Every newly opened demo starts at 3x instead of the client's remembered
   * speed; the speed buttons still change it from there for this demo.
   */
  function applyDefaultSpeed() {
    speedIndex = SPEEDS.indexOf(DEFAULT_SPEED);
    exec(`demo_speed ${DEFAULT_SPEED}`);
    $('speed-value').textContent = DEFAULT_SPEED + '×';
  }

  /**
   * demo_seek is asynchronous: the client can take a moment before DemoInfo
   * reports the new position. Until it does, the bar must keep showing where
   * the user asked to go, or polling would yank the thumb back to the old
   * spot. seekTarget is that requested position in slider units (0..1000).
   */
  function seekToFraction(fraction) {
    const clamped = Math.min(1, Math.max(0, fraction));
    exec(`demo_seek ${(clamped * 100).toFixed(3)}`);
    seekTarget = Math.round(clamped * 1000);
    seekSince = performance.now();
    // Show the requested spot immediately, even when the seek came from a
    // fail row rather than the slider itself. While the user is still holding
    // the thumb the browser owns its position; writing it would move the drag
    // anchor under the cursor (Firefox then drops the seek somewhere else).
    if (!dragging) $('seek').value = String(seekTarget);
    $('time-now').textContent = clock(clamped * (demo.last - demo.first));
  }

  function seekToTick(tick) {
    if (!Number.isFinite(tick) || demo.last <= demo.first) {
      pendingSeek = tick;
      return;
    }
    seekToFraction((tick - demo.first) / (demo.last - demo.first));
  }

  // ---------- controls ------------------------------------------------------------------

  function exec(command) {
    if (!command) return;
    try { Module.ccall('EmscriptenCallbackConsoleExecute', null, ['string'], [command]); }
    catch (error) { console.error('[replay] ' + command + ': ' + error); }
  }

  function startPlayback() {
    // On the last tick the client rewinds and stays paused, so pressing play
    // there would do nothing; restart from the beginning instead.
    if (demo.last > demo.first && demo.current >= demo.last - 2) seekToFraction(0);
    exec('demo_play');
    demo.paused = false;
    paintPlayButton();
  }

  function togglePlay() {
    if (demo.paused) {
      startPlayback();
    } else {
      exec('demo_play');
      demo.paused = true;
      paintPlayButton();
    }
  }

  function paintPlayButton() {
    $('play').textContent = demo.paused ? '▶' : '⏸';
  }

  function setSpeed(index) {
    speedIndex = Math.min(SPEEDS.length - 1, Math.max(0, index));
    exec(`demo_speed ${SPEEDS[speedIndex]}`);
    $('speed-value').textContent = SPEEDS[speedIndex] + '×';
  }

  function setEntities(on) {
    entities = on;
    exec(`cl_overlay_entities ${on ? 100 : 0}`);
    $('entities').classList.toggle('on', on);
  }

  function setKeys(on) {
    keys = on;
    exec(`cl_show_direction ${on ? 1 : 0}`);
    $('keys').classList.toggle('on', on);
  }

  /**
   * demo_play is a toggle, so ask the client whether it is actually running
   * instead of trusting the last polled value (which can be one frame stale).
   * The guard stops a second pause request from undoing the first while the
   * command is still queued in the client.
   */
  let lastPauseAt = 0;
  function pauseNow() {
    if (performance.now() - lastPauseAt < 400) return;
    let info = '';
    try { info = Module.ccall('EmscriptenCallbackDemoInfo', 'string', [], []); } catch (e) { return; }
    if (Number(info.split(' ')[3]) === 0) {
      exec('demo_play');
      lastPauseAt = performance.now();
    }
  }

  function resumeNow() {
    let info = '';
    try { info = Module.ccall('EmscriptenCallbackDemoInfo', 'string', [], []); } catch (e) { return; }
    if (Number(info.split(' ')[3]) !== 0) startPlayback();
  }

  function close() {
    if (embedded) { post({ type: 'close' }); return; } // the page answers with "pause"
    if (window.opener) {
      // Popped out: the analyser opened this tab, so we may close it again.
      post({ type: 'close' });
      try { window.close(); } catch (e) { pauseNow(); }
      return;
    }
    pauseNow();
  }

  // ---------- formatting / paint --------------------------------------------------------

  function clock(ticks) {
    const total = Math.max(0, Math.round(ticks / TICKS_PER_SECOND));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return (hours ? hours + ':' + String(minutes).padStart(2, '0') : minutes) + ':' + String(seconds).padStart(2, '0');
  }

  /** True while the slider belongs to the user (dragging or a seek is in flight). */
  function choosingPosition() {
    return dragging || seekTarget !== null;
  }

  /** The position polling would paint right now, in slider units (0..1000). */
  function polledUnits() {
    const span = Math.max(1, demo.last - demo.first);
    const current = Math.min(demo.last, Math.max(demo.first, demo.current));
    return Math.round(((current - demo.first) / span) * 1000);
  }

  function updateBar() {
    const span = Math.max(1, demo.last - demo.first);
    const current = Math.min(demo.last, Math.max(demo.first, demo.current));
    const units = polledUnits();

    // If a release event was lost (pointer left the window, touch turned into
    // a scroll on a platform that drops it) the bar must not stay frozen at
    // the dropped position forever. Once the gesture has been quiet for a
    // while, hand the slider back to polling.
    if (dragging && performance.now() - lastSliderEvent > 3000) {
      dragging = false;
      dragLost = true;
    }

    if (seekTarget !== null) {
      // Follow the bar again once the client got there. The timeout is a
      // safety net for a seek the client never reports exactly; it is short
      // so a pin that cannot resolve shows the true position quickly instead
      // of looking frozen. Never time out mid-drag: the user is still
      // choosing a position.
      if (!dragging && (Math.abs(units - seekTarget) <= 5 || performance.now() - seekSince > 1500)) {
        seekTarget = null;
      }
    }
    if (!choosingPosition()) {
      $('seek').value = String(units);
      $('time-now').textContent = clock(current - demo.first);
    }
    $('time-end').textContent = clock(span);
    $('speed-value').textContent = demo.speed + '×';
    paintPlayButton();
  }

  function setLoading(fraction, text) {
    $('loading-fill').style.width = (Math.min(1, Math.max(0, fraction)) * 100).toFixed(1) + '%';
    if (text) $('loading-title').textContent = text;
  }

  function showError(message) {
    $('loading').hidden = true;
    $('error').hidden = false;
    $('error').textContent = message;
    post({ type: 'error', message });
  }

  // ---------- wiring --------------------------------------------------------------------

  $('play').addEventListener('click', togglePlay);
  $('back').addEventListener('click', () => exec('demo_skip -10'));
  $('forward').addEventListener('click', () => exec('demo_skip 10'));
  $('speed-down').addEventListener('click', () => setSpeed(speedIndex - 1));
  $('speed-up').addEventListener('click', () => setSpeed(speedIndex + 1));
  $('speed-value').addEventListener('click', () => setSpeed(SPEEDS.indexOf(1)));
  $('zoom-out').addEventListener('click', () => exec('zoom-'));
  $('zoom-in').addEventListener('click', () => exec('zoom+'));
  $('zoom-reset').addEventListener('click', () => exec('zoom'));
  $('entities').addEventListener('click', () => setEntities(!entities));
  $('keys').addEventListener('click', () => setKeys(!keys));
  $('close').addEventListener('click', close);

  const seekSlider = $('seek');

  let lastSeekUnits = -1;
  let lastSeekAt = 0;

  /**
   * One demo_seek per interaction. Browsers differ in which event ends a
   * drag (change, pointerup, or neither on some touch flows), so commit from
   * all of them and let the imprecise duplicates cancel out.
   */
  const commitSlider = () => {
    dragging = false;
    if (demo.last <= demo.first) return;
    if (dragLost) return; // this gesture's tail is ignored until the next one starts
    const units = Number(seekSlider.value);
    if (!Number.isFinite(units)) return;
    const now = performance.now();
    if (units === lastSeekUnits && now - lastSeekAt < 150) return; // pointerup + change pair
    lastSeekUnits = units;
    lastSeekAt = now;
    seekToFraction(units / 1000);
  };

  // Like ddnet.org/watch: dragging only previews the position, the seek is
  // sent once on release. Seeking on every pixel would queue dozens of seeks
  // in the client, and writing the slider while it is being dragged makes
  // Firefox re-anchor the drag, so the thumb then lands somewhere else.
  //
  // Do not call setPointerCapture here: on a native range Firefox keeps its
  // own drag state, and the explicit capture makes it restore the value the
  // control had when the press started as soon as the mouse moves again.
  function beginDrag() {
    dragging = true;
    dragLost = false;
    lastSliderEvent = performance.now();
  }

  seekSlider.addEventListener('pointerdown', (event) => {
    // Do not filter on event.button: on a left-handed setup the primary
    // button is not 0, and a missed press lets polling pull the thumb back
    // to the playing position while the user is still dragging it.
    if (event.button === 1 || dragging) return; // middle click
    beginDrag();
  });
  // Browsers or setups that do not deliver pointer events to a range input
  // still deliver the classic mouse events. Without this fallback the bar is
  // repainted from polling over and over while the thumb is held.
  seekSlider.addEventListener('mousedown', (event) => {
    if (event.button === 1 || dragging) return;
    beginDrag();
  });
  seekSlider.addEventListener('pointerup', commitSlider);
  seekSlider.addEventListener('pointercancel', commitSlider);
  seekSlider.addEventListener('change', commitSlider);

  // A release outside the slider (dragging the thumb off the bar, a touch
  // that turns into a scroll, the pointer leaving the window) never reaches
  // the slider, so finish the gesture wherever it ends.
  for (const type of ['pointerup', 'pointercancel', 'mouseup', 'touchend']) {
    window.addEventListener(type, () => { if (dragging) commitSlider(); }, true);
  }
  // Some platforms drop the release when the pointer leaves the window. The
  // next move with no buttons held proves the drag is over.
  window.addEventListener('pointermove', (event) => {
    if (dragging && event.buttons === 0) commitSlider();
  }, true);
  // Alt-tabbing mid-drag: no release will arrive, so end the gesture here.
  window.addEventListener('blur', () => { if (dragging) commitSlider(); });

  /**
   * Firefox sometimes emits a trusted input event carrying the value the
   * slider had before the user's last click, triggered by the next mouse
   * move. It is not a gesture and no change event follows it, but the
   * browser has already moved the thumb, which flashes back to the old spot
   * for one frame. Undo that paint. Keyboard adjustments always come with a
   * change event (which commits a seek) in the same task, so by the time this
   * runs seekTarget is set and the value is left alone.
   */
  function undoStrayInput() {
    if (dragging || seekTarget !== null || demo.last <= demo.first) return;
    const units = polledUnits();
    if (Math.abs(Number(seekSlider.value) - units) > 20) {
      seekSlider.value = String(units);
      $('time-now').textContent = clock(demo.current - demo.first);
    }
  }

  // Preview only. This handler must not seek: Firefox fires an occasional
  // stray input event with an old value after the control was used (for
  // example when the mouse moves again), and turning that into a seek jumps
  // the demo back to where it was before the seek.
  seekSlider.addEventListener('input', (event) => {
    lastSliderEvent = performance.now();
    // Input means a pointer is still moving the thumb even if the watchdog
    // gave up on the gesture, so pick it back up.
    if (dragLost) {
      dragLost = false;
      dragging = true;
    }
    const fraction = Number(event.target.value) / 1000;
    $('time-now').textContent = clock(fraction * (demo.last - demo.first));
    if (!dragging) setTimeout(undoStrayInput, 0);
  });

  /**
   * The canvas is only a video surface: none of its input should reach the
   * client. Its SDL handlers listen on document, so a capture listener that
   * stops the event first keeps Escape from opening the client menu, F1 from
   * opening its console, and clicks from switching it to free view.
   */
  document.addEventListener('keydown', (event) => {
    // Browser and OS shortcuts stay with them; the client would otherwise
    // preventDefault on the keys it maps.
    if (event.ctrlKey || event.metaKey || event.altKey || /^F([2-9]|1[0-2])$/.test(event.key)) {
      event.stopImmediatePropagation();
      return;
    }
    event.stopImmediatePropagation();
    if (event.target instanceof Element && event.target.matches('input, select, textarea')) return;
    let handled = true;
    switch (event.key) {
      case ' ': togglePlay(); break;
      case 'ArrowLeft': exec('demo_skip -10'); break;
      case 'ArrowRight': exec('demo_skip 10'); break;
      case 'ArrowUp': setSpeed(speedIndex + 1); break;
      case 'ArrowDown': setSpeed(speedIndex - 1); break;
      case 'Home': seekToFraction(0); break;
      case 'End': seekToFraction(1); break;
      case '+': case '=': exec('zoom+'); break;
      case '-': exec('zoom-'); break;
      case '#': exec('zoom'); break;
      case 'e': case 'E': setEntities(!entities); break;
      case 'k': case 'K': setKeys(!keys); break;
      case 'Escape': close(); break;
      default:
        if (/^[0-9]$/.test(event.key)) seekToFraction(Number(event.key) / 10);
        else handled = false;
    }
    if (handled) event.preventDefault();
  }, true);

  for (const type of ['keyup', 'keypress']) {
    document.addEventListener(type, (event) => event.stopImmediatePropagation(), true);
  }

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick']) {
    document.addEventListener(type, (event) => {
      if (event.target !== $('canvas')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  $('canvas').addEventListener('contextmenu', (event) => event.preventDefault());

  // The client asks for pointer lock; a viewer has no use for it and browsers
  // throw when a page is not focused (or when this runs in an iframe).
  Element.prototype.requestPointerLock = function () { return Promise.resolve(); };

  // ---------- start ---------------------------------------------------------------------

  // The statistics page can reload (or the cross-origin-isolation service worker
  // can reload this page) at any time, and then it has forgotten which player it
  // was talking to. Say hello until a demo arrives, so both orders work; the
  // attempts are bounded so a stray tab does not chatter forever.
  let helloPoll = null;
  function sayHello() {
    if (!host) return;
    post({ type: 'hello' });
    let tries = 0;
    helloPoll = setInterval(() => {
      if (pendingDemo || demoStarted || ++tries > 60) stopHello();
      else post({ type: 'hello' });
    }, 500);
  }
  function stopHello() {
    if (helloPoll === null) return;
    clearInterval(helloPoll);
    helloPoll = null;
  }

  // Shown in the console so an old, already-open player can be told apart from
  // the current code when someone reports a bug.
  console.log('[replay] build 20261029h');
  sayHello();
  boot();
})();
