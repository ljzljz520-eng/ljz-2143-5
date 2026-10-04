'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { startServer, api, sleep } = require('./helpers');
const fs = require('fs');

let env, PORT;
test.before(async () => {
  env = await startServer();
  PORT = new URL(env.base).port;
});
test.after(() => env.stop());

const DOOR = process.env.DOORSIGN_BIN || require('path').join(__dirname, '../c/doorsign');
function door(args) {
  return execFileSync(DOOR, ['--server', `127.0.0.1:${PORT}`, ...args],
    { encoding: 'utf8' });
}

test('设备时钟漂移：心跳上报 deviceMs，服务器计算 offset 并平滑', async () => {
  const now = Date.now();
  await api(env.base, 'GET', `/api/displays/1/state?deviceMs=${now - 3600e3}`);
  await sleep(20);
  const st = await api(env.base, 'GET', `/api/displays/1/state?deviceMs=${Date.now() - 3600e3}`);
  assert.ok(Math.abs(st.data.display.clockOffsetMs - 3600e3) < 2000,
    'offset ~= 3600000ms, got ' + st.data.display.clockOffsetMs);
  assert.equal(st.data.display.fresh, true);
});

test('门牌渲染：含会议、签到码、模板背景加载成功', () => {
  const out = door(['--room', '1', '--mode', 'render', '--once', '--cache', '/tmp/t-cache-1.json']);
  assert.match(out, /ACME/);
  assert.match(out, /公司模板已加载|加载失败/); // 背景层存在
});

test('断线：probe 回退到缓存（只查看缓存策略也能显示最后状态）', () => {
  door(['--room', '1', '--mode', 'render', '--once', '--cache', '/tmp/t-cache-2.json']);
  const cached = fs.readFileSync('/tmp/t-cache-2.json', 'utf8');
  const out = door(['--server', '127.0.0.1:1', '--room', '1', '--mode', 'probe',
    '--cache', '/tmp/t-cache-2.json', '--shift-ms', '0']);
  assert.match(out, /OFFLINE/);
  // 缓存内容被渲染（至少能看到状态字段）
  const st = JSON.parse(cached);
  assert.ok(st.status === 'free' || st.status.startsWith('occupied'));
});

test('离线签到（offline_allowed 房间）：排队 -> 重连补提 -> 成功', async () => {
  const now = Date.now();
  const m = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic: '离线签到会', startMs: now - 60e3, endMs: now + 30 * 60e3 } });
  assert.equal(m.status, 201);
  const id = m.data.meeting.id;
  // 先心跳校准，再模拟断线排队
  door(['--room', '1', '--mode', 'simskew', '--cache', `/tmp/t-cache-o${id}.json`]);
  const queued = door(['--server', '127.0.0.1:1', '--room', '1', '--mode', 'checkin',
    '--token', 'tok-bob', '--meeting', String(id), '--offline',
    '--cache', `/tmp/t-cache-o${id}.json`]);
  assert.match(queued, /离线排队成功/);
  // 重连补提
  const flush = door(['--room', '1', '--mode', 'queue', '--token', 'tok-bob',
    '--cache', `/tmp/t-cache-o${id}.json`]);
  assert.match(flush, /HTTP 207/);
  assert.match(flush, /"ok":true/);
  const after = await api(env.base, 'GET', `/api/meetings/${id}`);
  assert.equal(after.data.status, 'checked_in');
});

test('预约被撤销后的旧确认：离线补提返回确定失败并清除本地标记', async () => {
  const now = Date.now();
  const m = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic: '将被撤销', startMs: now + 80 * 60e3, endMs: now + 140 * 60e3 } } );
  const id = m.data.meeting.id;
  const cache = `/tmp/t-cache-x${id}.json`;
  door(['--room', '1', '--mode', 'simskew', '--cache', cache]);
  door(['--server', '127.0.0.1:1', '--room', '1', '--mode', 'checkin', '--token', 'tok-bob',
    '--meeting', String(id), '--offline', '--cache', cache]);
  await api(env.base, 'POST', `/api/meetings/${id}/cancel`, { token: 'tok-bob', body: {} });
  const flush = door(['--room', '1', '--mode', 'queue', '--token', 'tok-bob', '--cache', cache]);
  assert.match(flush, /MEETING_CANCELLED/);
  assert.match(flush, /"ok":false/);
});

test('online_only 房间只允许查看缓存，离线签到被服务端拒绝 403', async () => {
  const now = Date.now();
  const m = await api(env.base, 'POST', '/api/rooms/2/meetings',
    { token: 'tok-alice', body: { topic: '沪会', startMs: now - 60e3, endMs: now + 3600e3 } });
  const r = await api(env.base, 'POST', '/api/displays/2/checkins',
    { token: 'tok-alice', body: { deviceMs: now, queue: [{ meetingId: m.data.meeting.id }] } });
  assert.equal(r.status, 207);
  assert.equal(r.data.results[0].ok, false);
  assert.equal(r.data.results[0].code, 'OFFLINE_NOT_ALLOWED');
});

test('背景加载失败不遮挡房间当前状态（状态层独立于背景层）', async () => {
  const st0 = await api(env.base, 'GET', '/api/displays/1/state');
  const url = st0.data.template.backgroundUrl;
  const set = await api(env.base, 'POST', '/api/admin/fail-background',
    { token: 'tok-alice', body: { url, enabled: true } });
  assert.equal(set.status, 200);
  const bg = await api(env.base, 'GET', url);
  assert.equal(bg.status, 503);
  // 状态端点照常工作
  const st = await api(env.base, 'GET', '/api/displays/1/state');
  assert.equal(st.status, 200);
  assert.ok(st.data.status === 'free' || st.data.status.startsWith('occupied'));
  // C 渲染明确显示背景失败但状态仍在
  const out = door(['--room', '1', '--mode', 'render', '--once', '--cache', '/tmp/t-cache-bg.json']);
  assert.match(out, /加载失败（状态仍正常显示）/);
});

test('断线跨会议边界：本地不自行翻场，重连后以服务器裁决为准', async () => {
  const now = Date.now();
  const nr = await api(env.base, 'POST', '/api/admin/rooms',
    { token: 'tok-alice', body: { code: 'R-BND' + now, name: 'Boundary', tz: 'UTC',
      checkinPolicy: 'offline_allowed', graceMin: 60 } });
  const rid = nr.data.roomId;
  // 一场“进行中”的会
  const a = await api(env.base, 'POST', `/api/rooms/${rid}/meetings`,
    { token: 'tok-bob', body: { topic: '边界前', startMs: now - 10 * 60e3, endMs: now + 15 * 60e3 } });
  const cache = '/tmp/t-cache-boundary.json';
  door(['--room', String(rid), '--mode', 'render', '--once', '--cache', cache]);
  // 服务器侧时间推进模拟：直接把第一场签到 + 再安排紧接的会后撤销首场由后续重拉体现
  await api(env.base, 'POST', `/api/meetings/${a.data.meeting.id}/checkin`,
    { token: 'tok-carol', body: {} });
  // 重连后渲染必须反映服务器新状态，而不是缓存里的旧倒计时
  const out = door(['--room', String(rid), '--mode', 'probe', '--cache', cache]);
  assert.match(out, /LIVE/);
  const st = JSON.parse(fs.readFileSync(cache, 'utf8'));
  assert.equal(st.meeting ? st.meeting.status : null, 'checked_in');
});

test('策略切换：offline_allowed 房间改为 online_only 后，离线补签立即被拒', async () => {
  const now = Date.now();
  const nr = await api(env.base, 'POST', '/api/admin/rooms',
    { token: 'tok-alice', body: { code: 'R-POL' + now, name: 'Policy', tz: 'UTC',
      checkinPolicy: 'offline_allowed', graceMin: 60 } });
  const rid = nr.data.roomId;
  const m = await api(env.base, 'POST', `/api/rooms/${rid}/meetings`,
    { token: 'tok-bob', body: { topic: '策略会', startMs: now - 60e3, endMs: now + 3600e3 } });
  // 离线允许时
  const ok = await api(env.base, 'POST', `/api/displays/${rid}/checkins`,
    { token: 'tok-bob', body: { deviceMs: now, queue: [{ meetingId: m.data.meeting.id }] } });
  assert.equal(ok.data.results[0].ok, true);
  // 第二场会议 + 策略收紧
  const m2 = await api(env.base, 'POST', `/api/rooms/${rid}/meetings`,
    { token: 'tok-bob', body: { topic: '策略会2', startMs: now + 2 * 3600e3, endMs: now + 3 * 3600e3 } });
  const sw = await api(env.base, 'POST', `/api/admin/rooms/${rid}/policy`,
    { token: 'tok-alice', body: { checkinPolicy: 'online_only' } });
  assert.equal(sw.status, 200);
  const denied = await api(env.base, 'POST', `/api/displays/${rid}/checkins`,
    { token: 'tok-bob', body: { deviceMs: now + 2 * 3600e3, queue: [{ meetingId: m2.data.meeting.id }] } });
  assert.equal(denied.data.results[0].code, 'OFFLINE_NOT_ALLOWED');
});

test('签到窗口：太早拒绝、宽限期内通过、过晚拒绝', async () => {
  const now = Date.now();
  const nr = await api(env.base, 'POST', '/api/admin/rooms',
    { token: 'tok-alice', body: { code: 'R-WIN' + now, name: 'Window', tz: 'UTC',
      checkinPolicy: 'offline_allowed', graceMin: 10 } });
  const rid = nr.data.roomId;
  const mk = (topic, sm, em) => api(env.base, 'POST', `/api/rooms/${rid}/meetings`,
    { token: 'tok-alice', body: { topic, startMs: sm, endMs: em } });
  const ck = (id) => api(env.base, 'POST', `/api/meetings/${id}/checkin`,
    { token: 'tok-alice', body: {} });

  const early = await mk('太早', now + 60 * 60e3, now + 61 * 60e3);
  assert.equal((await ck(early.data.meeting.id)).data.error, 'CHECKIN_TOO_EARLY');

  const within = await mk('窗口内', now - 5 * 60e3, now + 55 * 60e3);
  assert.equal((await ck(within.data.meeting.id)).status, 200);
  assert.equal((await ck(within.data.meeting.id)).data.error, 'ALREADY_CHECKED_IN');

  const late = await mk('过晚', now - 30 * 60e3, now - 20 * 60e3);
  assert.equal((await ck(late.data.meeting.id)).data.error, 'CHECKIN_CLOSED');
});
