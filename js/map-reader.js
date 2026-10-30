/*
 * Reads the map that every DDNet demo carries inside itself, so the heatmap can
 * draw a background without downloading anything.
 *
 * The map is a small binary file (magic "DATA") holding named items (images,
 * layers, envelopes). The only thing we need is the *game layer*: one tile id per
 * tile, where 1 = solid, 9 = freeze, 11 = deep freeze, ...
 *
 * Analogy: the demo is a folder and the map is a PDF stapled inside it. All the
 * numbers are in a flat index, so this file is mostly "follow the offsets".
 *
 * The item layout below was checked against real maps: using it, 100% of the
 * character positions from the demo land inside the map and none land inside a
 * solid tile.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_TILES = 4096;   // sanity limit: no DDNet map is anywhere near this
  const LAYER_ITEM = 5;     // item type of a tile layer
  const FIELD_WIDTH = 4;    // int index of m_Width inside a layer item
  const FIELD_HEIGHT = 5;
  const FIELD_FLAGS = 6;    // bit 0 set on the one layer that is the game layer
  const FIELD_DATA = 14;    // index into the map's data chunks
  const FLAG_GAME = 1;

  /** Inflates one zlib stream with the browser's own decompressor (async, but native). */
  async function inflate(bytes) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('this browser cannot unpack the map');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /**
   * @param {Uint8Array} bytes the embedded map file (a view into the demo buffer)
   * @returns {Promise<{width:number, height:number, grid:Uint8Array}>}
   */
  async function readMap(bytes) {
    if (bytes.byteLength < 36) throw new Error('the map is empty');
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    if (magic !== 'DATA') throw new Error('the map has no DATA header');

    const m = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const I = (offset) => m.getInt32(offset, true); // map files are little-endian

    const numItemTypes = I(16);
    const numItems = I(20);
    const numData = I(24);
    const itemSize = I(28);
    const dataSize = I(32);
    if (numItems <= 0 || numItems > 100000 || numData <= 0 || numData > 100000 ||
        itemSize < 0 || dataSize < 0) {
      throw new Error('the map header is damaged');
    }

    let p = 36 + 12 * numItemTypes;
    if (p + 4 * numItems > bytes.byteLength) throw new Error('the map item table is damaged');
    const itemOffsets = [];
    for (let i = 0; i < numItems; i++) itemOffsets.push(I(p + 4 * i));
    p += 4 * numItems;

    if (p + 4 * numData > bytes.byteLength) throw new Error('the map data table is damaged');
    const dataOffsets = [];
    for (let i = 0; i < numData; i++) dataOffsets.push(I(p + 4 * i));
    p += 4 * numData;
    // Version 4 maps store one more int per data chunk (uncompressed sizes).
    if (I(4) === 4) p += 4 * numData;

    const itemStart = p;
    const dataStart = itemStart + itemSize;
    if (dataStart > bytes.byteLength) throw new Error('the map items are damaged');

    let layer = null;
    for (let i = 0; i < numItems && !layer; i++) {
      const s = itemStart + itemOffsets[i];
      if (itemOffsets[i] < 0 || s + 8 > dataStart) continue;
      const type = I(s) >>> 16;
      const ints = I(s + 4) >> 2;
      if (type !== LAYER_ITEM || ints <= FIELD_DATA) continue;
      if (s + 8 + 4 * (FIELD_DATA + 1) > dataStart) continue;
      const field = (j) => I(s + 8 + 4 * j);
      if (!(field(FIELD_FLAGS) & FLAG_GAME)) continue; // background/front/tele layers are not it
      const width = field(FIELD_WIDTH), height = field(FIELD_HEIGHT);
      const dataIndex = field(FIELD_DATA);
      if (width <= 0 || height <= 0 || width > MAX_TILES || height > MAX_TILES) continue;
      if (dataIndex < 0 || dataIndex >= numData) continue;
      layer = { width, height, dataIndex };
    }
    if (!layer) throw new Error('the map has no game layer');

    const from = dataOffsets[layer.dataIndex];
    const to = layer.dataIndex + 1 < numData ? dataOffsets[layer.dataIndex + 1] : dataSize;
    if (from < 0 || to <= from || dataStart + to > bytes.byteLength) {
      throw new Error('the map layer data is damaged');
    }
    const chunk = new Uint8Array(bytes.buffer, bytes.byteOffset + dataStart + from, to - from);
    const raw = await inflate(chunk);
    const tiles = layer.width * layer.height;
    if (raw.length !== tiles * 4) throw new Error('the map layer has an unexpected size');

    // 4 bytes per tile; byte 0 is the tile id, the rest are flags we do not need.
    const grid = new Uint8Array(tiles);
    for (let k = 0; k < tiles; k++) grid[k] = raw[k * 4];
    return { width: layer.width, height: layer.height, grid };
  }

  DDA.readMap = readMap;
})(globalThis);
