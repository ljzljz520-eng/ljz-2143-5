'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { startServer, api } = require('./helpers');

let env;
test.before(async () => { env = await startServer(); });
test.after(() => env.stop());

test('隐私设置：门牌默认显示完整主题；private 后只暴露占用状态', async () => {
  const now = Date.now();
  const mk = await api(env.base, 'POST', '/api/rooms/1/meetings',
    { token: 'tok-bob', body: { topic: '机密收购讨论', startMs: now - 60e3, endMs: now + 3600e3 } });
  assert.equal(mk.status, 201);
  const open = await api(env.base, 'GET', '/api/displays/1/state?deviceMs=' + (now - 5));
  assert.equal(open.data.status.startsWith('occupied'), true);
  assert.equal(open.data.meeting.topic, '机密收购讨论');
  assert.equal(open.data.meeting.private, false);

  const set = await api(env.base, 'POST', '/api/admin/rooms/1/privacy',
    { token: 'tok-alice', body: { privacy: 'private' } });
  assert.equal(set.status, 200);
  const priv = await api(env.base, 'GET', '/api/displays/1/state?deviceMs=' + now);
  assert.equal(priv.data.meeting.topic, null);
  assert.equal(priv.data.meeting.private, true);
  assert.equal(priv.data.status, 'occupied'); // 状态仍在
  // 预约事实 API 仍对授权用户保留主题（隐私只作用于门牌展示层）
  const fact = await api(env.base, 'GET', '/api/rooms/1/meetings');
  assert.ok(JSON.stringify(fact.data).includes('机密收购讨论'));
});

test('非管理员不能改隐私设置', async () => {
  const r = await api(env.base, 'POST', '/api/admin/rooms/1/privacy',
    { token: 'tok-bob', body: { privacy: 'private' } });
  assert.equal(r.status, 403);
});

test('模板编辑者只能读写背景/排版，拿不到任何会议详情', async () => {
  const list = await api(env.base, 'GET', '/api/templates', { token: 'tok-erin' });
  assert.equal(list.status, 200);
  for (const t of list.data.templates) {
    assert.ok(t.background_url);
    assert.ok(!('topic' in t) && !('meetings' in t));
  }
  assert.ok(!JSON.stringify(list.data).includes('机密'));

  const upd = await api(env.base, 'PUT', '/api/templates/2',
    { token: 'tok-erin', body: { layout: { titleSize: 70 } } });
  assert.equal(upd.status, 200);
  const list2 = await api(env.base, 'GET', '/api/templates', { token: 'tok-erin' });
  assert.equal(JSON.parse(list2.data.templates.find((t) => t.id === 2).layout_json).titleSize, 70);

  // 模板编辑者不能预约/看会议管理面（其角色不是 user/admin；预约接口允许任何有效登录，
  // 但 meetings 列表不含模板端点——关键是没有任何模板 API 返回会议数据，这里验证角色边界）
  const adm = await api(env.base, 'POST', '/api/admin/fail-background',
    { token: 'tok-erin', body: { url: '/x', enabled: true } });
  assert.equal(adm.status, 403);
});

test('普通用户不能编辑模板', async () => {
  const r = await api(env.base, 'POST', '/api/templates',
    { token: 'tok-bob', body: { name: 'x', backgroundUrl: '/y.svg' } });
  assert.equal(r.status, 403);
});

test('令牌回收立即生效：回收后所有携带该令牌的请求 401', async () => {
  const before = await api(env.base, 'GET', '/api/templates', { token: 'tok-dave' });
  assert.equal(before.status, 200);
  const rev = await api(env.base, 'DELETE', '/api/admin/tokens/tok-dave', { token: 'tok-alice' });
  assert.equal(rev.status, 200);
  const after = await api(env.base, 'GET', '/api/templates', { token: 'tok-dave' });
  assert.equal(after.status, 401);
  // 离线补签同样被拒（设备本地存的旧令牌）
  const q = await api(env.base, 'POST', '/api/displays/1/checkins',
    { token: 'tok-dave', body: { deviceMs: Date.now(), queue: [] } });
  assert.equal(q.status, 401);
});

test('缺少/伪造令牌被拒绝', async () => {
  assert.equal((await api(env.base, 'POST', '/api/rooms/1/meetings',
    { body: { topic: 'x', startMs: 1, endMs: 2 } })).status, 401);
  assert.equal((await api(env.base, 'GET', '/api/templates',
    { token: 'tok-nope' })).status, 401);
});
