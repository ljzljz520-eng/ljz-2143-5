'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api } = require('./helpers');

let env;
test.before(async () => { env = await startServer(); });
test.after(() => env.stop());

test('夏令时春季缺口：纽约 2025-03-09 02:30 不存在 -> 400 ZONE_TIME_GAP', async () => {
  const r = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { date: '2025-03-09', startLocal: '02:30', endLocal: '03:30', topic: 'gap' } });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, 'ZONE_TIME_GAP');
});

test('夏令时秋季重复时刻：不给消歧 -> 409 且给出两个候选 UTC', async () => {
  const r = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { date: '2025-11-02', startLocal: '01:30', endLocal: '02:30', topic: 'amb' } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'ZONE_TIME_AMBIGUOUS');
  assert.equal(r.data.extra.earlierUtcMs, Date.parse('2025-11-02T05:30:00Z'));
  assert.equal(r.data.extra.laterUtcMs, Date.parse('2025-11-02T06:30:00Z'));
});

test('earlier/later 消歧映射到确定 UTC（EDT -04:00 / EST -05:00）', async () => {
  const e = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { date: '2025-11-02', startLocal: '01:30', startDisambiguation: 'earlier',
      endLocal: '02:15', endDisambiguation: 'earlier', topic: 'early' } });
  assert.equal(e.status, 201);
  assert.equal(e.data.meeting.startMs, Date.parse('2025-11-02T05:30:00Z'));
  assert.equal(e.data.meeting.localStart.gmt, 'GMT-04:00');

  // later 实例（01:30 EST = 06:30Z）与 earlier 实例 [05:30,07:15Z) 必然重叠 -> 被拦
  const overlap = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-carol', body: { date: '2025-11-02', startLocal: '01:30', startDisambiguation: 'later',
      endLocal: '02:15', endDisambiguation: 'later', topic: 'late' } });
  assert.equal(overlap.status, 409);

  // 切换完成后的 02:30 EST（唯一时刻）= 07:30Z，与早场端点 07:15Z 不重叠 -> 成功
  const l = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-carol', body: { date: '2025-11-02', startLocal: '02:30',
      endLocal: '03:00', topic: 'post-switch' } });
  assert.equal(l.status, 201);
  assert.equal(l.data.meeting.startMs, Date.parse('2025-11-02T07:30:00Z'));
  assert.equal(l.data.meeting.localStart.gmt, 'GMT-05:00');

  // 单独验证 later 消歧映射的 UTC（用不存在冲突的未来日期 2026-11-01）
  const l2 = await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-dave', body: { date: '2026-11-01', startLocal: '01:30', endLocal: '02:30',
      topic: 'sh-no-dst' } });
  assert.equal(l2.status, 201);
  assert.equal(l2.data.meeting.localStart.gmt, 'GMT+08:00');
});

test('秋季两次 01:30 的重叠组合会被冲突检查拦住（消歧不能绕过冲突）', async () => {
  // earlier 01:30–03:00 EDT (05:30–07:00Z)
  await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-dave', body: { date: '2025-11-02', startLocal: '01:30', endLocal: '03:00', topic: 'sh-a' } });
  // 上海不实行夏令时：同样输入不应报 ambiguous
  const sh = await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-dave', body: { date: '2025-11-02', startLocal: '02:00', endLocal: '02:30', topic: 'sh-b' } });
  assert.equal(sh.status, 409); // 普通重叠
});
