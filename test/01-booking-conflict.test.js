'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api, parallel } = require('./helpers');

let env;
test.before(async () => { env = await startServer(); });
test.after(() => env.stop());

const D = '2026-11-10';
test.beforeEach(async () => {});

test('相邻区间 [09,10) 与 [10,11) 不冲突，两场都能预约成功', async () => {
  const a = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { date: D, startLocal: '09:00', endLocal: '10:00', topic: 'A' } });
  const b = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-carol', body: { date: D, startLocal: '10:00', endLocal: '11:00', topic: 'B' } });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);
  assert.equal(a.data.meeting.endMs, b.data.meeting.startMs); // 端点相接
});

test('两个用户同时预约重叠区间：恰好一个成功、一个 409（结果确定，不会双成功）', async () => {
  const [r1, r2] = await parallel(
    () => api(env.base, 'POST', '/api/rooms/1/meetings',
      { token: 'tok-bob', body: { date: D, startLocal: '13:00', endLocal: '14:00', topic: 'race-1' } }),
    () => api(env.base, 'POST', '/api/rooms/1/meetings',
      { token: 'tok-carol', body: { date: D, startLocal: '13:30', endLocal: '14:30', topic: 'race-2' } }),
  );
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [201, 409]);
  // 冲突响应必须指出事实
  if (r1.status === 409) assert.ok(r1.data.extra.conflicts[0].topic === 'race-2');
  if (r2.status === 409) assert.ok(r2.data.extra.conflicts[0].topic === 'race-1');
});

test('同一秒两人抢同一时段，连跑 10 次都只有一个赢家', async () => {
  for (let i = 0; i < 10; i++) {
    const t = String(15 + i).padStart(2, '0');
    const [r1, r2] = await parallel(
      () => api(env.base, 'POST', '/api/rooms/1/meetings',
        { token: 'tok-bob', body: { date: D, startLocal: `${t}:00`, endLocal: `${t}:30`, topic: 'x' } }),
      () => api(env.base, 'POST', '/api/rooms/1/meetings',
        { token: 'tok-carol', body: { date: D, startLocal: `${t}:00`, endLocal: `${t}:30`, topic: 'y' } }),
    );
    assert.equal((r1.status === 201) + (r2.status === 201), 1, `iter ${i}`);
  }
});

test('时间表示：UTC ms 存储 + 房间本地墙上时间都返回，边界半开', async () => {
  const r = await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-dave', body: { date: '2026-11-11', startLocal: '08:00', endLocal: '09:00', topic: '沪' } });
  assert.equal(r.status, 201);
  assert.equal(r.data.meeting.localStart.gmt, 'GMT+08:00');
  assert.equal(r.data.meeting.startMs + 3600e3, r.data.meeting.endMs);
  const g = await api(env.base, 'GET', '/api/rooms/2/meetings');
  assert.match(g.data.interval, /\[startMs,endMs\)/);
});
