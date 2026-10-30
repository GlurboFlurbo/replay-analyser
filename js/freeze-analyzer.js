/*
 * Collects every "freeze run" of every player: a continuous period during which the player
 * was unable to move. It does NOT decide what a "fail" is - that is the UI's job, because
 * then the threshold slider can change instantly without re-reading the 24 MB file.
 *
 * Analogy: every player has a stopwatch. It starts when they freeze and stops when they
 * thaw (or die/disconnect). We keep every lap; the website later decides which laps count.
 *
 * A run is NOT cut just because the tee briefly vanished or thawed (both are common
 * recording artefacts around one real fail):
 *   - The character item can disappear mid-freeze: the player spectates, or the tee
 *     leaves the recorder's view while hook-dragged. The server's freeze timer keeps
 *     running, so a tee that comes back still frozen is the SAME freeze wherever it
 *     reappears - no position check needed (zytsen's hole bridging adds one, which
 *     splits legitimate drags where the frozen tee was pulled far).
 *   - A tee dragged across the edge of a freeze tile can thaw for a few ticks and be
 *     re-frozen instantly; that is one fail, not two.
 * Everything inside a run that was not observed frozen is summed into the run's "gaps"
 * field, so frozen-time totals stay correct while the wall-clock run stays one number.
 *
 * A run that starts right after the player stopped spectating (while still frozen) is
 * marked as a "continuation": it is the same freeze they entered before spectating, so
 * the UI does not count it as a new fail.
 *
 * Per player, the first and last tick they were seen with a character are recorded too -
 * the UI subtracts freeze time from that span to get time alive. Spectate / pause / AFK
 * intervals (from the DDNet player extension) are recorded as well, ready for an
 * "alive excluding pause/spec" metric.
 *
 * Run record: [startTick, ticks, deep, gaps, cont]
 *   startTick - first frozen tick
 *   ticks     - wall clock length (startTick -> close tick, including gaps)
 *   deep      - 1 if any of it was deep freeze
 *   gaps      - ticks inside the run that were not observed frozen (bridged holes)
 *   cont      - 1 = continuation of a freeze entered before spectating (not a new fail)
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_CLIENTS = 64;
  const DDNET_CHAR_FLAGS = 0;
  const DDNET_CHAR_FREEZE_END = 1;
  const FLAG_MOVEMENTS_DISABLED = 1 << 20; // "live freeze"

  // How long a run survives without being seen frozen:
  const HOLE_MAX = 250;  // character vanished (spec / out of view / death) for <= 5 s
  const DRAG_MAX = 25;   // visibly thawed for <= 0.5 s (drag over a freeze edge)
  const CONT_TICKS = 150; // a frozen run opening <= 3 s after unspecing = same freeze

  // UUID of "character@netobj.ddnet.tw" as 4 big-endian int32s. DDNet derives it as
  // md5(namespace + name) with version bits patched; browsers have no MD5, so it's precomputed.
  const DDNET_CHARACTER_UUID = [1993229659, -102024632, -1378361269, -1810037668];
  // UUID of "player@netobj.ddnet.tw": one int of state flags for the player.
  const DDNET_PLAYER_UUID = [583701389, 327171627, -1636052395, -1901674991];
  const DDNET_PLAYER_FLAG_AFK = 1 << 0;
  const DDNET_PLAYER_FLAG_PAUSED = 1 << 1;
  const DDNET_PLAYER_FLAG_SPEC = 1 << 2;

  // Player states, numbered like zytsen's analyzer so the data is comparable.
  const STATE_AFK = 1, STATE_PAUSE = 2, STATE_SPEC = 3;

  const utf8 = new TextDecoder('utf-8');

  /** Names are packed 4 characters per int, each stored as (char + 128). */
  function intsToString(ints, from, count) {
    const bytes = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) {
      const v = ints[from + i];
      bytes[i * 4] = ((v >>> 24) & 0xff) - 128;
      bytes[i * 4 + 1] = ((v >>> 16) & 0xff) - 128;
      bytes[i * 4 + 2] = ((v >>> 8) & 0xff) - 128;
      bytes[i * 4 + 3] = (v & 0xff) - 128;
    }
    bytes[bytes.length - 1] = 0;
    let len = 0;
    while (len < bytes.length && bytes[len] !== 0) len++;
    return utf8.decode(bytes.subarray(0, len));
  }

  class FreezeCollector {
    constructor() {
      this.charType = -1;
      this.playerType = -1;
      this.names = new Array(MAX_CLIENTS).fill(null);
      this.open = new Array(MAX_CLIENTS).fill(null); // running stopwatch per client id
      this.frozenNow = new Uint8Array(MAX_CLIENTS);  // per client id: frozen at the current snapshot?
      this.players = new Map();                      // name -> array of run records
      this.presence = new Map();                     // name -> { first, last } ticks with a character
      this.zStates = [];                             // { name, from, to, code } spec/pause/afk intervals
      this.zOpen = new Array(MAX_CLIENTS).fill(null); // open interval per client id
      this.pendingCont = new Array(MAX_CLIENTS).fill(false); // spec began while a run was open
      this.contDue = new Array(MAX_CLIENTS).fill(-Infinity); // unspec tick + CONT_TICKS
      this.firstTick = -1;
      this.lastTick = -1;
    }

    onSnapshot(tick, snap) {
      if (this.firstTick < 0) this.firstTick = tick;
      this.lastTick = tick;

      // Cheap check first; only rescan all items if the type mapping changed.
      if (this.charType < 0 || !snap.extensionStillValid(this.charType, DDNET_CHARACTER_UUID)) {
        this.charType = snap.findExtensionType(DDNET_CHARACTER_UUID);
      }
      if (this.playerType < 0 || !snap.extensionStillValid(this.playerType, DDNET_PLAYER_UUID)) {
        this.playerType = snap.findExtensionType(DDNET_PLAYER_UUID);
      }

      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const info = snap.get(DDA.TYPE_CLIENT_INFO, cid);
        if (info) this.names[cid] = intsToString(info, 0, 4);

        const ch = this.charType < 0 ? undefined : snap.get(this.charType, cid);
        let frozen = false, deep = false;
        if (ch) {
          const freezeEnd = ch[DDNET_CHAR_FREEZE_END];
          // freezeEnd == -1 -> deep freeze; freezeEnd > tick -> freeze timer still running
          deep = freezeEnd === -1;
          frozen = deep || freezeEnd > tick || (ch[DDNET_CHAR_FLAGS] & FLAG_MOVEMENTS_DISABLED) !== 0;
          const name = this.names[cid];
          if (name) {
            let p = this.presence.get(name);
            if (p) p.last = tick; else this.presence.set(name, { first: tick, last: tick });
          }
        }

        this._zState(tick, snap, cid);
        this.frozenNow[cid] = frozen && ch !== undefined ? 1 : 0;
        this._advanceRun(tick, cid, frozen, deep, ch !== undefined);
      }
    }

    /**
     * Tracks AFK / pause / spectating per client id and arms the "spec continuation"
     * flag. The state comes from the DDNet player extension; when a server does not
     * send it, a negative team in PlayerInfo still reveals spectating (zytsen's rule).
     */
    _zState(tick, snap, cid) {
      const px = this.playerType < 0 ? undefined : snap.get(this.playerType, cid);
      const pi = snap.get(DDA.TYPE_PLAYER_INFO, cid);
      const f = px ? px[0] : 0;
      const team = pi ? pi[DDA.PLAYER_TEAM] : 0;
      const code = (f & DDNET_PLAYER_FLAG_SPEC) || team < 0 ? STATE_SPEC
        : (f & DDNET_PLAYER_FLAG_PAUSED) ? STATE_PAUSE
        : (f & DDNET_PLAYER_FLAG_AFK) ? STATE_AFK : 0;

      const open = this.zOpen[cid];
      if (open && open.code !== code) {
        const name = this.names[cid];
        if (name) this.zStates.push({ name, from: open.since, to: tick, code: open.code });
        this.zOpen[cid] = null;
        if (open.code === STATE_SPEC && this.pendingCont[cid]) {
          // Stopped spectating: the freeze they come back to is the one they left.
          this.contDue[cid] = tick + CONT_TICKS;
          this.pendingCont[cid] = false;
        }
      }
      if ((!open || open.code !== code) && code !== 0) {
        if (code === STATE_SPEC) this.pendingCont[cid] = this.open[cid] !== null;
        this.zOpen[cid] = { code, since: tick };
      }
    }

    /**
     * Opens, bridges and closes freeze runs (see the file header for the rules).
     * Closing is DELAYED: a run that stops being observed frozen stays open while we
     * wait to see whether the tee comes back, and is then closed at the first tick it
     * was actually gone - so the hole never shows up in the run's length.
     */
    _advanceRun(tick, cid, frozen, deep, present) {
      const run = this.open[cid];
      if (frozen) {
        if (!run) {
          const r = {
            start: tick, deep, gaps: 0, since: null, unfrozen: false, cont: false,
            name: this.names[cid] || 'client ' + cid,
          };
          if (tick <= this.contDue[cid]) { r.cont = true; this.contDue[cid] = -Infinity; }
          this.open[cid] = r;
        } else {
          if (run.since !== null) { // came back still frozen: the hole was one gap
            run.gaps += tick - run.since;
            run.since = null;
            run.unfrozen = false;
          }
          if (deep) run.deep = true;
        }
      } else if (run) {
        if (run.since === null) run.since = tick;
        if (present) run.unfrozen = true;
        if (tick - run.since > HOLE_MAX || (run.unfrozen && tick - run.since > DRAG_MAX)) {
          this._close(cid, run.since);
        }
      }
    }

    _close(cid, endTick) {
      const run = this.open[cid];
      this.open[cid] = null;
      if (!this.players.has(run.name)) this.players.set(run.name, []);
      this.players.get(run.name).push([
        run.start, endTick - run.start, run.deep ? 1 : 0, run.gaps, run.cont ? 1 : 0,
      ]);
    }

    /** Call after the demo ended so stopwatches still running are not lost. */
    finish() {
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const run = this.open[cid];
        if (run) this._close(cid, run.since !== null ? run.since : this.lastTick);
        const z = this.zOpen[cid];
        if (z && this.names[cid]) this.zStates.push({ name: this.names[cid], from: z.since, to: this.lastTick, code: z.code });
      }
    }

    /** Plain data (structured-clone friendly) for the UI. */
    result() {
      return {
        firstTick: this.firstTick,
        lastTick: this.lastTick,
        players: [...this.players].map(([name, runs]) => ({ name, runs })),
        presence: [...this.presence].map(([name, p]) => ({ name, first: p.first, last: p.last })),
        zStates: this.zStates,
      };
    }
  }

  // Shared with other collectors (save-analyzer.js) so the protocol knowledge lives in one place.
  DDA.FreezeCollector = FreezeCollector;
  DDA.intsToString = intsToString;
  DDA.DDNET_CHARACTER_UUID = DDNET_CHARACTER_UUID;
  DDA.DDNET_CHAR_FLAGS = DDNET_CHAR_FLAGS;
  DDA.DDNET_CHAR_FREEZE_END = DDNET_CHAR_FREEZE_END;
  DDA.FLAG_MOVEMENTS_DISABLED = FLAG_MOVEMENTS_DISABLED;
  DDA.DDNET_PLAYER_UUID = DDNET_PLAYER_UUID;
  DDA.DDNET_PLAYER_FLAG_AFK = DDNET_PLAYER_FLAG_AFK;
  DDA.DDNET_PLAYER_FLAG_PAUSED = DDNET_PLAYER_FLAG_PAUSED;
  DDA.DDNET_PLAYER_FLAG_SPEC = DDNET_PLAYER_FLAG_SPEC;
  DDA.FREEZE_HOLE_MAX = HOLE_MAX;
  DDA.FREEZE_DRAG_MAX = DRAG_MAX;
})(globalThis);
