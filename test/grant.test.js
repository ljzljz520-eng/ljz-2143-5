'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const Database=require('better-sqlite3');const {migrateDb,seed}=require('../src/db');const {createService}=require('../src/service');
test('revoked grant can be regranted and then used again',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateDb(db);const ids=seed(db);const svc=createService(db);
 const admin=db.prepare("SELECT * FROM users WHERE email='admin@example.com'").get();
 const alice=db.prepare("SELECT * FROM users WHERE email='alice@example.com'").get();
 svc.revokeGrant(admin,ids.rooms.boardroom,alice.id);
 db.prepare('INSERT INTO room_grants(room_id,user_id,role,granted_at) VALUES(?,?,?,?)').run(ids.rooms.boardroom,alice.id,'booker',Date.now());
 const m=svc.createMeeting(alice,{roomId:ids.rooms.boardroom,subject:'regranted',startLocal:'2099-03-01T10:00',endLocal:'2099-03-01T11:00',timezone:'America/New_York'});
 assert.equal(m.status,'booked');
});
test('revoked door token cannot fetch or upload after explicit device revocation',()=>{
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateDb(db);const ids=seed(db);const svc=createService(db);
 const admin=db.prepare("SELECT * FROM users WHERE email='admin@example.com'").get();
 const t=Date.now();
 const meetingId=db.prepare(`INSERT INTO meetings(room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,start_offset_seconds,end_offset_seconds,privacy,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?, 'inherit','booked',?, ?,1)`)
   .run(ids.rooms.boardroom,admin.id,'x',t-60000,t+3600000,'UTC','x','y',0,0,t,t).lastInsertRowid;
 const d=svc.registerDevice(admin,{roomId:ids.rooms.boardroom,name:'revokable',offlinePolicy:'offline_checkin_allowed'});
 svc.doorSnapshot(d.deviceToken);
 const revoked=svc.revokeDevice(admin,1);
 assert.equal(revoked.revoked,true);
 assert.throws(()=>svc.doorSnapshot(d.deviceToken),e=>e.code==='DEVICE_REVOKED');
 assert.throws(()=>svc.offlineCheckin(d.deviceToken,{meetingId,clientClockUtc:t,lastKnownServerClockUtc:t,confirmation:'after-revoke'}),e=>e.code==='DEVICE_REVOKED');
});
