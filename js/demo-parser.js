/*
 * Reads a DDNet ".demo" file and replays it as a stream of (tick, snapshot) events.
 *
 * File layout:
 *   header (176 bytes) | timeline markers (260) | [sha256 extension (48), version >= 6]
 *   | embedded map file | chunks ...
 *
 * Chunks are the "flip-book pages". A chunk starts with one byte:
 *   bit 7 set   -> tick marker ("the clock moved")
 *   bit 7 clear -> data chunk; bits 5-6 = type (1 snapshot, 2 message, 3 delta), bits 0-4 = size
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const TICKS_PER_SECOND = 50;
  const HEADER_SIZE = 176;
  const TIMELINE_SIZE = 4 + 64 * 4;
  const SHA256_EXTENSION = [
    0x6b, 0xe6, 0xda, 0x4a, 0xce, 0xbd, 0x38, 0x0c, 0x9b, 0x5b, 0x12, 0x89, 0xc8, 0x42, 0xd7, 0x80,
  ];

  const TICKMARKER = 0x80, TICK_COMPRESSED = 0x20, MASK_TICK = 0x1f, MASK_TICK_LEGACY = 0x3f;
  const MASK_TYPE = 0x60, MASK_SIZE = 0x1f;
  const CHUNK_SNAPSHOT = 1, CHUNK_MESSAGE = 2, CHUNK_DELTA = 3;

  const utf8 = new TextDecoder('utf-8');
  function cString(bytes, off, max) {
    let len = 0;
    while (len < max && bytes[off + len] !== 0) len++;
    return utf8.decode(bytes.subarray(off, off + len));
  }

  /** Reads one varint at `p`; returns {v, p} (value, position after) or null when truncated. */
  function readVarint(bytes, p) {
    let v = 0, shift = 0;
    for (let k = 0; k < 5 && p < bytes.length; k++) {
      const b = bytes[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) return { v: v | 0, p };
    }
    return null;
  }

  function readVarints(bytes, from) {
    const out = [];
    let p = from;
    while (p < bytes.length) {
      const r = readVarint(bytes, p);
      if (!r) break;
      out.push(r.v);
      p = r.p;
    }
    return out;
  }

  /**
   * Decodes one recorded game message. The first varint is the header:
   *   0   -> extended message: [0][16-byte uuid][varint payload]
   *   else -> plain message: [(type << 1)][varint payload]
   * Plain payloads can contain raw string bytes after the ints, so only the
   * integers up to the first string are meaningful; extended payloads are pure ints.
   * Returns {uuid, id, ints} or null.
   */
  function decodeMessage(bytes) {
    const h = readVarint(bytes, 0);
    if (!h) return null;
    if (h.v === 0) {
      if (bytes.length < 17) return null;
      let uuid = '';
      for (let i = 1; i <= 16; i++) uuid += bytes[i].toString(16).padStart(2, '0');
      return { uuid, id: -1, ints: readVarints(bytes, 17) };
    }
    return { uuid: null, id: h.v >> 1, ints: readVarints(bytes, h.p) };
  }

  /**
   * @param {ArrayBuffer} buffer      the whole demo file
   * @param {(tick:number, snap:Snapshot)=>void} onSnapshot  called once per decoded snapshot
   * @param {(fraction:number)=>void} [onProgress]
   * @param {(tick:number, msg:{uuid:string|null, id:number, ints:number[]})=>void} [onMessage]
   *        called once per recorded game message (only when provided)
   * @returns {{header:object, skipped:number}}
   */
  /**
   * Reads just the 176-byte header and locates the embedded map. Separate from
   * parseDemo because the heatmap needs the map *before* the snapshot stream
   * starts, and unpacking a map is asynchronous.
   */
  function readHeader(buffer) {
    const d = new Uint8Array(buffer);
    const view = new DataView(buffer);

    if (d.length < HEADER_SIZE || cString(d, 0, 7) !== 'TWDEMO') {
      throw new Error('This is not a Teeworlds/DDNet demo file.');
    }
    const header = {
      version: d[7],
      netVersion: cString(d, 8, 64),
      mapName: cString(d, 72, 64),
      mapSize: view.getInt32(136),            // DataView defaults to big-endian, like the file
      type: cString(d, 144, 8),
      lengthSeconds: view.getInt32(152),
      timestamp: cString(d, 156, 20),
    };
    if (header.type !== 'client') {
      // Server-side demos ("server") also work, but flag anything unexpected.
      header.note = 'demo type: ' + header.type;
    }

    let pos = HEADER_SIZE + TIMELINE_SIZE;
    if (header.version >= 6 && SHA256_EXTENSION.every((b, i) => d[pos + i] === b)) pos += 16 + 32;
    header.mapOffset = pos;
    if (header.mapSize < 0 || pos + header.mapSize > d.length) {
      throw new Error('This demo is incomplete (its embedded map does not fit in the file).');
    }
    return header;
  }

  function parseDemo(buffer, onSnapshot, onProgress, onMessage) {
    const d = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const header = readHeader(buffer);
    let pos = header.mapOffset + header.mapSize; // the map is embedded; the heatmap reads it separately

    const huffman = new DDA.Huffman();
    const huffmanOut = new Uint8Array(1 << 20);
    const intsOut = new Int32Array(1 << 18);
    const snapshot = new DDA.Snapshot();

    let tick = -1;
    let haveFull = false;
    let skipped = 0;
    let chunkCount = 0;

    while (pos < d.length) {
      const c = d[pos++];

      if (c & TICKMARKER) {
        if (header.version < 5 && (c & MASK_TICK_LEGACY) !== 0) tick += c & MASK_TICK_LEGACY;
        else if (c & TICK_COMPRESSED) tick += c & MASK_TICK;   // small jump stored inline
        else { tick = view.getInt32(pos); pos += 4; }          // absolute tick in 4 bytes
        continue;
      }

      const type = (c & MASK_TYPE) >> 5;
      let size = c & MASK_SIZE;
      if (size === 30) size = d[pos++];
      else if (size === 31) { size = d[pos] | (d[pos + 1] << 8); pos += 2; }
      const start = pos;
      pos += size;

      if (size === 0) continue;

      if (type === CHUNK_MESSAGE) {
        if (onMessage) {
          try {
            const nb = huffman.decompress(d, start, start + size, huffmanOut);
            const ni = DDA.varIntDecompress(huffmanOut, nb, intsOut);
            // The recorder compressed the message as little-endian int32s; rebuild the bytes.
            const msgBytes = new Uint8Array(ni * 4);
            const msgView = new DataView(msgBytes.buffer);
            for (let i = 0; i < ni; i++) msgView.setInt32(i << 2, intsOut[i], true);
            const msg = decodeMessage(msgBytes);
            if (msg) onMessage(tick, msg);
          } catch (e) { /* broken messages are dropped, like broken snapshots */ }
        }
        continue;
      }
      if (type !== CHUNK_SNAPSHOT && type !== CHUNK_DELTA) continue;

      try {
        // Two decompression layers: Huffman (bytes) -> varint (32-bit ints)
        const bytes = huffman.decompress(d, start, start + size, huffmanOut);
        const ints = DDA.varIntDecompress(huffmanOut, bytes, intsOut);
        if (type === CHUNK_SNAPSHOT) { snapshot.loadFull(intsOut, ints); haveFull = true; }
        else {
          if (!haveFull) throw new Error('delta before first full snapshot');
          snapshot.applyDelta(intsOut, ints);
        }
        onSnapshot(tick, snapshot);
      } catch (e) {
        skipped++; // broken snapshots are skipped, just like the real game client does
      }

      if (onProgress && (++chunkCount & 0x3ff) === 0) onProgress(pos / d.length);
    }
    if (onProgress) onProgress(1);
    return { header, skipped };
  }

  DDA.TICKS_PER_SECOND = TICKS_PER_SECOND;
  DDA.readHeader = readHeader;
  DDA.parseDemo = parseDemo;
  DDA.decodeMessage = decodeMessage;
})(globalThis);
