/*
 * Counts emote bubbles per player and per emote type, for fun.
 *
 * The server broadcasts Sv_Emoticon (regular game message 10) whenever a player
 * picks an emote from the wheel:
 *   [m_ClientId, m_Emoticon]
 * The demo stores that message verbatim, so the exact emote is known - nothing
 * is guessed from animations. m_Emoticon is an index into EMOTES (0..15).
 *
 * Two things are deliberately NOT counted:
 *   - the facial expression in DDNetCharacter.m_Emote (NORMAL/PAIN/HAPPY/...),
 *     which is mostly automatic (pain on a hit, happy on hearts, and so on);
 *   - messages whose client id has no name yet. Those are counted separately in
 *     `unresolved` instead of being given to the wrong player.
 *
 * Caveat: with default DDNet spam protection, an emote repeated within three
 * seconds is only sent to nearby players instead of everyone. A demo therefore
 * contains the emotes the recording client received, which is the same "only
 * what the recorder saw" rule the rest of the analyzer follows.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_CLIENTS = 64;
  const SV_EMOTICON = 10;

  // Same order as the DDNet protocol enum (datasrc/network.py, Emoticons).
  const EMOTES = Object.freeze([
    'OOP', 'EXCLAMATION', 'HEARTS', 'DROP', 'DOTDOT', 'MUSIC', 'SORRY', 'GHOST',
    'SUSHI', 'SPLATTEE', 'DEVILTEE', 'ZOMG', 'ZZZ', 'WTF', 'EYES', 'QUESTION',
  ]);

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

  class EmoteCollector {
    constructor() {
      this.names = new Array(MAX_CLIENTS).fill(null);
      this.infoRefs = new Array(MAX_CLIENTS).fill(null); // ClientInfo array last decoded per client
      this.players = new Map(); // name -> { name, counts: number[16], total }
      this.total = 0;           // attributed emotes
      this.unresolved = 0;      // emotes from a client id with no known name
    }

    onSnapshot(tick, snap) {
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const info = snap.get(DDA.TYPE_CLIENT_INFO, cid);
        // ClientInfo keeps the same array until it changes, so decoding it on every
        // snapshot would be pure waste (and this runs for all 64 slots each time).
        if (info && info !== this.infoRefs[cid]) {
          this.infoRefs[cid] = info;
          this.names[cid] = intsToString(info, 0, 4);
        }
      }
    }

    onMessage(tick, msg) {
      if (msg.uuid || msg.id !== SV_EMOTICON || msg.ints.length < 2) return;

      const clientId = msg.ints[0];
      const emoticon = msg.ints[1];
      if (clientId < 0 || clientId >= MAX_CLIENTS) return;
      if (emoticon < 0 || emoticon >= EMOTES.length) return;

      const name = this.names[clientId];
      if (!name) {
        this.unresolved++;
        return;
      }

      let p = this.players.get(name);
      if (!p) {
        p = { name, counts: new Array(EMOTES.length).fill(0), total: 0 };
        this.players.set(name, p);
      }
      p.counts[emoticon]++;
      p.total++;
      this.total++;
    }

    /** Plain data for the page; players are sorted by emote count. */
    result() {
      return {
        total: this.total,
        unresolved: this.unresolved,
        types: EMOTES.slice(),
        players: [...this.players.values()]
          .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
      };
    }
  }

  DDA.EMOTES = EMOTES;
  DDA.EmoteCollector = EmoteCollector;
})(globalThis);
