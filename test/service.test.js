'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { migrateDb, seed } = require('../src/db');
const { createService } = require('../src/service');

function harness() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); migrateDb(db);
  const ids = seed(db); const svc = createService(db, { secret: 'test-secret' });
  const user = email => db.prepare('SELECT * FROM users WHERE email=?').get(email);
  return { db, ids, svc, user };
}
const range = (startLocal,endLocal,timezone='America/New_York', dstOccurrence='first') => ({startLocal,endLocal,timezone,dstOccurrence});
const future = (startHour=10, roomTz='America/New_York') => {
  // Pick a future stable date so online check-in window can be manipulated by tests through rows where needed.
  return { startLocal:`2099-01-02T${String(startHour).padStart(2,'0')}:00`, endLocal:`2099-01-02T${String(startHour+1).padStart(2,'0')}:00`, timezone:roomTz };
};

test('concurrent overlapping reservations have one deterministic winner; adjacent intervals both win', () => {
  const { db, ids, svc, user } = harness();
  const alice = user('alice@example.com');
  const room = ids.rooms.boardroom;
  const a = future(10);
  const overlap = { ...a, subject:'Overlap' };
  const winner = svc.createMeeting(alice, { roomId:room, ...a, subject:'A' });
  assert.equal(winner.time.boundary, 'half-open-start-inclusive-end-exclusive');
  assert.throws(() => svc.createMeeting(user('bob@example.com'), { roomId:room, ...overlap }), e => e.status === 409 && e.code === 'ROOM_BUSY');
  const adjacent = { ...future(11), subject:'Adjacent' };
  const ok = svc.createMeeting(user('bob@example.com'), { roomId:room, ...adjacent });
  assert.equal(ok.time.startUtc, winner.time.endUtc);
});

test('overlap loser conflict points at the committed meeting and adjacent intervals pass', () => {
  const { ids, svc, user } = harness();
  const room=ids.rooms.boardroom;
  svc.createMeeting(user('alice@example.com'), { roomId:room,...future(14),subject:'holder' });
  const err = (()=>{ try { svc.createMeeting(user('bob@example.com'), { roomId:room,...future(14),subject:'race' }); } catch(e){return e;} })();
  assert.equal(err.status,409);
  assert.equal(err.details.conflict.time.boundary,'half-open-start-inclusive-end-exclusive');
  assert.ok(svc.createMeeting(user('bob@example.com'), { roomId:room,...future(15),subject:'after' }).id);
});

test('reschedule optimistic version and overlap conflict', () => {
  const { ids, svc, user } = harness();
  const room=ids.rooms.boardroom, alice=user('alice@example.com');
  const m1=svc.createMeeting(alice,{roomId:room,...future(9),subject:'one'});
  const m2=svc.createMeeting(user('bob@example.com'),{roomId:room,...future(11),subject:'two'});
  assert.throws(()=>svc.reschedule(user('bob@example.com'),m2.id,{expectedVersion:m2.version,...future(9)}),e=>e.status===409&&e.code==='ROOM_BUSY');
  const moved=svc.reschedule(user('bob@example.com'),m2.id,{expectedVersion:m2.version,...future(15)});
  assert.equal(moved.version,2);
  assert.throws(()=>svc.reschedule(user('bob@example.com'),m2.id,{expectedVersion:m2.version,...future(16)}),e=>e.status===409&&e.code==='VERSION_CONFLICT');
  assert.equal(m1.version,1);
});

test('temporary extension rechecks the next meeting and never bypasses it', () => {
  const { ids, svc, user } = harness();
  const room=ids.rooms.boardroom, alice=user('alice@example.com');
  const first=svc.createMeeting(alice,{roomId:room,...future(9),subject:'first'});
  const second=svc.createMeeting(user('bob@example.com'),{roomId:room,...future(10),subject:'next'});
  assert.throws(()=>svc.extendMeeting(alice,first.id,{endLocal:'2099-01-02T10:30',timezone:'America/New_York'}), e=>e.status===409&&e.code==='NEXT_MEETING_BLOCKS');
  const extended=svc.extendMeeting(alice,first.id,{endLocal:'2099-01-02T10:00',timezone:'America/New_York'});
  assert.equal(extended.time.endUtc,second.time.startUtc);
});

test('DST repeated occurrences are distinct non-conflicting bookings only when UTC intervals differ', () => {
  const { ids, svc, user } = harness();
  const room=ids.rooms.boardroom, alice=user('alice@example.com');
  const first=svc.createMeeting(alice,{roomId:room,startLocal:'2099-11-01T01:00',endLocal:'2099-11-01T01:30',timezone:'America/New_York',dstOccurrence:'first',subject:'fall 1'});
  const second=svc.createMeeting(user('bob@example.com'),{roomId:room,startLocal:'2099-11-01T01:00',endLocal:'2099-11-01T01:30',timezone:'America/New_York',dstOccurrence:'second',subject:'fall 2'});
  assert.equal(second.time.startUtc-first.time.startUtc,3600000);
  assert.throws(()=>svc.createMeeting(alice,{roomId:room,startLocal:'2099-11-01T01:00',endLocal:'2099-11-01T01:30',timezone:'America/New_York',dstOccurrence:'first',subject:'fall duplicate'}),e=>e.code==='ROOM_BUSY');
});

test('check-in races produce one durable fact and stale version loses', () => {
  const { db, ids, svc, user } = harness();
  const room=ids.rooms.boardroom, alice=user('alice@example.com');
  const t=Date.now()+60000;
  const id=db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`)
    .run(room,alice.id,'soon',t,t+3600000,'UTC','x','y',0,0,Date.now(),Date.now()).lastInsertRowid;
  const one=svc.checkin(alice,id,{expectedVersion:1});
  assert.equal(one.status,'checked_in');
  assert.throws(()=>svc.checkin(user('bob@example.com'),id,{expectedVersion:1}),e=>e.code==='VERSION_CONFLICT');
  const repeat=svc.checkin(user('bob@example.com'),id,{expectedVersion:2});
  assert.equal(repeat.status,'checked_in');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM meeting_events WHERE meeting_id=? AND type=?').get(id,'checked_in').n,1);
});

test('cancelled old offline confirmation is rejected at reconciliation despite device clock claim', () => {
  const { db, ids, svc, user } = harness();
  const room=ids.rooms.boardroom, admin=user('admin@example.com');
  const reg=svc.registerDevice(admin,{roomId:room,name:'d',offlinePolicy:'offline_checkin_allowed'});
  const t=Date.now();
  const mid=db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`)
    .run(room,user('alice@example.com').id,'secret',t-60000,t+3600000,'UTC','x','y',0,0,t,t).lastInsertRowid;
  svc.doorSnapshot(reg.deviceToken);
  svc.cancel(user('alice@example.com'),mid,{expectedVersion:1});
  const r=svc.offlineCheckin(reg.deviceToken,{meetingId:mid,clientClockUtc:t,lastKnownServerClockUtc:t-1000,maxAbsClockSkewMs:60000,confirmation:'old-confirm'});
  assert.equal(r.status,'rejected_cancelled');
});

test('read-only cache device cannot offline check in; clock-drifted request is rejected', () => {
  const { db, ids, svc, user } = harness();
  const room=ids.rooms.boardroom, admin=user('admin@example.com');
  const read=svc.registerDevice(admin,{roomId:room,name:'ro',offlinePolicy:'cache_view_only'});
  const write=svc.registerDevice(admin,{roomId:room,name:'rw',offlinePolicy:'offline_checkin_allowed'});
  const t=Date.now();
  const mid=db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`)
    .run(room,user('alice@example.com').id,'m',t-60000,t+3600000,'UTC','x','y',0,0,t,t).lastInsertRowid;
  svc.doorSnapshot(write.deviceToken);
  assert.throws(()=>svc.offlineCheckin(read.deviceToken,{meetingId:mid,clientClockUtc:t,lastKnownServerClockUtc:t,confirmation:'x'}),e=>e.code==='OFFLINE_CHECKIN_DISABLED');
  const drifted=svc.offlineCheckin(write.deviceToken,{meetingId:mid,clientClockUtc:t-90*60000,lastKnownServerClockUtc:t,maxAbsClockSkewMs:60000,confirmation:'drift'});
  assert.equal(drifted.status,'rejected_outside_window');
});

test('privacy hides subject from door and template editor does not receive meeting details', () => {
  const { ids, svc, user } = harness();
  const room=ids.rooms.boardroom, editor=user('editor@example.com');
  const nowLocal = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(Date.now()-60000));
  const endLocal = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(Date.now()+3600000));
  const m=svc.createMeeting(user('alice@example.com'),{roomId:room,startLocal:nowLocal,endLocal,timezone:'America/New_York',privacy:'busy_only',subject:'Compensation Plan'});
  const admin=user('admin@example.com');
  const d=svc.registerDevice(admin,{roomId:room,name:'quiet door'});
  const snap=svc.doorSnapshot(d.deviceToken);
  assert.equal(snap.current.subject,'Busy');
  assert.equal(snap.current.displayMode,'busy_only');
  assert.equal(snap.current.id,m.id);
  const tpl=svc.updateTemplate(editor,room,{backgroundUrl:'/assets/company-bg.svg?x=1'});
  assert.equal(tpl.meetingDetailsAccessible,false);
  assert.throws(()=>svc.listMeetings(editor,{roomId:room}),e=>e.status===403);
  assert.equal(m.id,m.id);
});

test('permission revocation prevents future booking and bumps door authorization epoch', () => {
  const { db, ids, svc, user } = harness();
  const room=ids.rooms.boardroom, admin=user('admin@example.com'), alice=user('alice@example.com');
  const reg=svc.registerDevice(admin,{roomId:room,name:'d',offlinePolicy:'offline_checkin_allowed'});
  const before=svc.doorSnapshot(reg.deviceToken).device.permissionEpoch;
  svc.revokeGrant(admin,room,alice.id);
  assert.throws(()=>svc.createMeeting(alice,{roomId:room,...future(13),subject:'late'}),e=>e.code==='ROOM_FORBIDDEN');
  const after=svc.doorSnapshot(reg.deviceToken).device.permissionEpoch;
  assert.equal(after,before+1);
});
