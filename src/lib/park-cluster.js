'use strict';
// src/lib/park-cluster.js — ONE PARK PAGE FOR THE WHOLE CLUSTER (Jeff, 2026-11-02):
//   "Address: park.ether-cast.com/<cluster slug>, e.g. park.ether-cast.com/ov. The slug comes from the cluster's name,
//    which the user sets in Ether. It's editable, unique across accounts, and nothing is baked in. Sign in once with
//    name + PIN, then a station selector at the top lists that cluster's stations. Everything on the page follows the
//    selected station … Remember the last station picked per login. Roles still apply per station. Old per-station Park
//    links keep working: they redirect to the cluster page with that station already selected."
//
// THE CLUSTER is the account's handle — licenses.account_slug, set in Ether's Station Manager (name + handle), unique
// across accounts, changeable with a breadcrumb in account_slug_history (the listen hub's rules, unchanged). Its
// stations are that license's published stations (station_metadata.public_enabled with a slug).
//
// A CLUSTER LOGIN is a park_sessions row with station_uuid NULL: one sign-in for the account. It is still checked on
// EVERY station request (park-auth.sessionVerdict with the station's license): good only for a station of the same
// account, and logged out by the same three things as before (Log out, PIN change, user removed). A station-bound
// session (an old per-station login) keeps working on its own station only.
//
// Pure: index.js does the lookups. Every branch is pinned by park-cluster.test.js.

/**
 * What park.ether-cast.com/<name> is.
 * @param {string} name                          the first path segment, lower case
 * @param {{slug:string}|null} cluster           a license whose account_slug = name
 * @param {{slug:string}|null} renamedCluster    a license whose OLD account_slug = name (its current slug)
 * @param {{slug:string, clusterSlug:string|null}|null} station  a published station whose slug (or old slug) = name,
 *                                               with its account's current handle (null = the account has none)
 * @returns {{kind:'cluster', cluster:string}
 *          |{kind:'redirect', cluster:string, station:string|null}
 *          |{kind:'station', station:string}
 *          |{kind:'not_found'}}
 */
function resolveParkName(name, cluster, renamedCluster, station) {
  if (!name) return { kind: 'not_found' };
  // The cluster's own name first: it is unique across accounts, and the handle check refuses a name another account's
  // station already uses (index.js), so a cluster name never hides someone else's station link.
  if (cluster && cluster.slug) return { kind: 'cluster', cluster: cluster.slug };
  if (renamedCluster && renamedCluster.slug) return { kind: 'redirect', cluster: renamedCluster.slug, station: null };
  if (station && station.slug) {
    // An old per-station link: the cluster page with that station selected — when the account has a cluster name.
    if (station.clusterSlug) return { kind: 'redirect', cluster: station.clusterSlug, station: station.slug };
    // No cluster name set yet: the station's own page, exactly as before (nothing is baked in).
    return { kind: 'station', station: station.slug };
  }
  return { kind: 'not_found' };
}

/**
 * Which station the page opens on: the one the link asked for, else the one this login picked last, else the first.
 * Only ever a station of this cluster.
 * @param {{slug:string}[]} stations
 * @param {{asked?:string|null, remembered?:string|null}} want
 */
function pickStation(stations, { asked = null, remembered = null } = {}) {
  const has = (s) => !!s && stations.some(x => x.slug === s);
  if (has(asked)) return asked;
  if (has(remembered)) return remembered;
  return stations.length ? stations[0].slug : null;
}

/** Is `name` free to be a cluster name for license `licenseId`? Refused when another account's published station uses
 *  it as its slug: the old station link would otherwise open somebody else's cluster. */
function clusterNameClash(stationRowsWithSlug, licenseId) {
  return stationRowsWithSlug.some(r => Number(r.license_key_id) !== Number(licenseId));
}

module.exports = { resolveParkName, pickStation, clusterNameClash };
