'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLocal, normalizeRange } = require('../src/time');

test('half-open UTC representation resolves DST repeated hour deterministically', () => {
  const first = parseLocal('2026-11-01T01:30', 'America/New_York', 'first');
  const second = parseLocal('2026-11-01T01:30', 'America/New_York', 'second');
  assert.equal(first.ambiguous, true);
  assert.equal(second.ambiguous, true);
  assert.equal(first.utcMs, Date.parse('2026-11-01T05:30:00Z'));
  assert.equal(second.utcMs, Date.parse('2026-11-01T06:30:00Z'));
  assert.equal(second.utcMs - first.utcMs, 3600_000);
});

test('nonexistent spring-forward wall time is an explicit error with suggestion', () => {
  assert.throws(() => normalizeRange({
    timezone: 'America/New_York',
    startLocal: '2026-03-08T02:30',
    endLocal: '2026-03-08T03:30'
  }), e => e.status === 400 && e.code === 'LOCAL_TIME_GAP');
});

test('adjacent UTC ranges are normalized but conflict policy is left to server', () => {
  const a = normalizeRange({ timezone: 'UTC', startLocal: '2026-10-05T10:00', endLocal: '2026-10-05T11:00' });
  const b = normalizeRange({ timezone: 'UTC', startLocal: '2026-10-05T11:00', endLocal: '2026-10-05T12:00' });
  assert.equal(a.endUtc, b.startUtc);
  assert.equal(a.startOffsetSeconds, 0);
});
