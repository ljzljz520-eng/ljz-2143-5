'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { createDb, seed } = require('../src/db');
const helper = path.join(__dirname, 'concurrency-helper.js');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-race-'));
  const file = path.join(dir, 'race.db');
  const db = createDb(file);
  const ids = seed(db);
  db.close();
  return { file, dir, roomId: undefined, ids: undefined };
}

function parallel(env, args) {
  return args.map(a => spawnSync(process.execPath, [helper, ...a], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000
  }));
}
function json(proc) {
  assert.equal(proc.status, 0, proc.stderr || proc.error?.message);
  return JSON.parse(proc.stdout.trim().split('\n').at(-1));
}

test('real two-process overlapping booking returns one winner and one 409', () => {
  const setup = tempDb();
  const db = new Database(setup.file);
  const roomId = db.prepare('SELECT id FROM rooms WHERE name=?').get('Boardroom').id;
  db.close();
  const procs = parallel({ ROOM_ID: roomId }, [
    ['book', setup.file, 'alice@example.com'],
    ['book', setup.file, 'bob@example.com']
  ]);
  const outcomes = procs.map(json).sort((a,b) => Number(b.ok)-Number(a.ok));
  assert.equal(outcomes.filter(o => o.ok).length, 1);
  assert.equal(outcomes.find(o => !o.ok).code, 'ROOM_BUSY');
});

test('real two-process reschedule to overlapping times has exactly one winner', () => {
  const setup = tempDb();
  const db = new Database(setup.file); db.pragma('foreign_keys=ON');
  const roomId = db.prepare('SELECT id FROM rooms WHERE name=?').get('Boardroom').id;
  const alice = db.prepare("SELECT id FROM users WHERE email='alice@example.com'").get().id;
  const bob = db.prepare("SELECT id FROM users WHERE email='bob@example.com'").get().id;
  const t = Date.now();
  const insert = db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`);
  const m1 = insert.run(roomId, alice, 'a', t+86400000, t+90000000, 'America/New_York','x','y',-18000,-18000,t,t).lastInsertRowid;
  const m2 = insert.run(roomId, bob, 'b', t+93600000, t+97200000, 'America/New_York','x','y',-18000,-18000,t,t).lastInsertRowid;
  db.close();
  const procs = [
    spawnSync(process.execPath, [helper, 'reschedule', setup.file, 'alice@example.com', String(m1)], { encoding:'utf8', env:{...process.env, ROOM_ID:String(roomId), HOUR:'10'}, timeout:15000 }),
    spawnSync(process.execPath, [helper, 'reschedule', setup.file, 'bob@example.com', String(m2)], { encoding:'utf8', env:{...process.env, ROOM_ID:String(roomId), HOUR:'10'}, timeout:15000 })
  ];
  const outcomes = procs.map(p => json(p));
  assert.equal(outcomes.filter(o => o.ok).length, 1, JSON.stringify(outcomes));
  const loser = outcomes.find(o => !o.ok);
  assert.ok(['ROOM_BUSY','VERSION_CONFLICT'].includes(loser.code));
});

test('real two-process same-version check-in applies exactly once', () => {
  const setup = tempDb();
  const db = new Database(setup.file); db.pragma('foreign_keys=ON');
  const roomId = db.prepare('SELECT id FROM rooms WHERE name=?').get('Boardroom').id;
  const alice = db.prepare("SELECT id FROM users WHERE email='alice@example.com'").get().id;
  const t = Date.now();
  const meetingId = db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`)
    .run(roomId, alice, 'race checkin', t-60000, t+3600000, 'UTC','x','y',0,0,t,t).lastInsertRowid;
  db.close();
  const procs = parallel({ ROOM_ID: roomId, MEETING_ID: meetingId }, [
    ['checkin', setup.file, 'alice@example.com', String(meetingId)],
    ['checkin', setup.file, 'bob@example.com', String(meetingId)]
  ]);
  const outcomes = procs.map(json);
  assert.equal(outcomes.filter(o => o.ok).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.find(o => !o.ok).code, 'VERSION_CONFLICT');
  const checked = new Database(setup.file);
  assert.equal(checked.prepare('SELECT status,version FROM meetings WHERE id=?').get(meetingId).status, 'checked_in');
  assert.equal(checked.prepare("SELECT COUNT(*) n FROM meeting_events WHERE meeting_id=? AND type='checked_in'").get(meetingId).n, 1);
  checked.close();
});
