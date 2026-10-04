'use strict';
// 数据访问 + 事务。better-sqlite3 为同步驱动：
// 每个写事务内部不会被其他请求穿插，因此“查冲突 + 插入”天然原子。
const { httpError } = require('./time');

function createStore(db) {
  // 重叠判定（半开区间）：x.start < y.end AND y.start < x.end
  const Q_OVERLAP = `
    SELECT id, topic, start_ms, end_ms, status FROM meetings
    WHERE room_id=? AND status!='cancelled' AND start_ms < ? AND ? < end_ms
    ORDER BY start_ms`;
  // 相邻区间：a.end == b.start 不算冲突；上面的严格不等式已体现。
  function findConflicts(roomId, startMs, endMs, excludeId) {
    const rows = db.prepare(Q_OVERLAP).all(roomId, endMs, startMs);
    return excludeId ? rows.filter((r) => r.id !== excludeId) : rows;
  }

  // BEGIN IMMEDIATE：拿写锁后再做冲突检查，两个并发预约必有确定的先后结果。
  const txBook = db.transaction(({ roomId, userId, topic, startMs, endMs, nowMs }) => {
    if (endMs <= startMs) throw httpError(400, 'BAD_RANGE', '结束必须晚于开始（区间 [start,end)）');
    const room = db.prepare('SELECT id FROM rooms WHERE id=?').get(roomId);
    if (!room) throw httpError(404, 'NO_ROOM', '房间不存在');
    const c = findConflicts(roomId, startMs, endMs);
    if (c.length) throw httpError(409, 'ROOM_BUSY', '房间时间冲突', { conflicts: c.map(publicMeet) });
    const r = db.prepare(`INSERT INTO meetings
      (room_id, organizer_id, topic, start_ms, end_ms, created_ms)
      VALUES (?,?,?,?,?,?)`).run(roomId, userId, topic, startMs, endMs, nowMs);
    return db.prepare('SELECT * FROM meetings WHERE id=?').get(r.lastInsertRowid);
  });

  const txReschedule = db.transaction(({ meetingId, userId, isAdmin, startMs, endMs, nowMs }) => {
    if (endMs <= startMs) throw httpError(400, 'BAD_RANGE', '结束必须晚于开始（区间 [start,end)）');
    const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
    if (!m) throw httpError(404, 'NO_MEETING', '会议不存在');
    if (m.status === 'cancelled') throw httpError(409, 'MEETING_CANCELLED', '会议已被撤销');
    if (!isAdmin && m.organizer_id !== userId) throw httpError(403, 'FORBIDDEN', '只有组织者或管理员可以改期');
    const c = findConflicts(m.room_id, startMs, endMs, meetingId);
    if (c.length) throw httpError(409, 'ROOM_BUSY', '改期冲突', { conflicts: c.map(publicMeet) });
    // 目标与现状一致时幂等返回，不制造版本抖动（并发重复提交得到同一事实）
    if (m.start_ms !== startMs || m.end_ms !== endMs) {
      db.prepare(`UPDATE meetings SET start_ms=?, end_ms=?, version=version+1 WHERE id=?`)
        .run(startMs, endMs, meetingId);
    }
    return db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
  });

  // 临时延长：必须重新检查下一场会议，而不是只改门牌倒计时。
  const txExtend = db.transaction(({ meetingId, userId, isAdmin, newEndMs }) => {
    const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
    if (!m) throw httpError(404, 'NO_MEETING', '会议不存在');
    if (m.status === 'cancelled') throw httpError(409, 'MEETING_CANCELLED', '会议已被撤销');
    if (!isAdmin && m.organizer_id !== userId) throw httpError(403, 'FORBIDDEN', '只有组织者或管理员可以延长');
    if (newEndMs <= m.end_ms) throw httpError(400, 'BAD_RANGE', '延长后的结束时间必须晚于原结束时间');
    const c = findConflicts(m.room_id, m.start_ms, newEndMs, meetingId);
    if (c.length) {
      const next = c.sort((a, b) => a.start_ms - b.start_ms)[0];
      throw httpError(409, 'NEXT_MEETING_BLOCKS',
        `下一场会议 ${new Date(next.start_ms).toISOString()} 开始，无法延长`,
        { next: publicMeet(next) });
    }
    db.prepare('UPDATE meetings SET end_ms=?, version=version+1 WHERE id=?')
      .run(newEndMs, meetingId);
    return db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
  });

  const txCancel = db.transaction(({ meetingId, userId, isAdmin }) => {
    const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
    if (!m) throw httpError(404, 'NO_MEETING', '会议不存在');
    if (m.status === 'cancelled') return m;
    if (!isAdmin && m.organizer_id !== userId) throw httpError(403, 'FORBIDDEN', '只有组织者或管理员可以撤销');
    db.prepare(`UPDATE meetings SET status='cancelled', version=version+1 WHERE id=?`).run(meetingId);
    return db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
  });

  // 签到：与改期/撤销在同一个串行化序列里竞争，按会议当前的时间与状态裁决。
  const txCheckin = db.transaction(({ meetingId, userId, nowMs, graceMin, offline, claimedMs }) => {
    const m = db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
    if (!m) throw httpError(404, 'NO_MEETING', '会议不存在');
    if (m.status === 'cancelled') throw httpError(410, 'MEETING_CANCELLED', '会议已撤销，旧的签到确认无效');
    if (m.status === 'checked_in') throw httpError(409, 'ALREADY_CHECKED_IN', '已经签到',
      { atMs: m.checked_in_at_ms });
    const room = db.prepare('SELECT * FROM rooms WHERE id=?').get(m.room_id);
    if (offline && room.checkin_policy !== 'offline_allowed') {
      throw httpError(403, 'OFFLINE_NOT_ALLOWED', '该房间只允许在线签到（门牌可查看缓存但不能离线签到）');
    }
    // 有效签到窗口：开始前 15 分钟 ~ 开始+宽限。离线补签用 claimedMs（设备时钟校准后）判定。
    const refMs = offline && typeof claimedMs === 'number' ? claimedMs : nowMs;
    const winStart = m.start_ms - 15 * 60e3;
    const winEnd = m.start_ms + graceMin * 60e3;
    if (refMs < winStart) throw httpError(409, 'CHECKIN_TOO_EARLY', '签到窗口未开放', { opensAtMs: winStart });
    if (refMs > winEnd) throw httpError(409, 'CHECKIN_CLOSED', '已超过签到宽限期', { closedAtMs: winEnd });
    db.prepare(`UPDATE meetings SET status='checked_in', checked_in_at_ms=?,
      checked_in_by=?, version=version+1 WHERE id=?`)
      .run(nowMs, userId, meetingId);
    return db.prepare('SELECT * FROM meetings WHERE id=?').get(meetingId);
  });

  function emit(roomId, kind, payload, nowMs) {
    const r = db.prepare('INSERT INTO events(room_id,kind,payload_json,emitted_ms) VALUES (?,?,?,?)')
      .run(roomId, kind, JSON.stringify(payload || {}), nowMs);
    return r.lastInsertRowid;
  }

  return {
    findConflicts,
    book: (a) => txBook({ ...a }),
    reschedule: (a) => txReschedule({ ...a }),
    extend: (a) => txExtend({ ...a }),
    cancel: (a) => txCancel({ ...a }),
    checkin: (a) => txCheckin({ ...a }),
    emit,
  };
}

function publicMeet(m) {
  return { id: m.id, roomId: m.room_id, organizerId: m.organizer_id, topic: m.topic,
    startMs: m.start_ms, endMs: m.end_ms, status: m.status,
    checkedInAtMs: m.checked_in_at_ms, version: m.version };
}

module.exports = { createStore, publicMeet };
