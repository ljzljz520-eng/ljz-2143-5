'use strict';
const Database = require('better-sqlite3');

function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('user','admin','template_editor'))
  );
  -- 令牌随时可删 = 权限即时回收
  CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    tz TEXT NOT NULL,
    checkin_policy TEXT NOT NULL DEFAULT 'online_only'
        CHECK (checkin_policy IN ('online_only','offline_allowed')),
    checkin_grace_min INTEGER NOT NULL DEFAULT 10,
    active_template_id INTEGER,
    privacy TEXT NOT NULL DEFAULT 'normal' CHECK (privacy IN ('normal','private'))
  );
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    organizer_id INTEGER NOT NULL REFERENCES users(id),
    topic TEXT NOT NULL,
    start_ms INTEGER NOT NULL,   -- UTC epoch ms, 区间 [start_ms, end_ms)
    end_ms INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'booked'
        CHECK (status IN ('booked','checked_in','finished','cancelled')),
    checked_in_at_ms INTEGER,
    checked_in_by INTEGER REFERENCES users(id),
    version INTEGER NOT NULL DEFAULT 1,   -- 每次状态/时间修改 +1
    created_ms INTEGER NOT NULL
  );
  -- 冲突检测走的覆盖索引（只查有效会议）
  CREATE INDEX IF NOT EXISTS idx_meet_room_time
    ON meetings(room_id, start_ms, end_ms) WHERE status != 'cancelled';
  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY,
    room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE, -- NULL=公司通用背景
    name TEXT NOT NULL,
    -- 背景素材地址；模板仅存排版/图层，不含任何会议内容
    background_url TEXT NOT NULL,
    layout_json TEXT NOT NULL DEFAULT '{}',
    editor_id INTEGER NOT NULL REFERENCES users(id)
  );
  -- 门牌设备每次心跳一行（最后一次在线时间，用于“显示新鲜度”）
  CREATE TABLE IF NOT EXISTS displays (
    room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    token TEXT,
    last_seen_ms INTEGER NOT NULL,
    last_applied_version INTEGER,
    clock_offset_ms INTEGER NOT NULL DEFAULT 0  -- 服务器时间 - 设备自报时间
  );
  -- 服务器事件日志：单调序号，SSE 与设备都按 seq 判断新旧/乱序
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    emitted_ms INTEGER NOT NULL
  );
  `);
  return db;
}

function seed(db) {
  const insUser = db.prepare('INSERT OR IGNORE INTO users(name, role) VALUES (?,?)');
  const insToken = db.prepare('INSERT OR IGNORE INTO tokens(token, user_id) VALUES (?,?)');
  const users = [
    ['alice', 'admin'], ['bob', 'user'], ['carol', 'user'],
    ['dave', 'user'], ['erin', 'template_editor'],
  ];
  const tokens = { alice: 'tok-alice', bob: 'tok-bob', carol: 'tok-carol',
    dave: 'tok-dave', erin: 'tok-erin' };
  for (const [name, role] of users) insUser.run(name, role);
  const uid = db.prepare('SELECT id FROM users WHERE name=?');
  for (const name of Object.keys(tokens)) insToken.run(tokens[name], uid.get(name).id);

  const roomCount = db.prepare('SELECT COUNT(*) c FROM rooms').get().c;
  if (roomCount === 0) {
    const insRoom = db.prepare(`INSERT INTO rooms(code,name,tz,checkin_policy,checkin_grace_min)
      VALUES (?,?,?,?,?)`);
    insRoom.run('R-NY', 'New York 3F-301', 'America/New_York', 'offline_allowed', 10);
    insRoom.run('R-SH', 'Shanghai 8F-海棠', 'Asia/Shanghai', 'online_only', 10);
    const tpl = db.prepare(`INSERT INTO templates(room_id,name,background_url,layout_json,editor_id)
      VALUES (?,?,?,?,?)`);
    const erinId = uid.get('erin').id;
    tpl.run(null, 'company-default', '/static/bg/company.svg',
      JSON.stringify({ logo: { x: 40, y: 36 }, titleSize: 48, footer: 'Acme Corp' }), erinId);
    tpl.run(1, 'ny-brand', '/static/bg/ny.svg',
      JSON.stringify({ titleSize: 56, accent: '#0a4' }), erinId);
  }
  return tokens;
}

module.exports = { openDb, seed };
