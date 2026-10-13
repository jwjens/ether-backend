'use strict';
// src/lib/park-sound.js — the Park page's sound fader stays steady (Jeff, 2026-10-13: "The fader and MUTE randomly
// disappear and show 'The station hasn't reported its sound level yet', then come back").
//
// WHY IT VANISHED. The page reads the station's mirrored ops_config row (uuid "ops"), and every install that has the
// station open pushes that WHOLE row every 60 s. HalloVeen is open on two machines: OVEVENTS (current build — sends
// the park's level, closing_today, cart_playing and pushed_at) and ovowforestmusic (older build — sends only
// closing + local_date). Last write wins, so once a minute the older push replaced the row and the level was gone
// until the next current-build push. Watched live 11:05–11:08Z: a level-less row at :20 every minute.
//
// THE RULE (opsConfigWrite). An ops row WITHOUT pushed_at comes from a build older than the Park sound controls. While a
// current-build report is fresh (CURRENT_FRESH_MS), that older row is ignored — the current build is the one that
// knows the park's sound. When no current build has reported for that long, the older row applies, but the last known
// park level is kept so the page can still show the fader (greyed, "Station offline" when the owner is not connected).
//
// ONLINE (ownerOnline). The fader works by sending a command to the station's owning machine (the sticky
// source_machine_id every Park command is aimed at). It is "online" exactly when that machine has its command
// connection open — the same test that decides whether a Park command can be delivered.
//
// Pure: no DB, no clock of its own. Pinned by park-sound.test.js.

const CURRENT_FRESH_MS = 180 * 1000;   // three missed 60 s pushes

/**
 * @param {object|null} existing  the stored ops row payload (or null)
 * @param {object} incoming       the row this push sends
 * @param {number} now            ms
 * @returns {{ write: object|null, reason: string }}  write = the payload to store, or null to keep the stored row
 */
function opsConfigWrite(existing, incoming, now) {
  if (incoming && incoming.pushed_at) return { write: incoming, reason: 'current_build' };
  const at = existing && existing.pushed_at ? Date.parse(existing.pushed_at) : NaN;
  if (Number.isFinite(at) && now - at < CURRENT_FRESH_MS) return { write: null, reason: 'older_build_ignored' };
  const write = { ...(incoming || {}) };
  if (existing && existing.park && typeof existing.park === 'object' && write.park == null) write.park = existing.park;
  return { write, reason: 'older_build_applied' };
}

/**
 * @param {Iterable<{machineId?:string|null, writableEnded?:boolean}>} clients  the license's open command connections
 * @param {string|null} ownerMachineId  the station's sticky source_machine_id
 */
function ownerOnline(clients, ownerMachineId) {
  const id = typeof ownerMachineId === 'string' ? ownerMachineId.trim() : '';
  if (!id) return false;
  for (const c of clients || []) if (c && !c.writableEnded && c.machineId === id) return true;
  return false;
}

module.exports = { opsConfigWrite, ownerOnline, CURRENT_FRESH_MS };
