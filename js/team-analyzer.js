/*
 * Knows which players were part of a DDNet team during the demo.
 *
 * Team membership is NOT in snapshots (the vanilla PlayerInfo m_Team field is only
 * 0/-1). The server sends it as the Sv_TeamsState message: one int per client slot
 * (up to 128 on modern servers, 64 on older ones), where >0 is a team number and
 * 0 means "not in a team". The message arrives on join, leave and team change.
 *
 * A player counts as being in a team once their slot showed one at any point while
 * their name occupied it, so people who were only spectating/bystanding (team 0)
 * can be kept out of the statistics.
 */
(function (g) {
  const DDA = (g.DDA = g.DDA || {});

  const TYPE_CLIENT_INFO = 11;
  const MAX_CLIENTS = 128;
  // Sv_TeamsState as an extended message (verified in demo recordings):
  // payload = [0 header][16-byte uuid][one varint per client slot].
  const TEAMSSTATE_UUID = 'a091961a95e83744bb605eac9bd563c6';

  class TeamCollector {
    constructor() {
      this.names = new Array(MAX_CLIENTS).fill(null);
      this.slotTeam = new Array(MAX_CLIENTS).fill(0);
      this.everTeam = new Map(); // player name -> highest team number seen
      this.recorded = false;     // true once at least one Sv_TeamsState arrived
    }

    onSnapshot(tick, snap) {
      for (let cid = 0; cid < MAX_CLIENTS; cid++) {
        const info = snap.get(TYPE_CLIENT_INFO, cid);
        if (!info) continue;
        const name = DDA.intsToString(info, 0, 4);
        if (name && name !== this.names[cid]) {
          this.names[cid] = name;
          this._fold(cid); // slot already has a team? attribute it to the new name
        }
      }
    }

    onMessage(tick, msg) {
      if (msg.uuid !== TEAMSSTATE_UUID) return;
      this.recorded = true;
      const pl = msg.ints;
      for (let cid = 0; cid < pl.length && cid < MAX_CLIENTS; cid++) {
        const team = pl[cid];
        this.slotTeam[cid] = team >= 0 ? team : 0; // negative = see-others sentinel
        this._fold(cid);
      }
    }

    _fold(cid) {
      const team = this.slotTeam[cid], name = this.names[cid];
      if (team > 0 && name && (this.everTeam.get(name) || 0) < team) {
        this.everTeam.set(name, team);
      }
    }

    /** Plain data (structured-clone friendly) for the UI. */
    result() {
      return {
        teamsRecorded: this.recorded,
        teamPlayers: Object.fromEntries(this.everTeam),
      };
    }
  }

  DDA.TeamCollector = TeamCollector;
  DDA.TEAMSSTATE_UUID = TEAMSSTATE_UUID;
})(globalThis);
