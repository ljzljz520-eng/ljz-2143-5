'use strict';
const crypto = require('node:crypto');
const { verifyPassword, token, hashToken } = require('./db');
const { normalizeRange, meetingTimeView, getZone, parseLocal, formatLocal } = require('./time');

const SESSION_MS = 12 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, code, message, details = undefined) { super(message); this.status = status; this.code = code; this.details = details; }
}

function base64urlJson(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function sign(payloadB64, secret) { return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url'); }

function createService(db, { secret = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex') } = {}) {
  const now = () => Date.now();

  function withImmediate(fn) {
    return (...args) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = fn(...args);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  function getUser(id) {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!u || !u.active) throw new HttpError(401, 'USER_INACTIVE', 'User account is unavailable');
    return u;
  }

  function login(email, password) {
    const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
    if (!u || !u.active || !verifyPassword(String(password || ''), u.password_salt, u.password_hash)) {
      throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
    }
    const tok = token();
    const t = now();
    db.prepare('INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)')
      .run(hashToken(tok), u.id, t, t + SESSION_MS);
    return { token: tok, user: publicUser(u) };
  }

  function logout(session) {
    db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=?').run(now(), session.tokenHash);
  }

  function sessionFromToken(tok) {
    if (!tok) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND revoked_at IS NULL').get(hashToken(tok));
    if (!s || s.expires_at <= now()) return null;
    return { ...s, tokenHash: hashToken(tok) };
  }

  function requireUser(req) {
    const s = sessionFromToken(req.token);
    if (!s) throw new HttpError(401, 'UNAUTHORIZED', 'Authentication required');
    return { session: s, user: getUser(s.user_id) };
  }

  function room(id) {
    const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    if (!r) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found');
    return r;
  }

  function meeting(id) {
    const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(id);
    if (!m) throw new HttpError(404, 'MEETING_NOT_FOUND', 'Meeting not found');
    return m;
  }

  function ensureRole(user, roomId, wanted = 'booker') {
    if (user.role === 'admin') return true;
    const roles = db.prepare(`SELECT role FROM room_grants
      WHERE room_id=? AND user_id=? AND revoked_at IS NULL`).all(roomId, user.id).map(x => x.role);
    if (wanted === 'template_editor') {
      if (!roles.includes('template_editor')) throw new HttpError(403, 'TEMPLATE_FORBIDDEN', 'Only an authorized template editor may change this template');
      return true;
    }
    if (wanted === 'booker') {
      if (!roles.includes('booker')) throw new HttpError(403, 'ROOM_FORBIDDEN', 'Booking permission for this room has been revoked');
      return true;
    }
    if (!roles.length) throw new HttpError(403, 'ROOM_FORBIDDEN', 'No access to this room');
    return true;
  }

  function canViewRoom(user, roomId) {
    if (user.role === 'admin') return true;
    const g = db.prepare(`SELECT 1 FROM room_grants
      WHERE room_id=? AND user_id=? AND revoked_at IS NULL
        AND role IN ('booker','viewer') LIMIT 1`).get(roomId, user.id);
    if (!g) throw new HttpError(403, 'ROOM_FORBIDDEN', 'No meeting-read access to this room');
    return true;
  }

  function nextEventId(tx, meetingId) {
    const row = tx.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM meeting_events WHERE meeting_id=?').get(meetingId);
    return row.n;
  }

  function logEvent(tx, meetingId, type, actorId, payload) {
    const seq = nextEventId(tx, meetingId);
    tx.prepare(`INSERT INTO meeting_events(meeting_id,seq,type,actor_id,at_utc,payload_json)
      VALUES(?,?,?,?,?,?)`).run(meetingId, seq, type, actorId, now(), JSON.stringify(payload || {}));
    return seq;
  }

  // Holds a write lock for the complete read/check/write sequence. SQLite's
  // BEGIN IMMEDIATE serializes two concurrent booking requests; exactly one
  // sees the loser's row and gets 409. The interval is half-open, so adjacent
  // [10:00,11:00) and [11:00,12:00) are both accepted.
  function findConflict(tx, roomId, startUtc, endUtc, excludeMeetingId = null) {
    return tx.prepare(`SELECT id,subject,startUtc,endUtc,timezone,status,version FROM meetings
      WHERE room_id=?
        AND (? IS NULL OR id <> ?)
        AND status IN ('booked','checked_in')
        AND startUtc < ? AND endUtc > ?
      ORDER BY startUtc LIMIT 1`)
      .get(roomId, excludeMeetingId, excludeMeetingId, endUtc, startUtc);
  }

  function createMeeting(user, body) {
    const text = sanitizeMeetingBody(body);
    const r = room(+body.roomId);
    getZone(r.timezone);
    ensureRole(user, r.id, 'booker');
    const range = normalizeRange({
      timezone: body.timezone || r.timezone,
      startLocal: body.startLocal,
      endLocal: body.endLocal,
      dstOccurrence: body.dstOccurrence
    });
    const privacy = validatePrivacy(body.privacy || 'inherit');
    const runWrite = withImmediate(() => {
      // The transaction wrapper normally does BEGIN; explicit IMMEDIATE is key.
      const conflict = findConflict(db, r.id, range.startUtc, range.endUtc);
      if (conflict) {
        throw new HttpError(409, 'ROOM_BUSY', 'The requested interval overlaps an active meeting', { conflict: conflictView(conflict) });
      }
      const t = now();
      const info = db.prepare(`INSERT INTO meetings(
        room_id,organizer_id,subject,startUtc,endUtc,timezone,start_local,end_local,
        start_offset_seconds,end_offset_seconds,dst_ambiguous,dst_occurrence,privacy,
       status,created_at,updated_at,version)
        VALUES(@room_id,@organizer_id,@subject,@startUtc,@endUtc,@timezone,@start_local,@end_local,
        @start_offset_seconds,@end_offset_seconds,@dst_ambiguous,@dst_occurrence,@privacy,
        'booked',@created_at,@updated_at,1)`).run({
          room_id: r.id, organizer_id: user.id, subject: text.subject,
          startUtc: range.startUtc, endUtc: range.endUtc, timezone: range.timezone,
          start_local: range.startLocal, end_local: range.endLocal,
          start_offset_seconds: range.startOffsetSeconds, end_offset_seconds: range.endOffsetSeconds,
          dst_ambiguous: range.dstAmbiguous ? 1 : 0, dst_occurrence: range.dstOccurrence,
          privacy, created_at: t, updated_at: t
        });
      logEvent(db, info.lastInsertRowid, 'created', user.id, { range, privacy });
      return info.lastInsertRowid;
    });
    return getMeetingView(user, runWrite());
  }

  function reschedule(user, meetingId, body) {
    const m = meeting(+meetingId);
    const r = room(m.room_id);
    if (m.organizer_id !== user.id && user.role !== 'admin') {
      throw new HttpError(403, 'MEETING_FORBIDDEN', 'Only the organizer or admin can reschedule');
    }
    if (m.status === 'cancelled') throw new HttpError(409, 'CANCELLED', 'A cancelled meeting cannot be moved');
    const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
    const range = normalizeRange({
      timezone: body.timezone || m.timezone,
      startLocal: body.startLocal,
      endLocal: body.endLocal,
      dstOccurrence: body.dstOccurrence
    });
    const runWrite = withImmediate(() => {
      const current = meeting(m.id);
      if (expectedVersion !== null && current.version !== expectedVersion) {
        throw new HttpError(409, 'VERSION_CONFLICT', 'Meeting changed since it was loaded', { currentVersion: current.version });
      }
      if (current.status === 'cancelled') throw new HttpError(409, 'CANCELLED', 'Meeting was cancelled');
      const conflict = findConflict(db, current.room_id, range.startUtc, range.endUtc, current.id);
      if (conflict) throw new HttpError(409, 'ROOM_BUSY', 'Rescheduled interval overlaps another active meeting', { conflict: conflictView(conflict) });
      const t = now();
      db.prepare(`UPDATE meetings SET startUtc=?,endUtc=?,timezone=?,start_local=?,end_local=?,
        start_offset_seconds=?,end_offset_seconds=?,dst_ambiguous=?,dst_occurrence=?,
        updated_at=?,version=version+1 WHERE id=?`)
        .run(range.startUtc, range.endUtc, range.timezone, range.startLocal, range.endLocal,
          range.startOffsetSeconds, range.endOffsetSeconds, range.dstAmbiguous ? 1 : 0,
          range.dstOccurrence, t, current.id);
      logEvent(db, current.id, 'rescheduled', user.id, { old: { startUtc: current.startUtc, endUtc: current.endUtc }, range, fromVersion: current.version });
      return current.id;
    });
    return getMeetingView(user, runWrite());
  }

  function extendMeeting(user, meetingId, body) {
    // Extension is a reschedule whose only permitted delta is endUtc. It must
    // pass the same atomic next-meeting check; it is never a client-side
    // countdown change.
    const m = meeting(+meetingId);
    if (m.organizer_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'MEETING_FORBIDDEN', 'Only organizer can extend');
    const zone = body.timezone || m.timezone;
    const end = parseLocal(body.endLocal, zone, body.dstOccurrence === 'second' ? 'second' : 'first');
    if (end.utcMs <= m.startUtc) throw new HttpError(400, 'BAD_RANGE', 'Extension end must be after start');
    if (end.utcMs < m.endUtc) throw new HttpError(400, 'NOT_EXTENSION', 'New end must not be earlier than current end');
    const runWrite = withImmediate(() => {
      const current = meeting(m.id);
      if (current.status === 'cancelled') throw new HttpError(409, 'CANCELLED', 'Meeting was cancelled');
      const blocker = db.prepare(`SELECT id,subject,startUtc,endUtc,timezone,status,version FROM meetings
        WHERE room_id=? AND id<>? AND status IN ('booked','checked_in') AND startUtc < ? AND startUtc >= ?
        ORDER BY startUtc LIMIT 1`).get(current.room_id, current.id, end.utcMs, current.endUtc);
      if (blocker) throw new HttpError(409, 'NEXT_MEETING_BLOCKS', 'The next meeting prevents this extension', { conflict: conflictView(blocker), maxEndUtc: blocker.startUtc });
      const t = now();
      db.prepare(`UPDATE meetings SET endUtc=?,timezone=?,end_local=?,end_offset_seconds=?,
        dst_ambiguous=CASE WHEN ? THEN 1 ELSE dst_ambiguous END,dst_occurrence=COALESCE(?,dst_occurrence),
        updated_at=?,version=version+1 WHERE id=?`)
        .run(end.utcMs, zone, formatLocal(end.utcMs, zone), end.offsetSeconds, end.ambiguous ? 1 : 0,
          end.ambiguous ? (body.dstOccurrence === 'second' ? 'second' : 'first') : null, t, current.id);
      logEvent(db, current.id, 'extended', user.id, { oldEndUtc: current.endUtc, newEndUtc: end.utcMs, checkedNextMeeting: true, fromVersion: current.version });
      return current.id;
    });
    return getMeetingView(user, runWrite());
  }

  function cancel(user, meetingId, body = {}) {
    const m = meeting(+meetingId);
    if (m.organizer_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'MEETING_FORBIDDEN', 'Only organizer can cancel');
    const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
    const runWrite = withImmediate(() => {
      const current = meeting(m.id);
      if (expectedVersion !== null && current.version !== expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'Meeting changed', { currentVersion: current.version });
      if (current.status !== 'cancelled') {
        db.prepare(`UPDATE meetings SET status='cancelled',updated_at=?,version=version+1 WHERE id=?`).run(now(), current.id);
        logEvent(db, current.id, 'cancelled', user.id, { fromVersion: current.version });
      }
      return current.id;
    });
    return getMeetingView(user, runWrite());
  }

  function checkin(user, meetingId, body = {}) {
    const expectedVersion = Number.isInteger(body.expectedVersion) ? body.expectedVersion : null;
    const id = +meetingId;
    const runWrite = withImmediate(() => {
      const m = meeting(id);
      const r = room(m.room_id);
      const isOrganizer = m.organizer_id === user.id || user.role === 'admin';
      if (!isOrganizer) {
        const g = db.prepare(`SELECT 1 FROM room_grants WHERE room_id=? AND user_id=? AND revoked_at IS NULL AND role='booker'`).get(r.id, user.id);
        if (!g) throw new HttpError(403, 'CHECKIN_FORBIDDEN', 'No permission to check in');
      }
      if (expectedVersion !== null && m.version !== expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'Meeting changed before check-in', { currentVersion: m.version });
      if (m.status === 'cancelled') throw new HttpError(409, 'CANCELLED', 'Cancelled meeting cannot be checked in');
      const t = now();
      // Window is explicit. A stale offline request for a prior booking cannot
      // be accepted after cancellation or once it is fully outside this window.
      if (t < m.startUtc - 10 * 60 * 1000) throw new HttpError(409, 'CHECKIN_TOO_EARLY', 'Check-in opens ten minutes before start', { opensAtUtc: m.startUtc - 10 * 60 * 1000 });
      if (t > m.endUtc) throw new HttpError(409, 'CHECKIN_CLOSED', 'Meeting has ended');
      if (m.status !== 'checked_in') {
        db.prepare(`UPDATE meetings SET status='checked_in',checked_in_at=?,checked_in_by=?,updated_at=?,version=version+1 WHERE id=?`)
          .run(t, user.id, t, m.id);
        logEvent(db, m.id, 'checked_in', user.id, { atUtc: t, source: 'online', fromVersion: m.version });
      }
      return m.id;
    });
    return getMeetingView(user, runWrite());
  }

  function effectivePrivacy(m, r) {
    if (m.privacy === 'full_subject') return 'full_subject';
    if (m.privacy === 'busy_only') return 'busy_only';
    return r.default_privacy;
  }

  function meetingResponse(m, viewer = null) {
    const r = room(m.room_id);
    const org = db.prepare('SELECT id,email,display_name FROM users WHERE id=?').get(m.organizer_id);
    const canSeeDetails = viewer && (viewer.role === 'admin' || m.organizer_id === viewer.id || hasBookerAt(viewer.id, r.id));
    const priv = effectivePrivacy(m, r);
    return {
      id: m.id,
      roomId: m.room_id,
      roomName: r.name,
      organizer: org,
      subject: canSeeDetails ? m.subject : (priv === 'full_subject' ? m.subject : 'Busy'),
      subjectVisibility: canSeeDetails ? 'full_authorized' : priv,
      status: m.status,
      privacy: m.privacy,
      effectivePrivacy: priv,
      checkedInAtUtc: m.checked_in_at,
      version: m.version,
      time: meetingTimeView(m),
      updatedAtUtc: m.updated_at
    };
  }

  function hasBookerAt(userId, roomId) {
    return !!db.prepare(`SELECT 1 FROM room_grants WHERE room_id=? AND user_id=? AND revoked_at IS NULL AND role='booker' LIMIT 1`).get(roomId, userId);
  }

  function getMeetingView(user, id) { const m = meeting(id); canViewRoom(user, m.room_id); return meetingResponse(m, user); }
  function conflictView(m) {
    const view = { id: m.id, status: m.status, version: m.version, time: meetingTimeView(m, m.timezone) };
    if (m.start_local) view.time.startLocal = m.start_local;
    if (m.end_local) view.time.endLocal = m.end_local;
    return view;
  }

  function listMeetings(user, query) {
    const roomId = +query.roomId;
    const r = room(roomId);
    canViewRoom(user, roomId);
    const from = query.fromUtc ? +query.fromUtc : now() - 24 * 3600 * 1000;
    const to = query.toUtc ? +query.toUtc : now() + 14 * 24 * 3600 * 1000;
    return db.prepare(`SELECT * FROM meetings WHERE room_id=? AND endUtc>? AND startUtc<? ORDER BY startUtc`)
      .all(roomId, from, to).map(m => meetingResponse(m, user));
  }

  function sanitizeMeetingBody(body) {
    const subject = String(body.subject || '').trim().slice(0, 200);
    if (!subject) throw new HttpError(400, 'BAD_SUBJECT', 'Subject is required');
    return { subject };
  }
  function validatePrivacy(p) {
    if (!['inherit', 'full_subject', 'busy_only'].includes(p)) throw new HttpError(400, 'BAD_PRIVACY', 'Invalid privacy setting');
    return p;
  }

  function setPrivacy(user, meetingId, body) {
    const m = meeting(+meetingId);
    if (m.organizer_id !== user.id && user.role !== 'admin') throw new HttpError(403, 'MEETING_FORBIDDEN', 'Only organizer can set privacy');
    const privacy = validatePrivacy(body.privacy);
    const t = now();
    db.prepare('UPDATE meetings SET privacy=?,updated_at=?,version=version+1 WHERE id=?').run(privacy, t, m.id);
    logEvent(db, m.id, 'privacy_changed', user.id, { privacy, fromVersion: m.version });
    return getMeetingView(user, m.id);
  }

  function listRooms(user) {
    return db.prepare(`SELECT r.* FROM rooms r
      WHERE r.id IN (SELECT room_id FROM room_grants WHERE user_id=? AND revoked_at IS NULL)
      OR ?='admin' ORDER BY r.name`).all(user.id, user.role).map(r => ({
      id: r.id, name: r.name, timezone: r.timezone, defaultPrivacy: r.default_privacy, backgroundUrl: r.background_url
    }));
  }

  function updateTemplate(user, roomId, body) {
    const r = room(+roomId);
    ensureRole(user, r.id, 'template_editor');
    const url = String(body.backgroundUrl || '').trim().split('?')[0];
    if (!/^\/assets\/[A-Za-z0-9._/-]+$/.test(url)) throw new HttpError(400, 'BAD_ASSET', 'Template URL must be a local /assets path');
    db.prepare('BEGIN IMMEDIATE').run();
    try {
      db.prepare('UPDATE rooms SET background_url=? WHERE id=?').run(url, r.id);
      db.prepare(`INSERT INTO background_assets(room_id,editor_user_id,url,created_at) VALUES(?,?,?,?)
        ON CONFLICT(url) DO UPDATE SET editor_user_id=excluded.editor_user_id`).run(r.id, user.id, url, now());
      db.prepare(`INSERT OR IGNORE INTO background_acl(asset_id,room_id,can_read_meeting_details)
        VALUES((SELECT id FROM background_assets WHERE url=?),?,0)`).run(url, r.id);
      db.prepare('COMMIT').run();
    } catch (e) { db.prepare('ROLLBACK').run(); throw e; }
    // Deliberately returns no meeting subjects/status. Template management is
    // separated from meeting read capability.
    return { roomId: r.id, backgroundUrl: url, meetingDetailsAccessible: false };
  }

  function revokeGrant(admin, roomId, userId) {
    if (admin.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Admin only');
    const run = withImmediate(() => {
      const t = now();
      const info = db.prepare(`UPDATE room_grants SET revoked_at=? WHERE room_id=? AND user_id=? AND revoked_at IS NULL`)
        .run(t, +roomId, +userId);
      if (info.changes === 0) throw new HttpError(404, 'GRANT_NOT_FOUND', 'Active grant not found');
      // Any room authorization change invalidates device cached write authority;
      // read snapshots still require a valid device token and server re-fetch.
      db.prepare('UPDATE devices SET permission_epoch=permission_epoch+1, cached_meeting_ids=? WHERE room_id=?').run('[]', +roomId);
      return t;
    });
    const t = run();
    return { revoked: true, roomId: +roomId, userId: +userId, atUtc: t };
  }

  function revokeDevice(admin, deviceId) {
    if (admin.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Only admin can revoke door devices');
    const t = now();
    const info = db.prepare(`UPDATE devices SET revoked_at=?, cached_meeting_ids=? WHERE id=? AND revoked_at IS NULL`)
      .run(t, '[]', +deviceId);
    if (info.changes === 0) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Active device not found');
    return { revoked: true, deviceId: +deviceId, atUtc: t };
  }

  function registerDevice(admin, body) {

    if (admin.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Only admin can register door displays');
    const r = room(+body.roomId);
    const policy = body.offlinePolicy === 'offline_checkin_allowed' ? 'offline_checkin_allowed' : 'cache_view_only';
    const name = String(body.name || 'Door').slice(0, 80);
    const rawId = crypto.randomBytes(16).toString('hex');
    const issuedAt = now();
    const payload = { did: rawId, roomId: r.id, policy, iat: issuedAt };
    const payloadB64 = base64urlJson(payload);
    const sig = sign(payloadB64, secret);
    const deviceToken = `${payloadB64}.${sig}`;
    db.prepare(`INSERT INTO devices(room_id,name,token_hash,offline_policy,created_at) VALUES(?,?,?,?,?)`)
      .run(r.id, name, hashToken(deviceToken), policy, issuedAt);
    return { deviceToken, roomId: r.id, roomName: r.name, name, offlinePolicy: policy, issuedAtUtc: issuedAt };
  }

  function verifyDeviceToken(deviceToken) {
    const [p, s] = String(deviceToken || '').split('.');
    if (!p || !s) throw new HttpError(401, 'BAD_DEVICE_TOKEN', 'Malformed device token');
    const expected = sign(p, secret);
    const givenSig = Buffer.from(s);
    const expectedSig = Buffer.from(expected);
    if (givenSig.length !== expectedSig.length || !crypto.timingSafeEqual(givenSig, expectedSig)) {
      throw new HttpError(401, 'BAD_DEVICE_SIGNATURE', 'Invalid device token');
    }
    let payload;
    try { payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw new HttpError(401, 'BAD_DEVICE_TOKEN', 'Malformed device token'); }
    const d = db.prepare('SELECT * FROM devices WHERE token_hash=?').get(hashToken(deviceToken));
    if (!d) throw new HttpError(401, 'DEVICE_UNKNOWN', 'Device is not registered');
    if (payload.roomId !== d.room_id || payload.policy !== d.offline_policy) throw new HttpError(401, 'DEVICE_POLICY_CHANGED', 'Device token policy is stale');
    if (d.revoked_at) throw new HttpError(401, 'DEVICE_REVOKED', 'Device authorization was revoked');
    return { device: d, payload };
  }

  function doorSnapshot(deviceToken, query = {}) {
    const { device } = verifyDeviceToken(deviceToken);
    const r = room(device.room_id);
    const t = now();
    db.prepare('UPDATE devices SET last_seen_at=?,last_server_clock_utc=? WHERE id=?').run(t, t, device.id);
    const rows = db.prepare(`SELECT * FROM meetings WHERE room_id=? AND endUtc>? AND startUtc<?
      AND status IN ('booked','checked_in') ORDER BY startUtc`).all(r.id, t - 30 * 60 * 1000, t + 400 * 24 * 3600 * 1000);
    const meetings = rows.map(m => doorMeeting(m, r, { includeDetails: true }));
    db.prepare('UPDATE devices SET cached_meeting_ids=? WHERE id=?').run(JSON.stringify(meetings.map(m => m.id)), device.id);
    const current = meetings.find(m => t >= m.time.startUtc && t < m.time.endUtc) || null;
    const next = meetings.find(m => m.time.startUtc > t) || null;
    return {
      schemaVersion: 1,
      generatedAtUtc: t,
      serverTimeUtc: t,
      expiresAtUtc: t + 60 * 1000,
      room: { id: r.id, name: r.name, timezone: r.timezone, backgroundUrl: r.background_url, defaultPrivacy: r.default_privacy },
      device: {
        id: device.id, name: device.name, offlinePolicy: device.offline_policy,
        permissionEpoch: device.permission_epoch,
        cachedMeetingIds: JSON.parse(device.cached_meeting_ids || '[]')
      },
      current, next,
      meetings,
      freshness: { state: 'fresh', source: 'server', staleAfterUtc: t + 60 * 1000 }
    };
  }

  function doorMeeting(m, r, { includeDetails } = { includeDetails: true }) {
    const priv = effectivePrivacy(m, r);
    const full = includeDetails && priv === 'full_subject';
    return {
      id: m.id,
      // Door displays only receive subject when the room's meeting setting says
      // so. Busy-only is a stable opaque meeting identity for local cache keys.
      subject: full ? m.subject : 'Busy',
      displayMode: priv === 'full_subject' ? 'full_subject' : 'busy_only',
      status: m.status,
      version: m.version,
      time: meetingTimeView(m, r.timezone)
    };
  }

  // Offline strategy is explicit on every device:
  // - offline_checkin_allowed: show cache and sign a check-in for a meeting the
  //   device had cached while its room permission epoch was current.
  // - cache_view_only: refuse; door can display stale cache with visible age.
  function offlineCheckin(deviceToken, body) {
    const { device } = verifyDeviceToken(deviceToken);
    const t = now();
    const meetingId = +body.meetingId;
    const clientClock = +body.clientClockUtc;
    const observed = body.lastKnownServerClockUtc == null ? null : +body.lastKnownServerClockUtc;
  const confirmation = String(body.confirmation || '');
    const deviceEstimatedSkew = Math.max(0, +body.maxAbsClockSkewMs || 5 * 60 * 1000);
    // The client may report its estimated drift but cannot widen the server's
    // acceptance envelope to recycle an old confirmation.
    const maxSkew = Math.min(deviceEstimatedSkew, 5 * 60 * 1000);
    if (!Number.isFinite(clientClock)) throw new HttpError(400, 'BAD_CLOCK', 'Client clock is required');
    if (!confirmation || confirmation.length > 200 || !/^[A-Za-z0-9:._\-]+$/.test(confirmation)) throw new HttpError(400, 'NO_CONFIRMATION', 'Offline confirmation must be a short URL-safe nonce');
    if (device.offline_policy !== 'offline_checkin_allowed') {
      throw new HttpError(403, 'OFFLINE_CHECKIN_DISABLED', 'This door is configured for cache viewing only');
    }
    const runWrite = withImmediate(() => {
      const dev = db.prepare('SELECT * FROM devices WHERE id=?').get(device.id);
      if (dev.revoked_at) throw new HttpError(401, 'DEVICE_REVOKED', 'Device revoked');
      const m = meeting(meetingId);
      if (m.room_id !== dev.room_id) throw new HttpError(403, 'WRONG_ROOM', 'Meeting does not belong to this door');
      const info = db.prepare(`INSERT INTO device_cache_checkins(
        device_id,meeting_id,client_clock_utc,device_observed_server_clock_utc,max_abs_clock_skew_ms,
        signed_confirmation,status,received_at_utc,created_at_utc)
        VALUES(?,?,?,?,?,?, 'pending', ?,?)`).run(dev.id, meetingId, clientClock, observed, maxSkew, confirmation, t, t);
      const id = info.lastInsertRowid;
      decideOfflineCheckin(db, id);
      return id;
    });
    const row = db.prepare('SELECT * FROM device_cache_checkins WHERE id=?').get(runWrite());
    return offlineDecisionView(row);
  }

  function decideOfflineCheckin(tx, id) {
    const row = tx.prepare('SELECT * FROM device_cache_checkins WHERE id=?').get(id);
    const m = tx.prepare('SELECT * FROM meetings WHERE id=?').get(row.meeting_id);
    const dev = tx.prepare('SELECT * FROM devices WHERE id=?').get(row.device_id);
    const t = now();
    let status = 'accepted';
    let reason = null;
    const cachedIds = JSON.parse(dev.cached_meeting_ids || '[]');
    if (dev.revoked_at) { status = 'rejected_device_revoked'; reason = 'device authorization was revoked before upload'; }
    else if (!cachedIds.includes(m.id)) { status = 'rejected_stale'; reason = 'meeting identity was not present in the door\'s last authorized cache'; }
    else if (m.status === 'cancelled') { status = 'rejected_cancelled'; reason = 'meeting was revoked/cancelled; old confirmation cannot create an attendance fact'; }
    else if (m.status === 'checked_in') {
      status = 'rejected_duplicate';
      reason = 'meeting already had one durable check-in; duplicate offline confirmation is retained but not applied';
    }
    if (status === 'accepted') {
      // Device clock is not trusted. The request is only valid if both the
      // client clock and the last server-synchronized clock (with its advertised
      // skew tolerance) intersect the server-side check-in window.
      const opens = m.startUtc - 10 * 60 * 1000;
      const closes = m.endUtc;
      const clientEarliest = row.client_clock_utc - row.max_abs_clock_skew_ms;
      const clientLatest = row.client_clock_utc + row.max_abs_clock_skew_ms;
      if (clientLatest < opens || clientEarliest > closes) {
        status = 'rejected_outside_window'; reason = 'device clock uncertainty does not intersect check-in window';
      } else if (row.device_observed_server_clock_utc != null) {
        const syncAge = t - row.device_observed_server_clock_utc;
        // Require reasonably recent sync for offline writes; read-only cache can be older.
        if (syncAge > 72 * 3600 * 1000 + row.max_abs_clock_skew_ms) {
          status = 'rejected_stale'; reason = 'last trusted synchronization is too old';
        }
      } else {
        status = 'rejected_stale'; reason = 'offline confirmation lacks last known server time';
      }
    }
    tx.prepare(`UPDATE device_cache_checkins SET status=?,decided_at_utc=?,rejection_reason=? WHERE id=?`)
      .run(status, t, reason, id);
    if (status === 'accepted' && m.status !== 'checked_in') {
      tx.prepare(`UPDATE meetings SET status='checked_in',checked_in_at=?,checked_in_by=NULL,updated_at=?,version=version+1 WHERE id=?`)
        .run(Math.max(m.startUtc - 10 * 60 * 1000, Math.min(t, m.endUtc - 1)), t, m.id);
      logEvent(tx, m.id, 'checked_in', null, { atUtc: t, source: 'offline_reconciled', deviceCheckinId: id });
    }
  }

  function offlineDecisionView(row) {
    return { id: row.id, meetingId: row.meeting_id, status: row.status, decidedAtUtc: row.decided_at_utc, rejectionReason: row.rejection_reason };
  }

  function listDeviceCheckins(user, deviceId) {
    if (user.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Admin only');
    return db.prepare('SELECT * FROM device_cache_checkins WHERE device_id=? ORDER BY id').all(+deviceId).map(offlineDecisionView);
  }

  // Returns monotonic events since a cursor. Clients use after reconnect to
  // make out-of-order pushes harmless: stale sequence numbers are skipped, not
  // applied.
  function eventsSince(user, seq) {
    const requested = Math.max(0, +seq || 0);
    const rows = db.prepare(`SELECT e.*, m.room_id FROM meeting_events e JOIN meetings m ON m.id=e.meeting_id
      WHERE e.id > ? ORDER BY e.id LIMIT 500`).all(requested);
    const accessible = user.role === 'admin'
      ? rows
      : rows.filter(row => hasRoomGrant(user.id, row.room_id));
    const lastAll = db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM meeting_events').get().n;
    // Cursor follows the global durable log even if filtered events are hidden,
    // preventing re-delivery after permission changes.
    return {
      serverNowUtc: now(),
      cursor: Math.max(requested, lastAll),
      events: accessible.map(row => ({ id: row.id, meetingId: row.meeting_id, meetingSeq: row.seq, type: row.type, atUtc: row.at_utc, payload: JSON.parse(row.payload_json) }))
    };
  }
  function hasRoomGrant(userId, roomId) {
    return !!db.prepare(`SELECT 1 FROM room_grants
      WHERE user_id=? AND room_id=? AND revoked_at IS NULL
        AND role IN ('booker','viewer') LIMIT 1`).get(userId, roomId);
  }

  function setRoomPrivacy(admin, roomId, body) {
    if (admin.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Admin only');
    const r = room(+roomId);
    const p = body.defaultPrivacy === 'full_subject' ? 'full_subject' : 'busy_only';
    db.prepare('UPDATE rooms SET default_privacy=? WHERE id=?').run(p, r.id);
    return { roomId: r.id, defaultPrivacy: p };
  }

  return {
    login, logout, requireUser, listRooms, listMeetings, createMeeting, reschedule, extendMeeting, cancel,
    checkin, setPrivacy, getMeeting: (user, id) => getMeetingView(user, id), updateTemplate, revokeGrant,
    registerDevice, revokeDevice, doorSnapshot, offlineCheckin, listDeviceCheckins, eventsSince, setRoomPrivacy, db, secret
  };
}

function publicUser(u) { return { id: u.id, email: u.email, displayName: u.display_name, role: u.role }; }

module.exports = { createService, HttpError, publicUser };
