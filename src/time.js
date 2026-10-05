'use strict';

// Canonical meeting times are stored as UTC milliseconds. The API also carries
// the room/user supplied wall-clock value and IANA zone so DST gaps and the
// repeated autumn hour cannot be silently collapsed.
const ZONE_RE = /^(UTC|GMT|[A-Za-z_][A-Za-z0-9_+\-]*(\/[A-Za-z_][A-Za-z0-9_+\-/]*)+)$/;

function getZone(iana) {
  if (!ZONE_RE.test(iana || '')) throw badZone(iana);
  try {
    // Intl canonicalizes and rejects unknown zones.
    new Intl.DateTimeFormat('en-US', { timeZone: iana });
    return iana;
  } catch {
    throw badZone(iana);
  }
}

function badZone(iana) {
  return Object.assign(new Error(`Unknown IANA timezone: ${iana}`), { status: 400, code: 'BAD_TIMEZONE' });
}

function partsAt(date, zone) {
  // en-CA gives a predictable Y-m-d h:m:s numeric layout.
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const map = Object.fromEntries(dtf.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return {
    year: +map.year, month: +map.month, day: +map.day,
    hour: +map.hour, minute: +map.minute, second: +map.second,
    weekday: new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short' }).format(date)
  };
}

function offsetSecondsAt(utcMs, zone) {
  // The offset is the difference between the UTC epoch and the zone wall clock
  // for that same instant.
  const p = partsAt(new Date(utcMs), zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - utcMs) / 1000);
}

function parseOffsetSeconds(utcMs, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(utcMs));
  const name = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT';
  if (name === 'GMT') return 0;
  const m = name.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!m) return 0;
  const seconds = (+m[2]) * 3600 + (+(m[3] || 0)) * 60;
  return m[1] === '-' ? -seconds : seconds;
}

function wallPartsAtUtc(utcMs, zone) {
  const p = partsAt(new Date(utcMs), zone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

function findOffsetTransition(loUtc, hiUtc, zone, loOffset = parseOffsetSeconds(loUtc, zone)) {
  let lo = loUtc, hi = hiUtc;
  while (hi - lo > 60 * 1000) {
    const mid = Math.floor((lo + hi) / 2 / 60000) * 60000;
    if (parseOffsetSeconds(mid, zone) === loOffset) lo = mid;
    else hi = mid;
  }
  return hi;
}

function parseLocal(local, zone, repeat = 'first') {
  if (repeat !== 'first' && repeat !== 'second') throw badRepeat();
  if (!/^\d{4}-\d{2}-\d{2}[T, ]+\d{2}:\d{2}(:\d{2})?$/.test(local || '')) throw badLocal(local);
  const normalized = local.replace(', ', 'T').replace(' ', 'T');
  const [datePart, timePart] = normalized.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [h, mi, se = 0] = timePart.split(':').map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi, se);
  if (Number.isNaN(wall)) throw badLocal(local);

  // Only offsets immediately around the target wall-clock instant are needed.
  // DST changes are one-hour discontinuities; this avoids minute scanning and
  // remains deterministic for both gap and repeated local times.
  const windowMs = 6 * 3600 * 1000;
  const beforeOffset = parseOffsetSeconds(wall - windowMs, zone);
  const afterOffset = parseOffsetSeconds(wall + windowMs, zone);
  const candidates = [...new Set([
    wall - beforeOffset * 1000,
    wall - afterOffset * 1000
  ])].sort((a, b) => a - b).filter(utc => wallPartsAtUtc(utc, zone) === wall);

  if (candidates.length === 0) {
    const transition = findOffsetTransition(wall - windowMs, wall + windowMs, zone, beforeOffset);
    throw Object.assign(new Error('Local time does not exist because of a daylight-saving gap'), {
      status: 400, code: 'LOCAL_TIME_GAP',
      local, zone, gap: {
        beforeUtcMs: transition - 60 * 1000,
        beforeOffset: parseOffsetSeconds(transition - 60 * 1000, zone),
        afterUtcMs: transition,
        afterOffset: parseOffsetSeconds(transition, zone)
      },
      suggestedLocal: formatLocal(transition, zone)
    });
  }

  if (candidates.length >= 2) {
    const chosen = repeat === 'second' ? candidates[candidates.length - 1] : candidates[0];
    return {
      utcMs: chosen,
      offsetSeconds: parseOffsetSeconds(chosen, zone),
      ambiguous: true,
      occurrence: repeat === 'second' ? 'second' : 'first',
      occurrences: [candidates[0], candidates[candidates.length - 1]]
    };
  }
  return { utcMs: candidates[0], offsetSeconds: parseOffsetSeconds(candidates[0], zone), ambiguous: false, occurrence: 'once' };
}

function formatLocal(utcMs, zone) {
  const p = partsAt(new Date(utcMs), zone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}:${String(p.second).padStart(2, '0')}`;
}

function badLocal(local) {
  return Object.assign(new Error('Expected local wall time YYYY-MM-DDTHH:mm'), { status: 400, code: 'BAD_LOCAL_TIME', local });
}
function badRepeat() {
  return Object.assign(new Error('dstOccurrence must be first or second'), { status: 400, code: 'BAD_DST_OCCURRENCE' });
}

function normalizeRange(input) {
  const zone = getZone(input.timezone);
  const repeat = input.dstOccurrence === 'second' ? 'second' : 'first';
  const start = parseLocal(input.startLocal, zone, repeat);
  // The occurrence choice applies to the whole submitted interval. During a
  // repeated hour end times are interpreted consistently; callers can submit
  // explicit UTC after resolution if they need the other occurrence.
  const end = parseLocal(input.endLocal, zone, repeat);
  if (end.utcMs <= start.utcMs) {
    throw Object.assign(new Error('End must be after start'), { status: 400, code: 'BAD_RANGE' });
  }
  return {
    timezone: zone,
    startLocal: input.startLocal,
    endLocal: input.endLocal,
    startUtc: start.utcMs,
    endUtc: end.utcMs,
    startOffsetSeconds: start.offsetSeconds,
    endOffsetSeconds: end.offsetSeconds,
    dstAmbiguous: !!(start.ambiguous || end.ambiguous),
    dstOccurrence: (start.ambiguous || end.ambiguous) ? repeat : null
  };
}

function meetingTimeView(row, zone = row.timezone) {
  const z = getZone(zone);
  const serverNow = Date.now();
  return {
    timezone: z,
    startLocal: formatLocal(row.startUtc, z),
    endLocal: formatLocal(row.endUtc, z),
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    startOffsetSeconds: offsetSecondsAt(row.startUtc, z),
    endOffsetSeconds: offsetSecondsAt(row.endUtc, z),
    // Half-open: [start,end). Adjacent meetings do not conflict.
    boundary: 'half-open-start-inclusive-end-exclusive',
    serverNowUtc: serverNow
  };
}

module.exports = { getZone, parseLocal, formatLocal, offsetSecondsAt, normalizeRange, meetingTimeView };
