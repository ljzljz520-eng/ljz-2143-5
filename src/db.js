'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return { salt, passwordHash: hash };
}

function verifyPassword(password, salt, expected) {
  const actual = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256');
  const expectedBuf = Buffer.from(expected, 'hex');
  return actual.length === expectedBuf.length && crypto.timingSafeEqual(actual, expectedBuf);
}

function token() { return crypto.randomBytes(32).toString('base64url'); }

function createDb(filename = ':memory:', { migrate = true } = {}) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (migrate) migrateDb(db);
  return db;
}

function migrateDb(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','admin','template_editor')),
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL,
    default_privacy TEXT NOT NULL DEFAULT 'busy_only' CHECK(default_privacy IN ('full_subject','busy_only')),
    background_url TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_grants (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('booker','viewer','template_editor')),
    granted_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_active_room_grants
    ON room_grants(room_id,user_id,role) WHERE revoked_at IS NULL;

  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    organizer_id INTEGER NOT NULL REFERENCES users(id),
    subject TEXT NOT NULL,
    startUtc INTEGER NOT NULL,
    endUtc INTEGER NOT NULL,
    timezone TEXT NOT NULL,
    start_local TEXT NOT NULL,
    end_local TEXT NOT NULL,
    start_offset_seconds INTEGER NOT NULL,
    end_offset_seconds INTEGER NOT NULL,
    dst_ambiguous INTEGER NOT NULL DEFAULT 0,
    dst_occurrence TEXT CHECK(dst_occurrence IN ('first','second')),
    privacy TEXT NOT NULL DEFAULT 'inherit' CHECK(privacy IN ('inherit','full_subject','busy_only')),
    status TEXT NOT NULL CHECK(status IN ('booked','checked_in','cancelled','finished')),
    checked_in_at INTEGER,
    checked_in_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    extension_of INTEGER REFERENCES meetings(id)
  );

  CREATE INDEX IF NOT EXISTS idx_meetings_room_time
    ON meetings(room_id, startUtc, endUtc);
  CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);

  CREATE TABLE IF NOT EXISTS meeting_events (
    id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor_id INTEGER REFERENCES users(id),
    at_utc INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    UNIQUE(meeting_id, seq)
  );

  CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    offline_policy TEXT NOT NULL DEFAULT 'cache_view_only' CHECK(offline_policy IN ('offline_checkin_allowed','cache_view_only')),
    last_seen_at INTEGER,
    last_server_clock_utc INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    permission_epoch INTEGER NOT NULL DEFAULT 1,
    cached_meeting_ids TEXT NOT NULL DEFAULT '[]',
    UNIQUE(room_id,name)
  );

  CREATE TABLE IF NOT EXISTS device_cache_checkins (
    id INTEGER PRIMARY KEY,
    device_id INTEGER NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    client_clock_utc INTEGER NOT NULL,
    device_observed_server_clock_utc INTEGER,
    max_abs_clock_skew_ms INTEGER NOT NULL,
    signed_confirmation TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected_stale','rejected_cancelled','rejected_outside_window','rejected_duplicate','rejected_device_revoked')),
    received_at_utc INTEGER,
    decided_at_utc INTEGER,
    rejection_reason TEXT,
    created_at_utc INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS background_assets (
    id INTEGER PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
    editor_user_id INTEGER REFERENCES users(id),
    url TEXT NOT NULL UNIQUE,
    sha256 TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS background_acl (
    asset_id INTEGER NOT NULL REFERENCES background_assets(id) ON DELETE CASCADE,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    can_read_meeting_details INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(asset_id,room_id)
  );
  `);
}

function hashToken(tok) { return crypto.createHash('sha256').update(tok).digest('hex'); }

function seed(db) {
  const now = Date.now();
  const insUser = db.prepare(`INSERT INTO users(email,display_name,password_hash,password_salt,role,active,created_at)
    VALUES(@email,@display_name,@password_hash,@password_salt,@role,1,@created_at)`);
  const mk = (email, name, role = 'user', password = 'password123') => {
    const p = hashPassword(password);
    return insUser.run({ email, display_name: name, password_hash: p.passwordHash, password_salt: p.salt, role, created_at: now }).lastInsertRowid;
  };
  const admin = mk('admin@example.com', 'Ada Admin', 'admin');
  const alice = mk('alice@example.com', 'Alice', 'user');
  const bob = mk('bob@example.com', 'Bob', 'user');
  const editor = mk('editor@example.com', 'Template Editor', 'template_editor', 'editor123');

  const room = db.prepare(`INSERT INTO rooms(name,timezone,default_privacy,background_url,created_at)
    VALUES(?,?,?,?,?)`).run('Boardroom', 'America/New_York', 'full_subject', '/assets/company-bg.svg', now).lastInsertRowid;
  const quiet = db.prepare(`INSERT INTO rooms(name,timezone,default_privacy,background_url,created_at)
    VALUES(?,?,?,?,?)`).run('Quiet Room', 'America/New_York', 'busy_only', '/assets/company-bg.svg', now).lastInsertRowid;
  const grant = db.prepare(`INSERT INTO room_grants(room_id,user_id,role,granted_at) VALUES(?,?,?,?)`);
  for (const user of [alice, bob]) {
    grant.run(room, user, 'booker', now);
    grant.run(quiet, user, 'booker', now);
  }
  grant.run(room, editor, 'template_editor', now);
  db.prepare(`INSERT INTO background_assets(room_id,editor_user_id,url,sha256,created_at)
    VALUES(?,?,?,?,?)`).run(room, editor, '/assets/company-bg.svg', null, now);
  db.prepare(`INSERT INTO background_acl(asset_id,room_id,can_read_meeting_details)
    VALUES((SELECT id FROM background_assets WHERE url=?),?,0)`).run('/assets/company-bg.svg', room);
  return { admin, alice, bob, editor, rooms: { boardroom: room, quiet } };
}

module.exports = { createDb, migrateDb, seed, hashPassword, verifyPassword, token, hashToken };
