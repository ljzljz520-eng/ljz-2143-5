'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { openDb, seed } = require('./db');
const { createStore, publicMeet } = require('./store');
const { createAuth } = require('./auth');
const { wallToUtc, utcToWall, httpError } = require('./time');
const { computeDisplay, updateClockOffset, correctedMs } = require('./state');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

function createServer({ dbFile = process.env.DB_FILE || './data/meetings.db' } = {}) {
  const db = openDb(dbFile);
  const tokens = seed(db);
  const store = createStore(db);
  const auth = createAuth(db);

  // 内存态：SSE 订阅者、签到挑战码、可模拟的背景加载失败开关
  const sseClients = new Set();
  const challenges = new Map(); // meetingId -> {nonce, expiresMs}
  const failBg = new Set();     // backgroundUrl 集合 -> 强制 503
  function challengeFor(m, nowMs) {
    let c = challenges.get(m.id);
    if (!c || c.expiresMs < nowMs) {
      c = { nonce: 'ch_' + Math.random().toString(36).slice(2, 10), expiresMs: nowMs + 10 * 60e3 };
      challenges.set(m.id, c);
    }
    return c.nonce;
  }

  function emitEvent(roomId, kind, payload, nowMs = Date.now()) {
    const seq = store.emit(roomId, kind, payload, nowMs);
    const ev = { seq, roomId, kind, payload, emittedMs: nowMs };
    for (const { roomFilter, res } of sseClients) {
      if (roomFilter == null || roomFilter === roomId) {
        res.write(`id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
    }
    return ev;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1e6) reject(httpError(413, 'TOO_BIG')); });
      req.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)); } catch { reject(httpError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
      });
      req.on('error', reject);
    });
  }

  function roomMeetings(roomId) {
    return db.prepare(`SELECT * FROM meetings WHERE room_id=? AND status!='cancelled'
      ORDER BY start_ms`).all(roomId);
  }
  function roomOr404(roomId) {
    const r = db.prepare('SELECT * FROM rooms WHERE id=?').get(roomId);
    if (!r) throw httpError(404, 'NO_ROOM', '房间不存在');
    return r;
  }
  // 解析 {startLocal,endLocal,date,time,...} 或 epoch ms
  function resolveRange(room, body) {
    if (Number.isFinite(body.startMs) && Number.isFinite(body.endMs)) {
      return { startMs: body.startMs, endMs: body.endMs };
    }
    const s = wallToUtc({ date: body.date, time: body.startLocal || body.time, tz: room.tz,
      disambiguation: body.startDisambiguation });
    // 结束时刻支持单独日期/时间与 disambiguation
    const eDate = body.endDate || body.date;
    const e = wallToUtc({ date: eDate, time: body.endLocal, tz: room.tz,
      disambiguation: body.endDisambiguation });
    if (e.utcMs <= s.utcMs) throw httpError(400, 'BAD_RANGE', '结束必须晚于开始（区间 [start,end)）');
    return { startMs: s.utcMs, endMs: e.utcMs,
      startAmbiguous: s.ambiguous, endAmbiguous: e.ambiguous };
  }

  function displayState(room, nowMs, opts = {}) {
    const ms = meetingsForDisplay(room.id, nowMs);
    const tpls = db.prepare('SELECT * FROM templates').all();
    const d = db.prepare('SELECT * FROM displays WHERE room_id=?').get(room.id);
    const v = computeDisplay({ room, meetings: ms, templates: tpls, nowMs,
      privacy: opts.privacy });
    if (opts.withChallenge && v.meeting) v.meeting.challenge = challengeFor(v.meeting, nowMs);
    v.display = d ? {
      lastSeenMs: d.last_seen_ms, ageMs: nowMs - d.last_seen_ms,
      clockOffsetMs: d.clock_offset_ms, lastAppliedVersion: d.last_applied_version,
      fresh: nowMs - d.last_seen_ms < 90e3,
    } : { fresh: false, lastSeenMs: null };
    v.serverMs = nowMs;
    return v;
  }
  function meetingsForDisplay(roomId, nowMs) {
    // 门牌只需要“当前 + 接下来一场”
    return db.prepare(`SELECT * FROM meetings WHERE room_id=? AND status!='cancelled'
      AND end_ms > ? ORDER BY start_ms LIMIT 3`).all(roomId, nowMs - 6 * 3600e3);
  }

  async function handle(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const now = () => Date.now();
    const send = (code, obj, headers) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(obj));
    };
    try {
      // ---------- 静态 ----------
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        return serveFile(res, path.join(__dirname, '../web/index.html'));
      }
      if (req.method === 'GET' && p.startsWith('/static/')) {
        if (failBg.has(p)) return send(503, { error: 'BG_FAILED', message: '背景素材不可用（模拟）' });
        return serveFile(res, path.join(__dirname, decodeURIComponent(p.replace(/^\//, ''))));
      }

      // ---------- 房间 / 会议查询 ----------
      if (p === '/api/rooms' && req.method === 'GET') {
        return send(200, { rooms: db.prepare('SELECT id,code,name,tz,checkin_policy,checkin_grace_min FROM rooms ORDER BY id').all() });
      }
      let mm;
      if ((mm = /^\/api\/rooms\/(\d+)\/meetings$/.exec(p)) && req.method === 'GET') {
        const room = roomOr404(+mm[1]);
        const from = u.searchParams.get('fromMs');
        const to = u.searchParams.get('toMs');
        let rows = roomMeetings(room.id);
        if (from) rows = rows.filter((x) => x.end_ms > +from);
        if (to) rows = rows.filter((x) => x.start_ms < +to);
        return send(200, {
          room: { id: room.id, code: room.code, name: room.name, tz: room.tz,
            policy: room.checkin_policy, graceMin: room.checkin_grace_min },
          // 预约事实：UTC 区间 + 房间本地墙上时间同时给出
          meetings: rows.map((x) => ({ ...publicMeet(x),
            localStart: utcToWall(x.start_ms, room.tz), localEnd: utcToWall(x.end_ms, room.tz) })),
          interval: '[startMs,endMs) — adjacent intervals do not conflict',
          serverMs: now(),
        });
      }
      if ((mm = /^\/api\/meetings\/(\d+)$/.exec(p)) && req.method === 'GET') {
        const row = db.prepare('SELECT * FROM meetings WHERE id=?').get(+mm[1]);
        if (!row) throw httpError(404, 'NO_MEETING');
        const room = roomOr404(row.room_id);
        return send(200, { ...publicMeet(row),
          localStart: utcToWall(row.start_ms, room.tz), localEnd: utcToWall(row.end_ms, room.tz) });
      }

      // ---------- 预约 / 改期 / 延长 / 撤销 / 签到 ----------
      if ((mm = /^\/api\/rooms\/(\d+)\/meetings$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req);
        const room = roomOr404(+mm[1]);
        const body = await readJson(req);
        if (!body.topic || !String(body.topic).trim()) throw httpError(400, 'NO_TOPIC', '需要主题');
        const range = resolveRange(room, body);
        const m = store.book({ roomId: room.id, userId: user.uid, topic: String(body.topic).trim(),
          startMs: range.startMs, endMs: range.endMs, nowMs: now() });
        const ev = emitEvent(room.id, 'meeting.booked', publicMeet(m));
        return send(201, { meeting: { ...publicMeet(m),
          localStart: utcToWall(m.start_ms, room.tz), localEnd: utcToWall(m.end_ms, room.tz),
          startAmbiguous: !!range.startAmbiguous }, eventSeq: ev.seq });
      }
      if ((mm = /^\/api\/meetings\/(\d+)\/reschedule$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req);
        const body = await readJson(req);
        const old = db.prepare('SELECT * FROM meetings WHERE id=?').get(+mm[1]);
        if (!old) throw httpError(404, 'NO_MEETING');
        if (old.status === 'checked_in') throw httpError(409, 'ALREADY_CHECKED_IN', '已签到的会议请使用延长/取消，不允许改期');
        const room = roomOr404(old.room_id);
        // 支持 epoch ms 或房间本地墙上时间（含 DST 消歧）；缺省沿用原时间
        let startMs, endMs;
        if (Number.isFinite(body.startMs) || Number.isFinite(body.endMs)) {
          startMs = body.startMs ?? old.start_ms;
          endMs = body.endMs ?? old.end_ms;
        } else if (body.startLocal || body.endLocal || body.date) {
          const oldStartWall = utcToWall(old.start_ms, room.tz);
          const rr = resolveRange(room, {
            date: body.date || (body.startLocal ? oldStartWall.date : undefined),
            startLocal: body.startLocal || oldStartWall.time,
            startDisambiguation: body.startDisambiguation,
            endDate: body.endDate || body.date || oldStartWall.date,
            endLocal: body.endLocal || utcToWall(old.end_ms, room.tz).time,
            endDisambiguation: body.endDisambiguation,
          });
          startMs = rr.startMs; endMs = rr.endMs;
        } else {
          throw httpError(400, 'NO_RANGE', '需要 startMs/endMs 或 date/startLocal/endLocal');
        }
        const m = store.reschedule({ meetingId: +mm[1], userId: user.uid,
          isAdmin: user.role === 'admin', startMs, endMs, nowMs: now() });
        const ev = emitEvent(room.id, 'meeting.rescheduled', publicMeet(m));
        return send(200, { meeting: { ...publicMeet(m),
          localStart: utcToWall(m.start_ms, room.tz), localEnd: utcToWall(m.end_ms, room.tz) },
          eventSeq: ev.seq });
      }
      if ((mm = /^\/api\/meetings\/(\d+)\/extend$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req);
        const body = await readJson(req);
        const old = db.prepare('SELECT * FROM meetings WHERE id=?').get(+mm[1]);
        if (!old) throw httpError(404, 'NO_MEETING');
        const room = roomOr404(old.room_id);
        let newEnd;
        if (Number.isFinite(body.newEndMs)) newEnd = body.newEndMs;
        else if (body.endLocal) newEnd = wallToUtc({ date: body.endDate, time: body.endLocal,
          tz: room.tz, disambiguation: body.endDisambiguation }).utcMs;
        else if (body.minutes) newEnd = old.end_ms + body.minutes * 60e3;
        else throw httpError(400, 'NO_NEW_END', '需要 newEndMs / endLocal / minutes');
        const m = store.extend({ meetingId: +mm[1], userId: user.uid,
          isAdmin: user.role === 'admin', newEndMs: newEnd });
        const ev = emitEvent(room.id, 'meeting.extended', publicMeet(m));
        return send(200, { meeting: { ...publicMeet(m), localEnd: utcToWall(m.end_ms, room.tz) },
          eventSeq: ev.seq });
      }
      if ((mm = /^\/api\/meetings\/(\d+)\/cancel$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req);
        const old = db.prepare('SELECT * FROM meetings WHERE id=?').get(+mm[1]);
        if (!old) throw httpError(404, 'NO_MEETING');
        const room = roomOr404(old.room_id);
        const m = store.cancel({ meetingId: +mm[1], userId: user.uid, isAdmin: user.role === 'admin' });
        const ev = emitEvent(room.id, 'meeting.cancelled', publicMeet(m));
        return send(200, { meeting: publicMeet(m), eventSeq: ev.seq });
      }
      if ((mm = /^\/api\/meetings\/(\d+)\/checkin$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req);
        const body = await readJson(req) || {};
        const old = db.prepare('SELECT * FROM meetings WHERE id=?').get(+mm[1]);
        if (!old) throw httpError(404, 'NO_MEETING');
        const room = roomOr404(old.room_id);
        // 在线签到可校验挑战码（门牌展示 -> 用户在网页签到），挑战码一次性消费
        if (body.challenge) {
          const c = challenges.get(old.id);
          if (!c || c.nonce !== body.challenge || c.expiresMs < now()) {
            throw httpError(409, 'BAD_CHALLENGE', '签到码无效或已过期');
          }
        }
        const m = store.checkin({ meetingId: +mm[1], userId: user.uid, nowMs: now(),
          graceMin: room.checkin_grace_min, offline: false });
        challenges.delete(old.id);
        const ev = emitEvent(room.id, 'meeting.checked_in', publicMeet(m));
        return send(200, { meeting: publicMeet(m), eventSeq: ev.seq });
      }

      // ---------- 门牌设备 ----------
      // 门牌视图（无需用户令牌，设备端点；含挑战码与模板地址）
      if ((mm = /^\/api\/displays\/(\d+)\/state$/.exec(p)) && req.method === 'GET') {
        const room = roomOr404(+mm[1]);
        // 心跳：设备每次轮询上报 deviceMs；服务器记录漂移与新鲜度
        const devMs = u.searchParams.get('deviceMs');
        let state;
        if (devMs) {
          const sNow = now();
          const prev = db.prepare('SELECT * FROM displays WHERE room_id=?').get(room.id);
          const off = updateClockOffset(prev ? prev.clock_offset_ms : null, sNow, +devMs);
          db.prepare(`INSERT INTO displays(room_id,last_seen_ms,clock_offset_ms,last_applied_version)
            VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET last_seen_ms=excluded.last_seen_ms,
            clock_offset_ms=excluded.clock_offset_ms`)
            .run(room.id, sNow, off, prev ? prev.last_applied_version : null);
        }
        const qpPriv = u.searchParams.get('privacy');
        const privacy = qpPriv ? qpPriv : room.privacy;
        state = displayState(room, now(), { withChallenge: true, privacy });
        // 版本化 ETag：内容没变时设备可走 304（弱网友好）
        const etag = `"r${room.id}-v${(state.meeting && state.meeting.version) || 0}-${state.status}-${privacy}"`;
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
        return send(200, state, { etag, 'cache-control': 'no-store' });
      }
      // 设备确认已应用到屏幕的版本
      if ((mm = /^\/api\/displays\/(\d+)\/applied$/.exec(p)) && req.method === 'POST') {
        const room = roomOr404(+mm[1]);
        const body = await readJson(req);
        db.prepare(`INSERT INTO displays(room_id,last_seen_ms,clock_offset_ms,last_applied_version)
          VALUES(?,?,0,?) ON CONFLICT(room_id) DO UPDATE SET last_applied_version=excluded.last_applied_version`)
          .run(room.id, now(), body.version ?? null);
        return send(200, { ok: true });
      }
      // 离线签到（仅 checkin_policy=offline_allowed 的房间）。
      // 设备缓存排队，重连后补提；服务器用漂移校准后的 claimedMs 判窗，
      // 并对已撤销/已改期的会议给出确定的拒绝结果。
      if ((mm = /^\/api\/displays\/(\d+)\/checkins$/.exec(p)) && req.method === 'POST') {
        const room = roomOr404(+mm[1]);
        const body = await readJson(req);
        const user = auth.authenticate(req); // 设备保存的仍是用户令牌；令牌被删则离线签到也失败
        const disp = db.prepare('SELECT * FROM displays WHERE room_id=?').get(room.id);
        const claimed = correctedMs(+body.deviceMs, disp ? disp.clock_offset_ms : 0);
        const results = [];
        for (const item of body.queue || []) {
          try {
            const m = store.checkin({ meetingId: item.meetingId, userId: user.uid, nowMs: now(),
              graceMin: room.checkin_grace_min, offline: true, claimedMs: claimed });
            const ev = emitEvent(room.id, 'meeting.checked_in', { ...publicMeet(m), offline: true });
            results.push({ meetingId: item.meetingId, ok: true, eventSeq: ev.seq });
          } catch (e) {
            // 旧确认（会议已撤销/改期后不匹配）明确返回失败，设备清除本地“已确认”标记
            results.push({ meetingId: item.meetingId, ok: false, code: e.code, message: e.message,
              ...(e.extra ? { extra: e.extra } : {}) });
          }
        }
        return send(207, { results, correctedClaimedMs: claimed });
      }

      // ---------- SSE 推送（网页/设备） ----------
      if (p === '/api/events' && req.method === 'GET') {
        const roomParam = u.searchParams.get('roomId');
        const roomFilter = roomParam ? +roomParam : null;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
          connection: 'keep-alive' });
        const client = { roomFilter, res };
        sseClients.add(client);
        // 补发连接以来错过的事件
        const after = +(u.searchParams.get('afterSeq') || 0);
        if (after > 0) {
          const replay = roomFilter == null
            ? db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq').all(after)
            : db.prepare('SELECT * FROM events WHERE seq>? AND (room_id=? OR room_id IS NULL) ORDER BY seq').all(after, roomFilter);
          for (const e of replay) {
            res.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify({ seq: e.seq,
              roomId: e.room_id, kind: e.kind, payload: JSON.parse(e.payload_json),
              emittedMs: e.emitted_ms })}\n\n`);
          }
        }
        res.write(`event: hello\ndata: ${JSON.stringify({ serverMs: now() })}\n\n`);
        const ka = setInterval(() => res.write(': ka\n\n'), 25e3);
        req.on('close', () => { clearInterval(ka); sseClients.delete(client); });
        return;
      }

      // ---------- 模板（模板编辑者；只能读写背景与排版，读不到任何会议数据） ----------
      if (p === '/api/templates' && req.method === 'GET') {
        auth.authenticate(req);
        return send(200, { templates: db.prepare('SELECT id,room_id,name,background_url,layout_json,editor_id FROM templates').all() });
      }
      if (p === '/api/templates' && req.method === 'POST') {
        const user = auth.authenticate(req);
        auth.requireTemplateEditor(user);
        const body = await readJson(req);
        if (!body.name || !body.backgroundUrl) throw httpError(400, 'BAD_TEMPLATE', '需要 name/backgroundUrl');
        const r = db.prepare(`INSERT INTO templates(room_id,name,background_url,layout_json,editor_id)
          VALUES(?,?,?,?,?)`).run(body.roomId ?? null, body.name, body.backgroundUrl,
          JSON.stringify(body.layout || {}), user.uid);
        if (body.roomId) db.prepare('UPDATE rooms SET active_template_id=? WHERE id=?').run(r.lastInsertRowid, body.roomId);
        return send(201, { templateId: r.lastInsertRowid });
      }
      if ((mm = /^\/api\/templates\/(\d+)$/.exec(p)) && ['PUT', 'PATCH'].includes(req.method)) {
        const user = auth.authenticate(req);
        auth.requireTemplateEditor(user);
        const body = await readJson(req);
        const t = db.prepare('SELECT * FROM templates WHERE id=?').get(+mm[1]);
        if (!t) throw httpError(404, 'NO_TEMPLATE');
        db.prepare('UPDATE templates SET background_url=?, layout_json=? WHERE id=?')
          .run(body.backgroundUrl ?? t.background_url,
            JSON.stringify(body.layout ?? safeJson(t.layout_json)), +mm[1]);
        return send(200, { ok: true });
      }

      // ---------- 管理员：隐私开关、房间策略、令牌回收、背景失败模拟 ----------
      if (p === '/api/admin/rooms' && req.method === 'POST') {
        const user = auth.authenticate(req); auth.requireAdmin(user);
        const body = await readJson(req);
        const r = db.prepare('INSERT INTO rooms(code,name,tz,checkin_policy,checkin_grace_min) VALUES(?,?,?,?,?)')
          .run(body.code, body.name, body.tz || 'UTC',
            body.checkinPolicy || 'online_only', body.graceMin ?? 10);
        return send(201, { roomId: r.lastInsertRowid });
      }
      if ((mm = /^\/api\/admin\/rooms\/(\d+)\/policy$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req); auth.requireAdmin(user);
        const room = roomOr404(+mm[1]);
        const body = await readJson(req);
        const policy = body.checkinPolicy === 'offline_allowed' ? 'offline_allowed'
          : body.checkinPolicy === 'online_only' ? 'online_only' : room.checkin_policy;
        db.prepare('UPDATE rooms SET checkin_policy=?, checkin_grace_min=? WHERE id=?')
          .run(policy, body.graceMin ?? room.checkin_grace_min, room.id);
        const r = db.prepare('SELECT id,code,name,tz,checkin_policy,checkin_grace_min,privacy FROM rooms WHERE id=?').get(room.id);
        return send(200, { room: r });
      }
      if ((mm = /^\/api\/admin\/rooms\/(\d+)\/privacy$/.exec(p)) && req.method === 'POST') {
        const user = auth.authenticate(req); auth.requireAdmin(user);
        const room = roomOr404(+mm[1]);
        const body = await readJson(req);
        const privacy = body.privacy === 'private' ? 'private' : 'normal';
        db.prepare('UPDATE rooms SET privacy=? WHERE id=?').run(privacy, room.id);
        return send(200, { ok: true, privacy });
      }
      if ((mm = /^\/api\/admin\/tokens\/([\w-]+)$/.exec(p)) && req.method === 'DELETE') {
        const user = auth.authenticate(req); auth.requireAdmin(user);
        db.prepare('DELETE FROM tokens WHERE token=?').run(mm[1]);
        return send(200, { ok: true });
      }
      if (p === '/api/admin/fail-background' && req.method === 'POST') {
        const user = auth.authenticate(req); auth.requireAdmin(user);
        const body = await readJson(req);
        if (body.enabled) failBg.add(body.url); else failBg.delete(body.url);
        return send(200, { ok: true, failing: [...failBg] });
      }

      send(404, { error: 'NOT_FOUND', path: p });
    } catch (e) {
      const code = e.status || 500;
      if (code === 500) console.error(e);
      send(code, { error: e.code || 'ERROR', message: e.message, ...(e.extra ? { extra: e.extra } : {}) });
    }
  }

  const server = http.createServer((req, res) => handle(req, res));
  server.locals = { db, tokens, emitEvent, failBg, displayState };
  return server;
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }
function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

if (require.main === module) {
  const port = +(process.env.PORT || 8080);
  const s = createServer();
  s.listen(port, '127.0.0.1', () => {
    const addr = s.address();
    // 固定前缀，供测试进程解析实际端口（port=0 时由系统分配）
    console.log(`meeting-sign listening on http://127.0.0.1:${addr.port} PORT=${addr.port}`);
    console.log('demo tokens:', s.locals.tokens);
  });
}
module.exports = { createServer };
