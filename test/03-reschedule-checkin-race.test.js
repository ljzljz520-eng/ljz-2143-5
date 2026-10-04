'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api, parallel } = require('./helpers');

let env;
test.before(async () => { env = await startServer(); });
test.after(() => env.stop());

async function bookRoom1(topic, startMs, endMs) {
  const r = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic, startMs, endMs } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.meeting;
}

test('改期与签到竞争：串行化后结果确定（签到成功 OR 改期成功，二选一且自洽）', async () => {
  const now = Date.now();
  const m = await bookRoom1('竞态会', now - 5 * 60e3, now + 55 * 60e3);
  // bob 改期到明天；carol 同时对同会议签到
  const tomorrow = now + 24 * 3600e3;
  const [re, ck] = await parallel(
    () => api(env.base, 'POST', `/api/meetings/${m.id}/reschedule`,
      { token: 'tok-bob', body: { startMs: tomorrow, endMs: tomorrow + 3600e3 } }),
    () => api(env.base, 'POST', `/api/meetings/${m.id}/checkin`,
      { token: 'tok-carol', body: {} }),
  );
  const final = (await api(env.base, 'GET', `/api/meetings/${m.id}`)).data;
  if (ck.status === 200) {
    // 签到先提交：改期必须被拒（已签到不允许改期），状态 checked_in
    assert.equal(re.status, 409);
    assert.equal(final.status, 'checked_in');
    assert.equal(final.startMs, m.startMs);
  } else {
    // 改期先提交：签到必须按改期后的时间裁决 -> 明天的会议此刻 CHECKIN_TOO_EARLY
    assert.equal(re.status, 200);
    assert.equal(ck.status, 409);
    assert.equal(ck.data.error, 'CHECKIN_TOO_EARLY');
    assert.equal(final.status, 'booked');
    assert.equal(final.startMs, tomorrow);
  }
});

test('两个用户同时把同一场会议改到同一新时段：恰好一个成功', async () => {
  const now = Date.now();
  const m = await bookRoom1('双人改期', now + 3 * 3600e3, now + 4 * 3600e3);
  const s = now + 6 * 3600e3, e = now + 7 * 3600e3;
  const [r1, r2] = await parallel(
    () => api(env.base, 'POST', `/api/meetings/${m.id}/reschedule`,
      { token: 'tok-bob', body: { startMs: s, endMs: e } }),
    // 管理员 alice 也改；同目标时段内容幂等，两次都应 200，最终版本只递增到 v2
    () => api(env.base, 'POST', `/api/meetings/${m.id}/reschedule`,
      { token: 'tok-alice', body: { startMs: s, endMs: e } }),
  );
  assert.deepEqual([r1.status, r2.status].sort(), [200, 200]);
  const after = (await api(env.base, 'GET', `/api/meetings/${m.id}`)).data;
  assert.equal(after.startMs, s);
  assert.equal(after.version, 2);
});

test('三个用户并发抢同一时段（含相邻边界），永远只有一个成功', async () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const s0 = now + (30 + i) * 3600e3;
    const reqs = ['tok-bob', 'tok-carol', 'tok-dave'].map((tok) =>
      api(env.base, 'POST', '/api/rooms/1/meetings',
        { token: tok, body: { topic: 'triple', startMs: s0, endMs: s0 + 1800e3 } }));
    const rs = await Promise.all(reqs);
    assert.equal(rs.filter((r) => r.status === 201).length, 1, `iter ${i}: ${rs.map(r=>r.status)}`);
    assert.equal(rs.filter((r) => r.status === 409).length, 2);
  }
});

test('改期到别人的会议上 -> 409；非组织者非管理员改期 -> 403', async () => {
  const now = Date.now();
  const blocker = await bookRoom1('占位', now + 9 * 3600e3, now + 10 * 3600e3);
  const victim = await bookRoom1('受害会', now + 11 * 3600e3, now + 12 * 3600e3);
  const clash = await api(env.base, 'POST', `/api/meetings/${victim.id}/reschedule`,
    { token: 'tok-bob', body: { startMs: blocker.startMs + 10 * 60e3, endMs: blocker.endMs } });
  assert.equal(clash.status, 409);
  const forbidden = await api(env.base, 'POST', `/api/meetings/${victim.id}/reschedule`,
    { token: 'tok-dave', body: { startMs: now + 13 * 3600e3, endMs: now + 14 * 3600e3 } });
  assert.equal(forbidden.status, 403);
});

test('延长会议必须重新检查下一场；不能只改倒计时', async () => {
  const now = Date.now();
  const first = await bookRoom1('第一场', now + 20 * 3600e3, now + 21 * 3600e3);
  await bookRoom1('下一场', now + 21 * 3600e3, now + 22 * 3600e3); // 相邻
  const blocked = await api(env.base, 'POST', `/api/meetings/${first.id}/extend`,
    { token: 'tok-bob', body: { minutes: 30 } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, 'NEXT_MEETING_BLOCKS');
  assert.ok(blocked.data.extra.next);
  // endMs 没有被改动（不是屏幕倒计时被悄悄拉长）
  const after = (await api(env.base, 'GET', `/api/meetings/${first.id}`)).data;
  assert.equal(after.endMs, first.endMs);
  // 下一场撤销后才能延长
  await api(env.base, 'POST', `/api/meetings/${blocked.data.extra.next.id}/cancel`,
    { token: 'tok-bob', body: {} });
  const ok = await api(env.base, 'POST', `/api/meetings/${first.id}/extend`,
    { token: 'tok-bob', body: { minutes: 30 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.meeting.endMs, first.endMs + 30 * 60e3);
});
