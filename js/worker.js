/*
 * Runs the heavy parsing in a background thread ("Web Worker") so the page stays responsive.
 * Analogy: the page is the front-of-house waiter, the worker is the kitchen. The waiter hands
 * over the order (the file), keeps smiling at the customer, and gets called when the food is ready.
 */
importScripts('huffman.js', 'snapshot.js', 'demo-parser.js', 'freeze-analyzer.js', 'map-reader.js', 'heat-analyzer.js', 'save-analyzer.js', 'team-analyzer.js', 'jump-analyzer.js', 'emote-analyzer.js');

self.onmessage = async (event) => {
  try {
    const buffer = event.data.buffer;

    // The fun page only needs the silly counters. Skipping the map, heat and save
    // collectors makes it much quicker on big demos (no map unpacking).
    if (event.data.funOnly) {
      const jumps = new DDA.JumpCollector();
      const emotes = new DDA.EmoteCollector();
      const { header, skipped } = DDA.parseDemo(
        buffer,
        (tick, snap) => {
          jumps.onSnapshot(tick, snap);
          emotes.onSnapshot(tick, snap);
        },
        (fraction) => self.postMessage({ type: 'progress', fraction }),
        (tick, msg) => emotes.onMessage(tick, msg)
      );
      self.postMessage({ type: 'done', header, skipped, fun: { jumps: jumps.result(), emotes: emotes.result() } });
      return;
    }

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
    // The fun page reuses these collectors so it does not have to parse the demo
    // again when the user jumps over from here. They are cheap: the emote and jump
    // collectors only decode a client's name when its ClientInfo actually changes.
    const jumps = new DDA.JumpCollector();
    const emotes = new DDA.EmoteCollector();
    const { header, skipped } = DDA.parseDemo(
      buffer,
      (tick, snap) => {
        freeze.onSnapshot(tick, snap);
        saves.onSnapshot(tick, snap);
        teams.onSnapshot(tick, snap);
        heat.onSnapshot(tick, snap, freeze);
        jumps.onSnapshot(tick, snap);
        emotes.onSnapshot(tick, snap);
      },
      (fraction) => self.postMessage({ type: 'progress', fraction }),
      (tick, msg) => { teams.onMessage(tick, msg); emotes.onMessage(tick, msg); }
    );
    freeze.finish();
    saves.finish();
    const teamData = teams.result();
    self.postMessage({
      type: 'done', header, skipped,
      ...freeze.result(), ...saves.result(),
      teamsRecorded: teamData.teamsRecorded, teamPlayers: teamData.teamPlayers,
      heat: heat.result(), heatError,
      fun: { jumps: jumps.result(), emotes: emotes.result() },
    });
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
