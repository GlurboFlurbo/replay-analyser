/*
 * Collects "saves": one player helping another out of freeze - either by hammering them
 * free, keeping them hooked while frozen for a total of ~3 seconds, or standing back and
 * re-grabbing their hook until they thaw (updown).
 *
 * Like FreezeCollector it does NOT decide what counts as a save. It emits every candidate
 * together with the freeze run it belongs to; the UI applies the threshold slider (and
 * keeps only one save per run) when rendering, so the sliders stay instant.
 *
 * Signals used (all verified against the sample demos and DDNet's source):
 *   - Hammer: event items (type 16) carry the impact position but no attacker id. The
 *     victim is the nearest OPEN freeze run (the snapshot usually already shows the
 *     victim thawed - the swing is what freed them). The saviour is the player whose
 *     m_AttackTick (character field 21) says they swung 1-2 ticks ago; the impact lies
 *     near the victim, so a plain "nearest player" would pick the victim themselves.
 *     A hit only counts if the victim's freeze really ended within a few ticks of it.
 *   - Hook: character field 8 (m_HookedPlayer) names the hooked player directly - far
 *     more reliable than guessing from the tip position. NOTE: DDNet auto-releases a
 *     hook grab on a player after 1.25 s (gamecore.cpp, m_HookTick), so nobody can hold
 *     continuously for 3 s - savers re-hook, and we count the total hooked ticks during
 *     one freeze run.
 *   - Updown: a player stands a few tiles back and re-grabs the frozen victim's hook
 *     over and over until they thaw. We count the separate grabs per freeze run: at
 *     least two by the same player, with the last grab still attached (or auto-released
 *     less than a second ago) when the thaw hits. Whether the rescue really worked is
 *     the UI's survival slider, same as every other save type.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_CLIENTS = 64;
  const HAMMER_EVENT = 16;        // event item: [impactX, impactY]
  const HAMMER_GRACE = 5;         // the freeze must end within this many ticks of the hit
  const HAMMER_RANGE = 120;       // max distance from the impact to victim and saviour
  const EVENT_LAG = 3;            // hammer events can land this many ticks after the thaw
  const ATTACK_GAP_MIN = 1;       // the event is recorded 1-2 ticks after the swing ...
  const ATTACK_GAP_MAX = 2;       // ... (server tick vs. snapshot tick)
  // Runs close DELAYED (we wait out short holes before giving up on a freeze), so a
  // hammer hit must survive until the run it freed actually closes. Closing happens at
  // most DRAG_MAX ticks after the thaw for a visible thaw (a hole-closed run was not
  // seen thawing at all, so it is never a hammer save), plus the event lag for swings
  // whose event lands just after the thaw.
  const HIT_KEEP = HAMMER_GRACE + EVENT_LAG + DDA.FREEZE_DRAG_MAX + 2;
  const HOOK_HOLD_TICKS = 150;    // 3 s of hooked ticks during one freeze run -> hook save
  const UPDOWN_MIN_GRABS = 2;     // separate grabs by one player = "hooking repeatedly"
  const UPDOWN_END_GRACE = 50;    // last grab must be within 1 s of the thaw (under the
                                  // 1.25 s auto-release, so the hooking ran "until unfrozen")

  class SaveCollector {
    constructor() {
      this.charType = -1;
      this.names = new Array(MAX_CLIENTS).fill(null);
      this.open = new Array(MAX_CLIENTS).fill(null); // open freeze run per client id
      this.prevHooked = new Int32Array(MAX_CLIENTS).fill(-1); // hook target last snapshot
      this.hits = [];           // hammer events young enough to still end a freeze
      this.pending = [];        // runs that just closed, waiting for a late hammer event
      this.saves = [];
      this.lastTick = -1;
    }

    onSnapshot(tick, snap) {
      this.lastTick = tick;
      if (this.charType < 0 || !snap.extensionStillValid(this.charType, DDA.DDNET_CHARACTER_UUID)) {
        this.charType = snap.findExtensionType(DDA.DDNET_CHARACTER_UUID);
      }

      // Read the world: who is where, who hooked whom, who is frozen.
      const world = new Array(MAX_CLIENTS).fill(null);
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const info = snap.get(DDA.TYPE_CLIENT_INFO, cid);
        if (info) this.names[cid] = DDA.intsToString(info, 0, 4);

        const ch = snap.get(DDA.TYPE_CHARACTER, cid);
        if (!ch) continue;
        const ext = this.charType < 0 ? undefined : snap.get(this.charType, cid);
        const freezeEnd = ext ? ext[DDA.DDNET_CHAR_FREEZE_END] : 0;
        const deep = ext ? freezeEnd === -1 : false;
        const isFrozen = ext !== undefined &&
          (deep || freezeEnd > tick || (ext[DDA.DDNET_CHAR_FLAGS] & DDA.FLAG_MOVEMENTS_DISABLED) !== 0);
        world[cid] = {
          x: ch[DDA.CHAR_X], y: ch[DDA.CHAR_Y],
          hooked: ch[DDA.CHAR_HOOKED_PLAYER], atk: ch[DDA.CHAR_ATTACK_TICK],
          frozen: isFrozen, deep, fe: freezeEnd, hasExt: ext !== undefined,
        };
      }

      // Hammers first: the runs must still be open (the thaw they caused is applied below).
      this._hammers(tick, snap, world);
      this._advanceRuns(tick, world);
      this._hooks(tick, world);

      // Hits must live until the delayed close of the run they freed; closed runs past
      // the event lag can no longer be claimed by a late event.
      if (this.hits.length) this.hits = this.hits.filter((h) => tick - h.tick <= HIT_KEEP);
      if (this.pending.length) this.pending = this.pending.filter((p) => tick - p.end <= EVENT_LAG);
    }

    /**
     * Attributes every hammer swing of this tick to a victim and a saviour.
     * The victim is the nearest candidate among OPEN freeze runs and runs that just
     * closed: the snapshot usually already shows the victim thawed (the swing is what
     * freed them), and DDNet sometimes queues the event 1-3 ticks after that.
     */
    _hammers(tick, snap, world) {
      for (let id = 0; id < MAX_CLIENTS; id++) {
        const ev = snap.get(HAMMER_EVENT, id);
        if (!ev) continue;

        // Nearest victim candidate: an open run, or a freshly closed one (event lag).
        let best = HAMMER_RANGE, winCid = -1, winPending = -1;
        for (let cid = 0; cid < MAX_CLIENTS; cid++) {
          const run = this.open[cid];
          if (!run) continue;
          const d = Math.hypot(run.x - ev[0], run.y - ev[1]);
          if (d < best) { best = d; winCid = cid; winPending = -1; }
        }
        for (let i = 0; i < this.pending.length; i++) {
          const p = this.pending[i];
          if (tick - p.end > EVENT_LAG) continue;
          const d = Math.hypot(p.x - ev[0], p.y - ev[1]);
          if (d < best) { best = d; winPending = i; winCid = -1; }
        }
        if (winCid < 0 && winPending < 0) continue; // swung at nobody we track

        const exclude = winCid >= 0 ? winCid : this.pending[winPending].cid;
        const saviour = this._findSaviour(tick, world, ev, exclude);
        if (saviour < 0) continue; // nobody nearby could have swung it
        const saviourName = this.names[saviour] || 'client ' + saviour;

        if (winPending >= 0) {
          // The event arrived after its run closed - claim the save right now.
          const p = this.pending.splice(winPending, 1)[0];
          this.saves.push({
            tick, type: 'hammer', savior: saviourName, victim: p.name,
            start: p.start, end: p.end, deep: p.deep, hold: 0,
          });
        } else {
          this.hits.push({ tick, victim: winCid, saviour: saviourName });
        }
      }
    }

    /**
     * Who swung the hammer at this impact? Prefer the player whose m_AttackTick says
     * they swung 1-2 ticks ago; the impact sits near the VICTIM, so "nearest player"
     * alone would often pick the victim themselves. Frozen tees cannot swing.
     */
    _findSaviour(tick, world, ev, excludeCid) {
      let saviour = -1, best = HAMMER_RANGE;
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        if (cid === excludeCid) continue;
        const w = world[cid];
        if (!w || w.frozen || this.open[cid]) continue;
        const gap = tick - w.atk;
        if (gap < ATTACK_GAP_MIN || gap > ATTACK_GAP_MAX) continue;
        const d = Math.hypot(w.x - ev[0], w.y - ev[1]);
        if (d < best) { best = d; saviour = cid; }
      }
      if (saviour >= 0) return saviour;

      // No attack tick found (packet skew): fall back to the nearest standing player.
      best = HAMMER_RANGE;
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        if (cid === excludeCid) continue;
        const w = world[cid];
        if (!w || w.frozen || this.open[cid]) continue;
        const d = Math.hypot(w.x - ev[0], w.y - ev[1]);
        if (d < best) { best = d; saviour = cid; }
      }
      return saviour;
    }

    /**
     * Opens/closes freeze runs with the same rules as FreezeCollector, plus position:
     * a run that stops being observed frozen stays open while we wait to see whether
     * the tee comes back (spec / out of view <= 5 s, or a visible thaw <= 0.5 s), and
     * is closed at the first tick it was actually gone - so hammer events and hook
     * holds are matched against the same runs the UI counts.
     */
    _advanceRuns(tick, world) {
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const w = world[cid];
        const run = this.open[cid];
        if (w && w.frozen && !run) {
          this.open[cid] = {
            start: tick, deep: w.deep, x: w.x, y: w.y, fe: w.fe, held: new Map(),
            since: null, unfrozen: false, present: true,
            name: this.names[cid] || 'client ' + cid,
          };
        } else if (w && w.frozen && run) {
          if (run.since !== null) { run.since = null; run.unfrozen = false; }
          if (w.deep) run.deep = true;
          run.x = w.x;
          run.y = w.y;
          run.fe = w.fe;
        } else if (run) {
          if (run.since === null) run.since = tick;
          run.present = !!(w && w.hasExt); // what the world shows when we decide to close
          if (w && w.hasExt) run.unfrozen = true;
          if (tick - run.since > DDA.FREEZE_HOLE_MAX ||
              (run.unfrozen && tick - run.since > DDA.FREEZE_DRAG_MAX)) {
            this._close(cid, run.since, run.present);
          }
        }
      }
    }

    /**
     * A freeze run ended: look for the save that ended it.
     * `present` is false when the character (or its DDNet extension) vanished instead of
     * thawing - death or disconnect, never a hammer save.
     */
    _close(cid, endTick, present) {
      const run = this.open[cid];
      this.open[cid] = null;

      // Hammer: only a hit that actually freed them counts (deep freezes thaw on their
      // own when you leave the tile, so they are never a hammer save).
      if (present && !run.deep) {
        let hit = null;
        for (const h of this.hits) {
          if (h.victim !== cid) continue;
          // The run closes late, so the freeing swing can sit a few ticks on either
          // side of the closing tick: before it (normal), or after it (DDNet queues
          // the event into a later snapshot than the thaw).
          const gap = endTick - h.tick;
          if (gap < -EVENT_LAG || gap > HAMMER_GRACE) continue;
          if (!hit || h.tick > hit.tick) hit = h; // the blow closest to the thaw
        }
        if (hit) {
          this.saves.push({
            tick: hit.tick, type: 'hammer', savior: hit.saviour, victim: run.name,
            start: run.start, end: endTick, deep: run.deep ? 1 : 0, hold: 0,
          });
        } else if ((run.fe || 0) - endTick > HAMMER_GRACE) {
          // The freeze timer said they should still be frozen - a late hammer event
          // (DDNet queues events into a later snapshot) may be the freeing swing.
          this.pending.push({
            cid, start: run.start, end: endTick, x: run.x, y: run.y,
            name: run.name, deep: run.deep ? 1 : 0,
          });
        }
      }

      // Hook: the player who kept them hooked for at least HOOK_HOLD_TICKS during this run.
      let saviour = null, ticks = 0, first = endTick;
      for (const [name, h] of run.held) {
        if (h.ticks > ticks) { saviour = name; ticks = h.ticks; first = h.first; }
      }
      if (saviour !== null && ticks >= HOOK_HOLD_TICKS) {
        this.saves.push({
          tick: first, type: 'hook', savior: saviour, victim: run.name,
          start: run.start, end: endTick, deep: run.deep ? 1 : 0, hold: ticks,
        });
      }

      // Updown: somebody re-grabbed the victim over and over and was still on them
      // (or let go less than UPDOWN_END_GRACE ago) when the thaw happened, but never
      // racked up HOOK_HOLD_TICKS - the classic updown rescue. Same run may also
      // carry a hammer/hook candidate; the UI keeps one save per run.
      let up = null;
      for (const [name, h] of run.held) {
        if (h.grabs < UPDOWN_MIN_GRABS || endTick - h.last > UPDOWN_END_GRACE) continue;
        if (!up || h.grabs > up.h.grabs || (h.grabs === up.h.grabs && h.ticks > up.h.ticks)) {
          up = { name, h };
        }
      }
      if (up) {
        this.saves.push({
          tick: up.h.first, type: 'updown', savior: up.name, victim: run.name,
          start: run.start, end: endTick, deep: run.deep ? 1 : 0, hold: up.h.ticks,
        });
      }
    }

    /**
     * Counts, per open freeze run, how long each player kept the victim hooked and
     * how many separate grabs they took (for updown detection). Demos carry one
     * snapshot per 2 game ticks, so holds are summed as tick deltas rather than
     * per-snapshot increments, and a release shorter than that is invisible.
     */
    _hooks(tick, world) {
      for (let a = 0; a < MAX_CLIENTS; a++) {
        const wa = world[a];
        const target = wa ? wa.hooked : -1;   // -1 = not hooked to anyone
        const prev = this.prevHooked[a];
        this.prevHooked[a] = target;
        if (!wa || wa.frozen) continue; // a frozen player is not saving anyone
        const v = target;
        if (v < 0 || v >= MAX_CLIENTS) continue;
        const wv = world[v];
        if (!wv || !wv.frozen) continue; // the hooked player must be frozen
        const run = this.open[v];
        if (!run) continue;
        const name = this.names[a] || 'client ' + a;
        const h = run.held.get(name);
        if (h) {
          h.ticks += tick - h.last;
          h.last = tick;
          if (prev !== v) h.grabs++;   // released and grabbed again
        } else {
          run.held.set(name, { first: tick, ticks: 0, last: tick, grabs: 1 });
        }
      }
    }

    /** Call after the demo ended so runs still going are not lost. */
    finish() {
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const run = this.open[cid];
        if (run) this._close(cid, run.since !== null ? run.since : this.lastTick, false);
      }
    }

    /** Plain data (structured-clone friendly) for the UI. */
    result() {
      return { saves: this.saves };
    }
  }

  DDA.SaveCollector = SaveCollector;
})(globalThis);
