'use strict';
// scripts/prove-editable-refs.js
//
// Proves the full EDITABLE station-scoped set remaps across divergent local ids: station_programming,
// pinned_songs, song_metadata_values, metadata_vocabulary, voice_tracks, station_programming_moods.
// Covers the two genuinely new mechanics on top of the already-proven generic remap:
//   (1) refs to INSTALL-scope tables (song_id → songs, mood_tag_id → mood_tags) — the borrowed-library
//       dependency: works only if those rows are present with stable UUIDs (modelled by seeding them
//       on both installs with the SAME uuid but DIFFERENT local ids);
//   (2) station_programming_moods — a join table with NO station_id: stays install-scoped, only its
//       two parent FKs are remapped.
// Real stack: REAL handlers + SyncEngine.push/pull + HttpTransport + router + MergeEngine.
//
// Run:  ELECTRON_RUN_AS_NODE=1 OPENAIR_DIR=/c/openair \
//       /c/openair/node_modules/electron/dist/electron.exe scripts/prove-editable-refs.js

const path = require('path');
const express = require('express');
const { newDb } = require('pg-mem');

process.env.SYNC_SERVER_ID = process.env.SYNC_SERVER_ID || 'prove-editable-refs';
const makeSyncRouter = require('../src/routes/sync');

const OPENAIR = process.env.OPENAIR_DIR || 'C:/openair';
const req = (p) => require(path.join(OPENAIR, p));
const Database        = req('node_modules/better-sqlite3');
const { SyncEngine }    = req('electron/sync/sync-engine');
const { HttpTransport } = req('electron/sync/transport-http');
const { REGISTRY }      = req('electron/sync/synced-tables');
const H = (n) => req('electron/sync/handlers/' + n);
const { stationsCreate } = H('stations');
const { categoriesCreate } = H('categories');
const { clocksCreate } = H('clocks');
const { clockSlotsCreate } = H('clock_slots');
const { showsCreate } = H('shows');
const { spAdd } = H('station_programming');
const { pinnedSongsCreate } = H('pinned_songs');
const { songMetadataValuesCreate } = H('song_metadata_values');
const { metadataDefinitionsCreate } = H('metadata_definitions');
const { metadataVocabularyCreate } = H('metadata_vocabulary');
const { voiceTracksCreate } = H('voice_tracks');
const { stationProgrammingMoodsCreate } = H('station_programming_moods');

const SV = 16, OV_ACCOUNT = 1;
const OV_UUID = 'OV-STATION', DJ_UUID = 'DJ-STATION';
const U = { song: 'U-song', mood: 'U-mood', cat: 'U-cat', clock: 'U-clock', slot: 'U-slot', show: 'U-show',
  def: 'U-def', vocab: 'U-vocab', sp: 'U-sp', pin: 'U-pin', smv: 'U-smv', vt: 'U-vt', moods: 'U-moods' };

const TABLES = ['stations','categories','clocks','clock_slots','shows','metadata_definitions',
  'metadata_vocabulary','station_programming','pinned_songs','song_metadata_values','voice_tracks',
  'station_programming_moods','songs','mood_tags'];
const INFRA_DDL = `
  CREATE TABLE schema_version (version INTEGER NOT NULL);
  CREATE TABLE client_identity (id INTEGER PRIMARY KEY CHECK (id = 1), client_id TEXT NOT NULL, created_at TEXT NOT NULL, label TEXT);
  CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE station_config_kv (station_id INTEGER, key TEXT, value TEXT);
  CREATE TABLE mutations (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, station_id TEXT, actor_id TEXT, table_name TEXT NOT NULL,
    row_id TEXT NOT NULL, op TEXT NOT NULL, payload_before TEXT, payload_after TEXT, created_at TEXT NOT NULL, applied_at TEXT NOT NULL,
    hlc TEXT NOT NULL, parent_mutation_id TEXT, schema_version INTEGER NOT NULL, origin TEXT NOT NULL, sync_status TEXT NOT NULL, conflict_resolution TEXT);
  CREATE TABLE quarantine_mutations (id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, foreign_schema_version INTEGER NOT NULL,
    local_schema_version INTEGER NOT NULL, received_at TEXT NOT NULL, drain_status TEXT NOT NULL DEFAULT 'pending', retry_count INTEGER NOT NULL DEFAULT 0, retry_after TEXT);
`;
function ddl(name) {
  const cols = { ...REGISTRY[name].columns };
  if (name === 'clock_slots') cols.song_id = 'scalar';   // handler writes it; not in the synced registry
  const INT = /(^id$|_id$|^position$|^priority$|^spins_per_hour$|^duration_min$|^is_active$|^start_hour$|^end_hour$|_bitrate$|_port$)/;
  return `CREATE TABLE ${name} (${Object.keys(cols).map(c => c === 'id' ? 'id INTEGER PRIMARY KEY AUTOINCREMENT'
    : c === 'uuid' ? 'uuid TEXT NOT NULL UNIQUE' : `${c} ${INT.test(c) ? 'INTEGER' : 'TEXT'}`).join(', ')});`;
}
const SYNCED_DDL = TABLES.map(ddl).join('\n');

function makeInstall(label, baseUrl) {
  const db = new Database(':memory:');
  db.exec(INFRA_DDL); db.exec(SYNCED_DDL);
  const clientId = require('crypto').randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SV);
  db.prepare('INSERT INTO client_identity (id, client_id, created_at, label) VALUES (1, ?, ?, ?)').run(clientId, now, label);
  db.prepare("INSERT INTO system_state (key, value, updated_at) VALUES ('hlc_last', ?, ?)").run(`0:0:${clientId}`, now);
  db.prepare("INSERT INTO station_config_kv (station_id, key, value) VALUES (1,'license_key',?)").run(`lk-${label}`);
  const engine = new SyncEngine(db, new HttpTransport(db, { baseUrl, licenseKey: `lk-${label}` }), {
    localSchemaVersion: SV, uuidIdentity: true,
    getStationId:   () => { const s = db.prepare('SELECT id FROM stations WHERE uuid=?').get(OV_UUID); return s ? String(s.id) : null; },
    getStationUuid: () => OV_UUID,
  });
  return { db, engine, clientId, label };
}
const mkStation = (db, uuid, name) => stationsCreate(db, { uuid, name, callsign: '', frequency: '', city: '', state: '', country: 'US',
  website: '', is_active: 0, icecast_server_url: '', icecast_mount: '', icecast_password: '', icecast_bitrate: 128, icecast_format: 'mp3' });
const seedSong = (db, id, uuid) => db.prepare('INSERT INTO songs (id, uuid, title) VALUES (?,?,?)').run(id, uuid, 'song-' + uuid);
const seedMood = (db, id, uuid) => db.prepare('INSERT INTO mood_tags (id, uuid, name) VALUES (?,?,?)').run(id, uuid, 'mood-' + uuid);
const localId = (db, t, uuid) => db.prepare(`SELECT id FROM ${t} WHERE uuid = ?`).get(uuid)?.id ?? null;
const get = (db, t, uuid) => db.prepare(`SELECT * FROM ${t} WHERE uuid = ?`).get(uuid);
const checks = []; const pass = (l, ok, d) => { checks.push(ok); console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${l}${d ? `  (${d})` : ''}`); };

(async () => {
  const pg = newDb();
  pg.public.none(`CREATE TABLE licenses (id SERIAL PRIMARY KEY, email TEXT)`);
  pg.public.none(`CREATE TABLE mutations (server_seq BIGSERIAL PRIMARY KEY, id TEXT, client_id TEXT, station_id TEXT, operator_id TEXT,
    license_key_id INTEGER, table_name TEXT, row_id TEXT, op TEXT, payload_before JSONB, payload_after JSONB, created_at TIMESTAMPTZ,
    hlc TEXT, parent_mutation_id TEXT, schema_version INTEGER, conflict_resolution JSONB, station_uuid TEXT, ref_uuids JSONB,
    CONSTRAINT u UNIQUE (license_key_id, id))`);
  pg.public.none(`CREATE TABLE library_grants (id SERIAL PRIMARY KEY, owner_license_id INTEGER, grantee_license_id INTEGER, created_at TIMESTAMPTZ DEFAULT NOW(), revoked_at TIMESTAMPTZ)`);
  const { Pool } = pg.adapters.createPg(); const pool = new Pool();
  await pool.query(`INSERT INTO licenses (id, email) VALUES (1,'ov-account')`);
  const app = express(); app.use(express.json());
  app.use((r, _res, next) => { r.license = { id: OV_ACCOUNT }; next(); });
  app.use('/sync', makeSyncRouter(pool));
  const server = app.listen(0); const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // ── OV authors the editable set (parents before children) ────────────────────
  const OV = makeInstall('OV', baseUrl);
  const ovSt = mkStation(OV.db, OV_UUID, 'OV').id;
  seedSong(OV.db, 1, U.song); seedMood(OV.db, 1, U.mood);          // install-scope library, local id 1 on OV
  const cat = categoriesCreate(OV.db, { uuid: U.cat, code: 'PG', name: 'PG', color: '#fff', spins_per_hour: 4, priority: 1, station_id: ovSt }).id;
  const clk = clocksCreate(OV.db, { uuid: U.clock, name: 'Drive', show_id: null, description: '', color: '#000', station_id: ovSt }).id;
  const slot = clockSlotsCreate(OV.db, { uuid: U.slot, clock_id: clk, position: 0, slot_type: 'category', category_id: cat, song_id: null, label: 's', duration_min: 3, spot_type: null, station_id: ovSt }).id;
  const shw = showsCreate(OV.db, { uuid: U.show, name: 'Show', start_hour: 6, end_hour: 10, days: 'MTWTF', color: '#0f0', description: '', is_active: 1, clock_id: clk, station_id: ovSt }).id;
  const def = metadataDefinitionsCreate(OV.db, { uuid: U.def, station_id: ovSt, name: 'Tempo', data_type: 'vocab', description: '', is_built_in: 0, is_required: 0, display_order: 0 }).id;
  const voc = metadataVocabularyCreate(OV.db, { uuid: U.vocab, station_id: ovSt, definition_id: def, value: 'Fast', display_order: 0, color: '#f00' }).id;
  spAdd(OV.db, { uuid: U.sp, song_id: 1, station_id: ovSt, category_id: cat });
  pinnedSongsCreate(OV.db, { uuid: U.pin, song_id: 1, slot_hour: 8, slot_position: 0, recur_dow: '', play_at_unix: 0, start_unix: 0, end_unix: 0, force_play: 1, pinned_by: 'jeff', reason: '', consumed_at: null, station_id: ovSt });
  songMetadataValuesCreate(OV.db, { uuid: U.smv, station_id: ovSt, song_id: 1, definition_id: def, value_text: null, value_vocabulary_id: voc });
  voiceTracksCreate(OV.db, { uuid: U.vt, title: 'VT', file_path: 'vt.mp3', show_id: shw, clock_slot_id: slot, duration_ms: 5000, recorded_by: 'dj', recorded_at: 0, station_id: ovSt });
  const spLocalOv = localId(OV.db, 'station_programming', U.sp);
  stationProgrammingMoodsCreate(OV.db, { uuid: U.moods, station_programming_id: spLocalOv, mood_tag_id: 1 });
  await OV.engine.push();
  console.log('=== OV authored the editable set (song & mood are install-scope local id 1)\n');

  // ── djdeniro: force EVERY parent onto a different local id (placeholders at id 1) ──
  const DJ = makeInstall('DJ', baseUrl);
  mkStation(DJ.db, DJ_UUID, 'DJ');                                  // DJ station → id 1
  for (const [t, u] of [['categories','PH-cat'],['clocks','PH-clk'],['clock_slots','PH-slot'],['shows','PH-show'],
                        ['metadata_definitions','PH-def'],['metadata_vocabulary','PH-voc'],['station_programming','PH-sp']]) {
    DJ.db.prepare(`INSERT INTO ${t} (uuid) VALUES (?)`).run(u);     // placeholder at local id 1 → OV's lands on 2+
  }
  seedSong(DJ.db, 1, 'DJ-own-song'); seedSong(DJ.db, 2, U.song);   // OV's song is local id 2 here (≠ OV's id 1)
  seedMood(DJ.db, 1, 'DJ-own-mood'); seedMood(DJ.db, 2, U.mood);   // OV's mood is local id 2 here
  DJ.db.prepare("UPDATE mutations SET sync_status='synced' WHERE sync_status='pending'").run();

  console.log('=== djdeniro pulls the editable set; assert every ref remapped to djdeniro\'s OWN local ids ===');
  await DJ.engine.pull();

  // djdeniro's local parent ids (all should be ≠ OV's because of the placeholders / seeds)
  const dj = {
    song: localId(DJ.db, 'songs', U.song), mood: localId(DJ.db, 'mood_tags', U.mood),
    cat: localId(DJ.db, 'categories', U.cat), show: localId(DJ.db, 'shows', U.show),
    slot: localId(DJ.db, 'clock_slots', U.slot), def: localId(DJ.db, 'metadata_definitions', U.def),
    voc: localId(DJ.db, 'metadata_vocabulary', U.vocab), sp: localId(DJ.db, 'station_programming', U.sp),
  };
  console.log(`   djdeniro local ids: song=${dj.song} mood=${dj.mood} cat=${dj.cat} show=${dj.show} slot=${dj.slot} def=${dj.def} vocab=${dj.voc} sp=${dj.sp}  (OV had these all at 1)`);

  const sp  = get(DJ.db, 'station_programming', U.sp);
  pass('station_programming.song_id → djdeniro song (install-scope ref)', sp && sp.song_id === dj.song, sp && `${sp.song_id} vs ${dj.song}`);
  pass('station_programming.category_id → djdeniro category', sp && sp.category_id === dj.cat, sp && `${sp.category_id} vs ${dj.cat}`);
  const pin = get(DJ.db, 'pinned_songs', U.pin);
  pass('pinned_songs.song_id → djdeniro song', pin && pin.song_id === dj.song, pin && `${pin.song_id} vs ${dj.song}`);
  const smv = get(DJ.db, 'song_metadata_values', U.smv);
  pass('song_metadata_values.song_id → djdeniro song', smv && smv.song_id === dj.song, smv && `${smv.song_id} vs ${dj.song}`);
  pass('song_metadata_values.definition_id → djdeniro definition', smv && smv.definition_id === dj.def, smv && `${smv.definition_id} vs ${dj.def}`);
  pass('song_metadata_values.value_vocabulary_id → djdeniro vocabulary', smv && smv.value_vocabulary_id === dj.voc, smv && `${smv.value_vocabulary_id} vs ${dj.voc}`);
  const voc2 = get(DJ.db, 'metadata_vocabulary', U.vocab);
  pass('metadata_vocabulary.definition_id → djdeniro definition', voc2 && voc2.definition_id === dj.def, voc2 && `${voc2.definition_id} vs ${dj.def}`);
  const vt = get(DJ.db, 'voice_tracks', U.vt);
  pass('voice_tracks.show_id → djdeniro show', vt && vt.show_id === dj.show, vt && `${vt.show_id} vs ${dj.show}`);
  pass('voice_tracks.clock_slot_id → djdeniro clock_slot', vt && vt.clock_slot_id === dj.slot, vt && `${vt.clock_slot_id} vs ${dj.slot}`);
  const moods = get(DJ.db, 'station_programming_moods', U.moods);
  pass('moods.station_programming_id → djdeniro station_programming', moods && moods.station_programming_id === dj.sp, moods && `${moods.station_programming_id} vs ${dj.sp}`);
  pass('moods.mood_tag_id → djdeniro mood (install-scope ref)', moods && moods.mood_tag_id === dj.mood, moods && `${moods.mood_tag_id} vs ${dj.mood}`);
  // moods is the no-station_id join table → it must have travelled as INSTALL-scope (station_uuid NULL on the hub)
  const moodsHub = (await pool.query(`SELECT station_uuid FROM mutations WHERE table_name='station_programming_moods' LIMIT 1`)).rows[0];
  pass('moods stayed INSTALL-scope on the hub (station_uuid NULL — scoping unchanged)', moodsHub && moodsHub.station_uuid == null, `station_uuid=${moodsHub && moodsHub.station_uuid}`);

  server.close();
  const ok = checks.every(Boolean);
  console.log(`\n=== RESULT: ${ok ? 'ALL editable refs remap correctly across divergent local ids ✅' : 'FAIL ❌'} ===`);
  process.exit(ok ? 0 : 1);
})().catch(e => { console.error('PROOF HARNESS ERROR:', e); process.exit(2); });
