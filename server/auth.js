'use strict';
// 极简 Bearer 令牌认证；删除 tokens 行即立即回收权限（每次请求实时查库）。
const { httpError } = require('./time');

function createAuth(db) {
  const q = db.prepare(`SELECT u.id uid, u.name name, u.role role FROM tokens t
    JOIN users u ON u.id=t.user_id WHERE t.token=?`);
  function authenticate(req) {
    const h = req.headers['authorization'] || '';
    const m = /^Bearer (.+)$/.exec(h);
    if (!m) throw httpError(401, 'NO_TOKEN', '需要 Authorization: Bearer <token>');
    const row = q.get(m[1]);
    if (!row) throw httpError(401, 'BAD_TOKEN', '令牌无效或已被回收');
    return row;
  }
  function requireAdmin(u) {
    if (u.role !== 'admin') throw httpError(403, 'FORBIDDEN', '需要管理员权限');
  }
  function requireTemplateEditor(u) {
    if (u.role !== 'admin' && u.role !== 'template_editor') {
      throw httpError(403, 'FORBIDDEN', '需要模板编辑权限');
    }
  }
  return { authenticate, requireAdmin, requireTemplateEditor };
}
module.exports = { createAuth };
