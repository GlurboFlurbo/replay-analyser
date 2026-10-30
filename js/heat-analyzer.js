/*
 * Turns a stream of snapshots into a per-player heat grid: for every map tile,
 * how many ticks each player spent there, and how many of those ticks they were
 * frozen.
 *
 * Analogy: the demo is CCTV footage and the map is a floor plan. Instead of
 * keeping the footage, we only tally "how long did each person stand on each
 * floor tile" - a few kilobytes, and enough for a chokepoint heatmap.
 *
 * Sampling: 10 times per second (every 5th tick), each sample counts as 5 ticks.
 * A player moving at full speed can skip a tile between samples, but for "where
 * did we spend time" that is invisible; the alternative (every tick) would be
 * ten times the work for no visible difference.
 *
 * Storage is sparse on purpose: a full tile array per player would be megabytes
 * on big maps (some are 900x900 tiles), while a Map only holds the visited tiles.
 * In practice that is a few thousand entries per player.
 *
 * The frozen flag comes from FreezeCollector, which already decides whether a
 * character is frozen at that tick (it owns that protocol knowledge).
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const MAX_CLIENTS = 64;
  const TILE = 32;    // character x/y are in pixels, 32 per tile
  const SAMPLE = 5;   // ticks between samples (10 Hz)

  class HeatCollector {
    /** @param {{width:number,height:number,grid:Uint8Array}|null} map */
    constructor(map) {
      this.map = map;
      this.time = new Map();   // name -> Map(tile index -> ticks spent)
      this.frozen = new Map(); // name -> Map(tile index -> ticks of that spent frozen)
    }

    onSnapshot(tick, snap, freeze) {
      if (!this.map || tick % SAMPLE !== 0 || freeze.charType < 0) return;
      const width = this.map.width, height = this.map.height;
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const ch = snap.get(DDA.TYPE_CHARACTER, cid);
        if (!ch) continue;
        const name = freeze.names[cid];
        if (!name) continue;
        const tx = Math.floor(ch[1] / TILE), ty = Math.floor(ch[2] / TILE);
        if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
        let time = this.time.get(name), frozen = this.frozen.get(name);
        if (!time) {
          time = new Map();
          frozen = new Map();
          this.time.set(name, time);
          this.frozen.set(name, frozen);
        }
        const at = ty * width + tx;
        time.set(at, (time.get(at) || 0) + SAMPLE);
        if (freeze.frozenNow[cid]) frozen.set(at, (frozen.get(at) || 0) + SAMPLE);
      }
    }

    /** Plain data for the UI: only the tiles that were visited, as (tile, time, frozen) triples. */
    result() {
      if (!this.map) return null;
      return {
        width: this.map.width,
        height: this.map.height,
        grid: this.map.grid,
        sampleTicks: SAMPLE,
        players: [...this.time].map(([name, time]) => {
          const frozen = this.frozen.get(name);
          const cells = [];
          for (const [tile, ticks] of time) {
            cells.push(tile, ticks, (frozen && frozen.get(tile)) || 0);
          }
          return { name, cells: Uint32Array.from(cells) };
        }),
      };
    }
  }

  DDA.HeatCollector = HeatCollector;
})(globalThis);
