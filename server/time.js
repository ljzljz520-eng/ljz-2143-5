'use strict';
// 所有时间在关系库中以 INTEGER 毫秒 UTC 存储（Unix epoch ms）。
// 区间统一采用半开区间 [startMs, endMs)：
//   endA == startB 视为相邻 -> 不冲突；startB < endA 且 startA < endB 才算重叠。

function parseOffset(gmt) {
  // "GMT-0400" / "GMT+05:30" / "GMT" -> 分钟
  if (!gmt || gmt === 'GMT') return 0;
  const m = /^GMT([+-])(\d{2}):?(\d{2})$/.exec(gmt);
  if (!m) throw new Error('bad offset ' + gmt);
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -mins : mins;
}

function offsetMinutesAt(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second'));
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const offMin = parseOffset(tzPart && tzPart.value);
  return { wall, offMin };
}

// 把某时区墙上时间转成 UTC ms。
// 输入: { date:'YYYY-MM-DD', time:'HH:MM', tz, disambiguation:'earlier'|'later' }
// 返回 { utcMs, offMin, ambiguous:boolean }
// 春季缺口（不存在的时间）抛 ZONE_TIME_GAP；
// 秋季重复时刻必须给 disambiguation，否则抛 ZONE_TIME_AMBIGUOUS。
function wallToUtc({ date, time, tz, disambiguation }) {
  const hm = /^(\d{2}):(\d{2})$/.exec(time || '');
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!hm || !ymd) throw httpError(400, 'BAD_WALL_TIME', '需要 date=YYYY-MM-DD, time=HH:MM');
  const naive = Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3], +hm[1], +hm[2], 0);
  if (Number.isNaN(naive)) throw httpError(400, 'BAD_WALL_TIME', '非法日期');
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }).format(); }
  catch { throw httpError(400, 'BAD_TIMEZONE', '未知时区 ' + tz); }

  // 取两个相隔 8 小时的候选点（覆盖 DST 切换两侧）。
  const a = offsetMinutesAt(naive - 8 * 3600e3, tz).offMin;
  const b = offsetMinutesAt(naive + 8 * 3600e3, tz).offMin;
  const uEarly = naive - a * 60e3;
  const uLate = naive - b * 60e3;
  const wallEarly = offsetMinutesAt(uEarly, tz).wall;
  const wallLate = offsetMinutesAt(uLate, tz).wall;
  const hits = [];
  if (wallEarly === naive) hits.push({ utcMs: uEarly, offMin: a });
  if (wallLate === naive && uLate !== uEarly) hits.push({ utcMs: uLate, offMin: b });
  // 候选点其实是同一个 UTC（非切换日）
  if (hits.length === 0 && uEarly === uLate && wallEarly === naive) {
    return { utcMs: uEarly, offMin: a, ambiguous: false };
  }
  if (hits.length === 0) {
    throw httpError(400, 'ZONE_TIME_GAP',
      `${date} ${time} 在 ${tz} 不存在（春季跳时缺口），请改期到切换之后`);
  }
  if (hits.length === 2) {
    if (!disambiguation) {
      throw httpError(409, 'ZONE_TIME_AMBIGUOUS',
        `${date} ${time} 在 ${tz} 出现两次（秋季重复时刻），请指定 disambiguation=earlier|later`,
        { earlierUtcMs: hits[0].utcMs, laterUtcMs: hits[1].utcMs });
    }
    if (disambiguation !== 'earlier' && disambiguation !== 'later') {
      throw httpError(400, 'BAD_DISAMBIGUATION', 'disambiguation 仅支持 earlier|later');
    }
    const pick = disambiguation === 'earlier' ? hits[0] : hits[1];
    return { ...pick, ambiguous: true };
  }
  return { ...hits[0], ambiguous: false };
}

function utcToWall(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t) => parts.find((p) => p.type === t).value;
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour') % 24}:${get('minute')}`,
    gmt: tzPart.value,
    offMin: parseOffset(tzPart.value),
  };
}

function httpError(status, code, message, extra) {
  const e = new Error(message || code);
  e.status = status; e.code = code; e.extra = extra;
  return e;
}

module.exports = { wallToUtc, utcToWall, offsetMinutesAt, httpError };
