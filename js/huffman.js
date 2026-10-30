/*
 * Huffman decoder for DDNet snapshot chunks.
 *
 * Analogy: a Morse-code table where common bytes get short codes and rare bytes get long
 * ones. DDNet ships one fixed table inside the game, so the demo only stores the codes.
 * We rebuild the exact same "decision tree" DDNet builds, then walk it bit by bit:
 * read a 0 -> go left, read a 1 -> go right, hit a leaf -> that's one decoded byte.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const EOF_SYMBOL = 256;   // special "message ends here" symbol
  const NUM_SYMBOLS = 257;  // 256 byte values + EOF

  // Copied from DDNet: src/engine/shared/huffman.cpp (bigger number = shorter code)
  const FREQ = [
    1 << 30, 4545, 2657, 431, 1950, 919, 444, 482, 2244, 617, 838, 542, 715, 1814, 304, 240, 754, 212, 647, 186,
    283, 131, 146, 166, 543, 164, 167, 136, 179, 859, 363, 113, 157, 154, 204, 108, 137, 180, 202, 176,
    872, 404, 168, 134, 151, 111, 113, 109, 120, 126, 129, 100, 41, 20, 16, 22, 18, 18, 17, 19,
    16, 37, 13, 21, 362, 166, 99, 78, 95, 88, 81, 70, 83, 284, 91, 187, 77, 68, 52, 68,
    59, 66, 61, 638, 71, 157, 50, 46, 69, 43, 11, 24, 13, 19, 10, 12, 12, 20, 14, 9,
    20, 20, 10, 10, 15, 15, 12, 12, 7, 19, 15, 14, 13, 18, 35, 19, 17, 14, 8, 5,
    15, 17, 9, 15, 14, 18, 8, 10, 2173, 134, 157, 68, 188, 60, 170, 60, 194, 62, 175, 71,
    148, 67, 167, 78, 211, 67, 156, 69, 1674, 90, 174, 53, 147, 89, 181, 51, 174, 63, 163, 80,
    167, 94, 128, 122, 223, 153, 218, 77, 200, 110, 190, 73, 174, 69, 145, 66, 277, 143, 141, 60,
    136, 53, 180, 57, 142, 57, 158, 61, 166, 112, 152, 92, 26, 22, 21, 28, 20, 26, 30, 21,
    32, 27, 20, 17, 23, 21, 30, 22, 22, 21, 27, 25, 17, 27, 23, 18, 39, 26, 15, 21,
    12, 18, 18, 27, 20, 18, 15, 19, 11, 17, 33, 12, 18, 15, 19, 18, 16, 26, 17, 18,
    9, 10, 25, 22, 22, 17, 20, 16, 6, 16, 15, 20, 14, 18, 24, 335, 1,
  ];

  class Huffman {
    constructor() {
      // children[node * 2 + bit] = the node you reach after reading `bit` at `node`
      this.children = new Int32Array(NUM_SYMBOLS * 2 * 2);

      // Ids 0..256 are the symbols (leaves). We repeatedly merge the two rarest
      // "pending" nodes into a new inner node (id 257, 258, ...) until one root remains.
      const pending = FREQ.map((frequency, nodeId) => ({ frequency, nodeId }));
      let next = NUM_SYMBOLS;
      while (pending.length > 1) {
        pending.sort((a, b) => b.frequency - a.frequency); // stable sort, biggest first
        const rarest = pending[pending.length - 1];
        const second = pending[pending.length - 2];
        this.children[next * 2] = rarest.nodeId;
        this.children[next * 2 + 1] = second.nodeId;
        second.nodeId = next;                 // "second" now stands for the merged pair
        second.frequency += rarest.frequency;
        pending.pop();
        next++;
      }
      this.root = next - 1;
    }

    /**
     * Decodes src[start..end) into dst, returns the number of bytes written.
     * Bits are consumed from the LOWEST bit of every byte upwards.
     */
    decompress(src, start, end, dst) {
      const ch = this.children;
      let out = 0;
      let node = this.root;
      for (let i = start; i < end; i++) {
        const b = src[i];
        for (let bit = 0; bit < 8; bit++) {
          node = ch[node * 2 + ((b >> bit) & 1)];
          if (node < NUM_SYMBOLS) {           // reached a leaf = one decoded symbol
            if (node === EOF_SYMBOL) return out;
            if (out === dst.length) throw new Error('Huffman output buffer too small');
            dst[out++] = node;
            node = this.root;                 // restart at the top for the next symbol
          }
        }
      }
      return out;
    }
  }

  /**
   * Second layer: DDNet's variable-length integers.
   * Small numbers take 1 byte, huge ones up to 5.
   *   first byte : bit7 = "more bytes follow", bit6 = sign, bits 0-5 = lowest 6 payload bits
   *   later bytes: bit7 = "more bytes follow", bits 0-6 = next 7 payload bits
   */
  const MASKS = [0x7f, 0x7f, 0x7f, 0x0f];
  const SHIFTS = [6, 13, 20, 27];

  function varIntDecompress(src, length, dst) {
    let i = 0;
    let out = 0;
    while (i < length) {
      let b = src[i++];
      const sign = (b >> 6) & 1;
      let value = b & 0x3f;
      for (let k = 0; k < 4; k++) {
        if ((b & 0x80) === 0) break;          // no continuation bit -> number complete
        if (i >= length) throw new Error('truncated varint');
        b = src[i++];
        value |= (b & MASKS[k]) << SHIFTS[k];
      }
      if (sign) value = ~value;               // negatives are stored as ~value
      if (out === dst.length) throw new Error('varint output buffer too small');
      dst[out++] = value;
    }
    return out;
  }

  DDA.Huffman = Huffman;
  DDA.varIntDecompress = varIntDecompress;
})(globalThis);
