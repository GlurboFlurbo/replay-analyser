/*
 * Counts air jumps ("double jumps") per player, for fun.
 *
 * The server sends its own jump counter in the DDNetCharacter extension:
 *   m_JumpedTotal - number of air jumps since the player last touched the ground.
 * It goes up by one for every jump made in mid-air and resets to 0 on the ground,
 * so we only have to remember the last value per client and add the increases.
 * That also means the first jump from the ground is NOT counted - only the second
 * one (and any further air jumps on maps that allow them).
 *
 * The field is -1 in demos from servers that do not provide jump display data, and
 * older extension items can be shorter. Both cases simply count nothing and set
 * `available` to false, so the page can say so instead of showing a wrong zero.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_CLIENTS = 64;
  // "character@netobj.ddnet.tw", the same extension freeze-analyzer.js uses.
  const DDNET_CHARACTER_UUID = [1993229659, -102024632, -1378361269, -1810037668];
  const CHAR_JUMPED_TOTAL = 5; // field index in DDNetCharacter

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

  class JumpCollector {
    constructor() {
      this.charType = -1;
      this.names = new Array(MAX_CLIENTS).fill(null);
      this.infoRefs = new Array(MAX_CLIENTS).fill(null); // ClientInfo array last decoded per client
      this.lastTotal = new Array(MAX_CLIENTS).fill(-1);
      this.players = new Map(); // name -> { name, double, first, last }
      this.available = false;   // at least one character reported m_JumpedTotal
      this.firstTick = -1;
      this.lastTick = -1;
    }

    onSnapshot(tick, snap) {
      if (this.firstTick < 0) this.firstTick = tick;
      this.lastTick = tick;

      if (this.charType < 0 || !snap.extensionStillValid(this.charType, DDNET_CHARACTER_UUID)) {
        this.charType = snap.findExtensionType(DDNET_CHARACTER_UUID);
      }

      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const info = snap.get(DDA.TYPE_CLIENT_INFO, cid);
        // ClientInfo keeps the same array until it changes, so decoding every snapshot
        // would be waste; this loop already runs 64 times per snapshot.
        if (info && info !== this.infoRefs[cid]) {
          this.infoRefs[cid] = info;
          this.names[cid] = intsToString(info, 0, 4);
        }

        const ch = snap.get(DDA.TYPE_CHARACTER, cid);
        const ext = this.charType < 0 ? undefined : snap.get(this.charType, cid);
        if (!ch || !ext) {
          this.lastTotal[cid] = -1; // do not compare across gaps (spec, out of view)
          continue;
        }
        const name = this.names[cid];
        if (!name) continue;

        let p = this.players.get(name);
        if (!p) {
          p = { name, double: 0, first: tick, last: tick };
          this.players.set(name, p);
        } else {
          p.last = tick;
        }

        if (ext.length <= CHAR_JUMPED_TOTAL) continue;
        const total = ext[CHAR_JUMPED_TOTAL];
        if (total < 0) {
          this.lastTotal[cid] = -1;
          continue;
        }
        this.available = true;
        const prev = this.lastTotal[cid];
        this.lastTotal[cid] = total;
        if (prev < 0 || total <= prev) continue;
        p.double += total - prev;
      }
    }

    /** Plain data for the page; `first`/`last` are the ticks the player was visible. */
    result() {
      return {
        available: this.available,
        firstTick: this.firstTick,
        lastTick: this.lastTick,
        players: [...this.players.values()].sort((a, b) => b.double - a.double || a.name.localeCompare(b.name)),
      };
    }
  }

  DDA.JumpCollector = JumpCollector;
})(globalThis);
