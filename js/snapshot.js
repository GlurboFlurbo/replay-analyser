/*
 * A Snapshot is one frozen moment of the game world: a bag of "items"
 * (every player, projectile, pickup ...). Each item is identified by a key made of
 * (type, id) and holds an array of 32-bit integers.
 *
 * Analogy: a full snapshot is a photograph; a delta is a "spot the difference" note
 * ("item X changed by +3 here, item Y vanished"). To see the world at time T you keep
 * the latest photo and apply every note since.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  // Number of ints per item type for the classic protocol (0 = size is stored in the stream).
  const STATIC_SIZES = [0, 10, 6, 5, 4, 3, 8, 4, 15, 22, 5, 17, 3, 2, 2, 2, 2, 3, 3, 3, 3];
  const TYPE_EX = 0;               // items that map a private type id -> UUID
  const OFFSET_UUID_TYPE = 0x4000; // extension type ids start here
  const TYPE_CHARACTER = 9;        // position, velocity, hook tip ...
  const TYPE_PLAYER_INFO = 10;     // [playerFlags, local, team, ...]; team < 0 = spectating
  const TYPE_CLIENT_INFO = 11;     // name, clan, skin ...

  // Field layout of a player info item (see STATIC_SIZES above).
  const PLAYER_TEAM = 2;           // -1 = spectating, 0 = FFA, >0 = team number

  // Field layout of a character item (see STATIC_SIZES above).
  const CHAR_X = 1, CHAR_Y = 2;
  const CHAR_HOOKED_PLAYER = 8;   // -1 = hook not attached to anyone, else the client id
  const CHAR_HOOK_X = 11, CHAR_HOOK_Y = 12; // hook tip: rests in the owner's tee when idle
  const CHAR_ATTACK_TICK = 21;    // tick of this player's last weapon swing

  const key = (type, id) => (type << 16) | id;

  class Snapshot {
    constructor() {
      this.items = new Map(); // key -> Int32Array
    }

    get(type, id) {
      return this.items.get(key(type, id));
    }

    /** Full snapshot layout: [dataSize][numItems][offsets * numItems][item data ...] */
    loadFull(d, len) {
      const dataSize = d[0];
      const numItems = d[1];
      const dataStart = 2 + numItems;
      if (numItems < 0 || dataStart + dataSize / 4 > len) throw new Error('bad snapshot');

      const map = new Map();
      for (let i = 0; i < numItems; i++) {
        const start = dataStart + d[2 + i] / 4;
        const end = i + 1 < numItems ? dataStart + d[3 + i] / 4 : dataStart + dataSize / 4;
        map.set(d[start], Int32Array.from(d.subarray(start + 1, end))); // d[start] = key
      }
      this.items = map;
    }

    /**
     * Delta layout: [numDeleted][numUpdated][0][deleted keys ...][updates ...]
     * Each update: [type][id]([size] if type has no fixed size)[values ...]
     * For items that already exist, the values are DIFFERENCES to the old values.
     */
    applyDelta(d, len) {
      const numDeleted = d[0];
      const numUpdated = d[1];
      let p = 3;
      if (numDeleted < 0 || numUpdated < 0 || p + numDeleted > len) throw new Error('bad delta');

      const deleted = d.slice(p, p + numDeleted);
      p += numDeleted;

      // Pass 1: read + validate everything WITHOUT touching our state, so that a corrupt
      // delta cannot leave us with a half-updated world (DDNet also drops broken snapshots).
      const updates = [];
      for (let i = 0; i < numUpdated; i++) {
        if (p + 2 > len) throw new Error('bad delta item');
        const type = d[p++];
        const id = d[p++];
        let size = type >= 0 && type < STATIC_SIZES.length ? STATIC_SIZES[type] : 0;
        if (size === 0) size = d[p++];        // extension items carry their own size
        if (size < 0 || p + size > len) throw new Error('bad delta item');

        const k = key(type, id);
        const old = this.items.get(k);
        const now = new Int32Array(size);
        if (old === undefined) {
          for (let j = 0; j < size; j++) now[j] = d[p + j];           // brand new: stored as-is
        } else {
          if (old.length !== size) throw new Error('item size changed');
          for (let j = 0; j < size; j++) now[j] = (old[j] + d[p + j]) | 0; // wraps like C++ int
        }
        updates.push(k, now);
        p += size;
      }

      // Pass 2: apply.
      for (let i = 0; i < deleted.length; i++) this.items.delete(deleted[i]);
      for (let i = 0; i < updates.length; i += 2) this.items.set(updates[i], updates[i + 1]);
    }

    /**
     * Finds the private type id the recorder gave to an extension UUID (or -1).
     * `uuidInts` = the 16 UUID bytes as 4 big-endian int32s.
     */
    findExtensionType(uuidInts) {
      for (const [k, data] of this.items) {
        if (k >>> 16 === TYPE_EX && (k & 0xffff) >= OFFSET_UUID_TYPE && data.length >= 4 &&
            data[0] === uuidInts[0] && data[1] === uuidInts[1] &&
            data[2] === uuidInts[2] && data[3] === uuidInts[3]) {
          return k & 0xffff;
        }
      }
      return -1;
    }

    /** True if the item announcing `extType` still carries this UUID (cheap sanity check). */
    extensionStillValid(extType, uuidInts) {
      const data = this.items.get(key(TYPE_EX, extType));
      return data !== undefined && data.length >= 4 &&
        data[0] === uuidInts[0] && data[1] === uuidInts[1] &&
        data[2] === uuidInts[2] && data[3] === uuidInts[3];
    }
  }

  DDA.Snapshot = Snapshot;
  DDA.TYPE_CLIENT_INFO = TYPE_CLIENT_INFO;
  DDA.TYPE_CHARACTER = TYPE_CHARACTER;
  DDA.TYPE_PLAYER_INFO = TYPE_PLAYER_INFO;
  DDA.PLAYER_TEAM = PLAYER_TEAM;
  DDA.CHAR_X = CHAR_X;
  DDA.CHAR_Y = CHAR_Y;
  DDA.CHAR_HOOKED_PLAYER = CHAR_HOOKED_PLAYER;
  DDA.CHAR_HOOK_X = CHAR_HOOK_X;
  DDA.CHAR_HOOK_Y = CHAR_HOOK_Y;
  DDA.CHAR_ATTACK_TICK = CHAR_ATTACK_TICK;
})(globalThis);
