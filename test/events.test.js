'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateDb, seed } = require('../src/db');
const { createService } = require('../src/service');

test('global event stream survives out-of-order client application and permission filtering', () => {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateDb(db);
  const ids = seed(db); const svc = createService(db, { secret: 'x' });
  const alice = db.prepare('SELECT * FROM users WHERE email=?').get('alice@example.com');
  const room = ids.rooms.boardroom;
  const m = svc.createMeeting(alice, { roomId: room, subject:'order', startLocal:'2099-01-03T10:00', endLocal:'2099-01-03T11:00', timezone:'America/New_York' });
  svc.cancel(alice, m.id, { expectedVersion:1 });
  const page1 = svc.eventsSince(alice, 0);
  assert.deepEqual(page1.events.map(e => e.type), ['created','cancelled']);
  const cursor = page1.cursor;
  const page2 = svc.eventsSince(alice, cursor);
  assert.equal(page2.events.length, 0);
  assert.equal(page2.cursor, cursor);

  const editor = db.prepare('SELECT * FROM users WHERE email=?').get('editor@example.com');
  const filtered = svc.eventsSince(editor, 0);
  assert.equal(filtered.events.some(e => JSON.stringify(e.payload).includes('order')), false);
  assert.equal(filtered.cursor, cursor, 'cursor still advances globally even though events are hidden');
});
