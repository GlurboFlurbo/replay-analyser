/*
 * Runs the heavy parsing in a background thread ("Web Worker") so the page stays responsive.
 * Analogy: the page is the front-of-house waiter, the worker is the kitchen. The waiter hands
 * over the order (the file), keeps smiling at the customer, and gets called when the food is ready.
 */
importScripts('huffman.js', 'snapshot.js', 'demo-parser.js', 'freeze-analyzer.js', 'map-reader.js', 'heat-analyzer.js', 'save-analyzer.js', 'team-analyzer.js');

self.onmessage = async (event) => {
  try {
    const buffer = event.data.buffer;

    // The heatmap needs the map before the snapshot stream starts, and unpacking
    // it is asynchronous (the browser's own zlib), hence the header read first.
    const info = DDA.readHeader(buffer);
    let map = null, heatError = null;
    if (info.mapSize > 0) {
      try {
        map = await DDA.readMap(new Uint8Array(buffer, info.mapOffset, info.mapSize));
      } catch (err) {
        heatError = err && err.message ? err.message : String(err);
      }
    } else {
      heatError = 'this demo has no embedded map';
    }

    const freeze = new DDA.FreezeCollector();
    const saves = new DDA.SaveCollector();
    const teams = new DDA.TeamCollector();
    const heat = new DDA.HeatCollector(map);
    const { header, skipped } = DDA.parseDemo(
      buffer,
      (tick, snap) => {
        freeze.onSnapshot(tick, snap);
        saves.onSnapshot(tick, snap);
        teams.onSnapshot(tick, snap);
        heat.onSnapshot(tick, snap, freeze);
      },
      (fraction) => self.postMessage({ type: 'progress', fraction }),
      (tick, msg) => teams.onMessage(tick, msg)
    );
    freeze.finish();
    saves.finish();
    const teamData = teams.result();
    self.postMessage({
      type: 'done', header, skipped,
      ...freeze.result(), ...saves.result(),
      teamsRecorded: teamData.teamsRecorded, teamPlayers: teamData.teamPlayers,
      heat: heat.result(), heatError,
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
