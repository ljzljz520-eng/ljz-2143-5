'use strict';
// 门牌显示状态的纯函数式归约：设备/网页都基于同一快照渲染，便于测试乱序与离线。

// 返回该房间当前应展示的会议视图（privacy=private 时不泄露主题）。
function computeDisplay({ room, meetings, templates, nowMs, privacy }) {
  // 已签到的会议即使还差几分钟开始也视为“已占用”（房间已被到场者实际使用）
  const live = meetings.filter((m) => m.status !== 'cancelled' &&
    m.start_ms <= nowMs && nowMs < m.end_ms)
    .sort((a, b) => a.start_ms - b.start_ms)[0] ||
    meetings.filter((m) => m.status === 'checked_in' && m.start_ms > nowMs)
      .sort((a, b) => a.start_ms - b.start_ms)[0] || null;
  const next = meetings.filter((m) => m.status !== 'cancelled' &&
      m.start_ms > nowMs && m.id !== (live && live.id))
    .sort((a, b) => a.start_ms - b.start_ms)[0] || null;

  let status = 'free';
  if (live) status = live.status === 'checked_in' ? 'occupied_checkedin' : 'occupied';
  const view = {
    status,
    nowMs,
    meeting: live ? sanitize(live, privacy) : null,
    next: next ? sanitize(next, privacy) : null,
  };
  // 模板：只携带排版/背景地址，视图不附带任何会议详情给模板端点。
  const tpl = templates.find((t) => t.room_id === room.id) ||
    templates.find((t) => t.room_id == null);
  view.template = tpl ? {
    id: tpl.id, name: tpl.name, backgroundUrl: tpl.background_url,
    layout: safeParse(tpl.layout_json),
  } : null;
  view.privacy = privacy;
  return view;
}

// 隐私模式：门牌只显示“使用中”，不暴露主题/组织者；
// 注意模板编辑者只是拿到 backgroundUrl 与 layout，sanitize 逻辑与编辑权限无关——
// 编辑模板不会因此获得会议详情（模板表本身不含会议内容，见 db schema）。
function sanitize(m, privacy) {
  const base = {
    id: m.id, startMs: m.start_ms, endMs: m.end_ms,
    status: m.status, version: m.version,
  };
  if (privacy === 'private') return { ...base, topic: null, private: true };
  return { ...base, topic: m.topic, organizerId: m.organizer_id, private: false };
}

// 离线/乱序安全的事件归约：seq 单调，旧序号直接丢弃，不回退状态。
function applyEvent(state, ev) {
  if (state.lastSeq != null && ev.seq <= state.lastSeq) {
    return { state, applied: false, reason: 'stale' };
  }
  return {
    state: { ...state, lastSeq: ev.seq, events: [...(state.events || []), ev] },
    applied: true,
  };
}

// 设备时钟漂移：服务器时间 = 设备自报时间 + offset；多次心跳用 EMA 平滑。
function updateClockOffset(prevOffsetMs, serverMs, deviceReportedMs, alpha = 0.5) {
  const measured = serverMs - deviceReportedMs;
  if (prevOffsetMs == null) return measured;
  return Math.round(alpha * measured + (1 - alpha) * prevOffsetMs);
}

// 把设备“声称的时刻”修正成接近服务器 UTC 的时刻。
function correctedMs(deviceReportedMs, offsetMs) {
  return deviceReportedMs + (offsetMs || 0);
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

module.exports = { computeDisplay, applyEvent, updateClockOffset, correctedMs, sanitize };
