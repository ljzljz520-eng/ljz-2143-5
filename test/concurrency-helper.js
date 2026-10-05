'use strict';
const { createDb } = require('../src/db');
const { createService } = require('../src/service');

async function main() {
  const [mode, file, email] = process.argv.slice(2);
  const db = createDb(file, { migrate: false });
  const svc = createService(db, { secret: 'concurrency-secret' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const roomId = Number(process.env.ROOM_ID);
  const meetingId = Number(process.env.MEETING_ID || process.argv[5] || 0);
  if (mode === 'book') {
    try {
      svc.createMeeting(user, { roomId, subject: process.env.USER_SUBJECT || 'race', startLocal: '2099-02-03T10:00', endLocal: '2099-02-03T11:00', timezone: 'America/New_York' });
      console.log(JSON.stringify({ ok: true }));
    } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, status: e.status })); }
  } else if (mode === 'reschedule') {
    const hour = process.env.HOUR || '10';
    try {
      const m = svc.reschedule(user, meetingId, { expectedVersion: 1, startLocal: `2099-02-04T${hour}:00`, endLocal: `2099-02-04T${Number(hour)+1}:00`, timezone: 'America/New_York' });
      console.log(JSON.stringify({ ok: true, version: m.version, startUtc: m.time.startUtc }));
    } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, status: e.status })); }
  } else if (mode === 'checkin') {
    try {
      const m = svc.checkin(user, meetingId, { expectedVersion: 1 });
      console.log(JSON.stringify({ ok: true, status: m.status, version: m.version }));
    } catch (e) { console.log(JSON.stringify({ ok: false, code: e.code, status: e.status })); }
  }
  db.close();
}
main().catch(err => { console.error(err); process.exit(2); });
