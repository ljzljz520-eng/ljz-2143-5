'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDb, seed } = require('./db');
const { createService, HttpError } = require('./service');

const PORT = +(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'app.db');
const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json'
};

function startServer({ port = PORT, filename = DB_FILE, shouldSeed = !process.env.NO_SEED } = {}) {
  const db = createDb(filename);
  if (shouldSeed) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count === 0) seed(db);
  }
  const service = createService(db);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url, service);
      return serveStatic(req, res, url);
    } catch (err) {
      sendError(res, err);
    }
  });
  return new Promise(resolve => server.listen(port, () => resolve({ server, db, service, port: server.address().port })));
}

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === '/') p = '/web/index.html';
  else if (p.startsWith('/assets/')) p = path.join('/assets', path.basename(p));
  else if (p.startsWith('/web/')) p = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
  else p = '/web/index.html';
  const file = path.join(ROOT, p);
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
}

async function readJson(req) {
  if (req.method === 'GET') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new HttpError(413, 'TOO_LARGE', 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'BAD_JSON', 'Malformed JSON body'); }
}

function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(obj));
}
function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  sendJson(res, status, { error: { code: err.code || 'INTERNAL', message: err.message, details: err.details } });
}

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-device-token'] || null);
}

async function handleApi(req, res, url, service) {
  const body = await readJson(req);
  const route = `${req.method} ${url.pathname.replace(/\/+$/, '').replace(/^\/api/, '') || '/'}`;
  const q = Object.fromEntries(url.searchParams);
  const withUser = () => service.requireUser({ token: bearer(req) });
  let result;
  switch (route) {
    case 'POST /login': result = await service.login(body.email, body.password); break;
    case 'POST /logout': { const { session } = withUser(); service.logout(session); result = { ok: true }; break; }
    case 'GET /me': result = require('./service').publicUser(withUser().user); break;
    case 'GET /rooms': result = service.listRooms(withUser().user); break;
    case 'GET /meetings': result = service.listMeetings(withUser().user, q); break;
    case 'POST /meetings': result = service.createMeeting(withUser().user, body); break;
    case 'GET /meeting': result = service.getMeeting(withUser().user, +q.id); break;
    case 'POST /meetings/reschedule': result = service.reschedule(withUser().user, +body.meetingId, body); break;
    case 'POST /meetings/extend': result = service.extendMeeting(withUser().user, +body.meetingId, body); break;
    case 'POST /meetings/cancel': result = service.cancel(withUser().user, +body.meetingId, body); break;
    case 'POST /meetings/checkin': result = service.checkin(withUser().user, +body.meetingId, body); break;
    case 'POST /meetings/privacy': result = service.setPrivacy(withUser().user, +body.meetingId, body); break;
    case 'POST /admin/rooms/privacy': result = service.setRoomPrivacy(withUser().user, +body.roomId, body); break;
    case 'POST /admin/grants/revoke': result = service.revokeGrant(withUser().user, +body.roomId, +body.userId); break;
    case 'POST /admin/devices': result = service.registerDevice(withUser().user, body); break;
    case 'POST /admin/devices/revoke': result = service.revokeDevice(withUser().user, +body.deviceId); break;
    case 'GET /admin/device-checkins': result = service.listDeviceCheckins(withUser().user, +q.deviceId); break;
    case 'GET /events': result = service.eventsSince(withUser().user, +q.after || 0); break;
    case 'POST /template': result = service.updateTemplate(withUser().user, +body.roomId, body); break;
    case 'GET /door': result = service.doorSnapshot(bearer(req), q); break;
    case 'POST /door/checkin': result = service.offlineCheckin(bearer(req), body); break;
    default: throw new HttpError(404, 'NO_ROUTE', `Unknown API route: ${route}`);
  }
  const headers = {};
  if (route === 'GET /events') {
    const etag = `"events-${result.cursor}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
  }
  return sendJson(res, 200, result, headers);
}

if (require.main === module) {
  startServer().then(({ port }) => console.log(`Meeting Door listening on http://localhost:${port}`));
}
module.exports = { startServer };
