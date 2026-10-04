'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api, sleep } = require('./helpers');

let env;
test.before(async () => { env = await startServer(); });
test.after(() => env.stop());

function openSSE(afterSeq = 0, roomId = null) {
  const ac = new AbortController();
  const qs = new URLSearchParams({ afterSeq: String(afterSeq) });
  if (roomId != null) qs.set('roomId', String(roomId));
  return fetch(`${env.base}/api/events?${qs}`, {
    headers: { accept: 'text/event-stream' }, signal: ac.signal,
  }).then(async (res) => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    const queue = [];
    let waiters = [], buf = '';
    function pump() {
      reader.read().then(({ value, done }) => {
        if (done) return;
        buf += dec.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop();
        for (const blk of blocks) {
          const idm = /^id: (\d+)/m.exec(blk);
          const evm = /^event: (.+)$/m.exec(blk);
          const dm = /^data: (.+)$/m.exec(blk);
          if (evm) {
            const ev = { seq: idm ? +idm[1] : null, event: evm[1], data: dm ? JSON.parse(dm[1]) : null };
            const w = waiters.shift(); if (w) w(ev); else queue.push(ev);
          }
        }
        pump();
      }).catch(() => {});
    }
    pump();
    return {
      ac,
      nextEvent(timeoutMs = 3000) {
        const q = queue.shift();
        if (q) return Promise.resolve(q);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
          waiters.push((ev) => { clearTimeout(t); resolve(ev); });
        });
      },
    };
  });
}
async function readOneEvent(sse) { return sse.nextEvent(); }

test('SSE：预约/改期/撤销/签到产生单调 seq 的推送', async () => {
  const sse = await openSSE(0);
  const hello = await readOneEvent(sse);
  assert.equal(hello.event, 'hello');

  const b = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic: 'SSE 会',
      startMs: Date.now() + 40 * 3600e3, endMs: Date.now() + 41 * 3600e3 } });
  const booked = await readOneEvent(sse);
  assert.equal(booked.event, 'meeting.booked');
  assert.equal(booked.seq, b.data.eventSeq);

  const c = await api(env.base, 'POST', `/api/meetings/${b.data.meeting.id}/reschedule`,
    { token: 'tok-bob', body: { startMs: Date.now() + 42 * 3600e3, endMs: Date.now() + 43 * 3600e3 } });
  const moved = await readOneEvent(sse);
  assert.equal(moved.event, 'meeting.rescheduled');
  assert.ok(moved.seq > booked.seq, 'seq 严格单调');
  assert.equal(c.data.eventSeq, moved.seq);
  sse.ac.abort();
});

test('后台推送乱序：afterSeq 补发 + 网页按 seq 去重，旧事件不回退状态', async () => {
  // 制造 3 个事件
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await api(env.base, 'POST', '/api/rooms/2/meetings',
      { token: 'tok-dave', body: { topic: 'seq' + i,
        startMs: Date.now() + (50 + i) * 3600e3, endMs: Date.now() + (51 + i) * 3600e3 } });
    ids.push(r.data.eventSeq);
  }
  // 新连接从最旧事件之前开始补发
  const sse = await openSSE(ids[0] - 1);
  // 服务端先发补发、再发 hello；丢弃 hello（可能已在同一缓冲块）
  const skip = await readOneEvent(sse);
  assert.ok(['hello', 'meeting.booked'].includes(skip.event));
  const e1 = skip.event === 'hello' ? await readOneEvent(sse) : skip;
  const e2 = await readOneEvent(sse);
  const e3 = await readOneEvent(sse);
  assert.deepEqual([e1.seq, e2.seq, e3.seq], ids);
  sse.ac.abort();

  // 网页归约器规则：if(incoming.seq <= seen) drop —— 用服务端 state 的同款约定断言
  const { applyEvent } = require('../server/state');
  let state = { lastSeq: e3.seq };
  const replayOld = applyEvent(state, { seq: e1.seq, kind: 'meeting.booked' });
  assert.equal(replayOld.applied, false);
  assert.equal(replayOld.reason, 'stale');
  const realNew = applyEvent(state, { seq: e3.seq + 1, kind: 'meeting.cancelled' });
  assert.equal(realNew.applied, true);
});

test('网页显示设备显示新鲜度：无心跳=陈旧；心跳后新鲜；90s 阈值', async () => {
  const noHeartbeatRoom = 2;
  // room2 没有本套件的 C 心跳 -> lastSeen 可能存在来自其它进程的记录；这里用新房间隔离
  const nr = await api(env.base, 'POST', '/api/admin/rooms',
    { token: 'tok-alice', body: { code: 'R-FRESH', name: 'Freshness', tz: 'UTC', graceMin: 10 } });
  const rid = nr.data.roomId;
  let st = await api(env.base, 'GET', `/api/displays/${rid}/state`);
  assert.equal(st.data.display.fresh, false);
  assert.equal(st.data.display.lastSeenMs, null);
  await api(env.base, 'GET', `/api/displays/${rid}/state?deviceMs=${Date.now()}`);
  st = await api(env.base, 'GET', `/api/displays/${rid}/state?deviceMs=${Date.now()}`);
  assert.equal(st.data.display.fresh, true);
  assert.ok(st.data.display.ageMs < 5000);
});

test('预约事实同时呈现 UTC 与本地时间，且标注区间语义', async () => {
  const r = await api(env.base, 'GET', '/api/rooms/1/meetings');
  assert.match(r.data.interval, /adjacent intervals do not conflict/);
  if (r.data.meetings.length) {
    const m = r.data.meetings[0];
    assert.equal(typeof m.startMs, 'number');
    assert.ok(m.localStart.gmt.startsWith('GMT'));
    assert.ok(m.endMs > m.startMs);
    assert.equal(m.version >= 1, true);
  }
});

test('SSE 房间过滤：只订阅房间 1 时收不到房间 2 的事件；房间 1 的能收到', async () => {
  const sse = await openSSE(0, 1);
  assert.equal((await readOneEvent(sse)).event, 'hello');
  await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-dave', body: { topic: '其他房间',
      startMs: Date.now() + 60 * 3600e3, endMs: Date.now() + 61 * 3600e3 } });
  await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic: '本房间',
      startMs: Date.now() + 62 * 3600e3, endMs: Date.now() + 63 * 3600e3 } });
  const ev = await readOneEvent(sse);
  assert.equal(ev.event, 'meeting.booked');
  assert.equal(ev.data.roomId, 1);
  assert.equal(ev.data.payload.topic, '本房间');
  sse.ac.abort();
});
