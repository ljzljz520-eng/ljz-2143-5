'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

let counter = 0;
function startServer() {
  return new Promise((resolve, reject) => {
    const dbFile = `/tmp/test-${process.pid}-${counter++}-${Math.random().toString(36).slice(2,7)}.db`;
    for (const ext of ['', '-wal', '-shm']) try { fs.unlinkSync(dbFile + ext); } catch {}
    const out = [];
    const child = spawn(process.execPath, [path.join(__dirname, '../server/server.js')], {
      env: { ...process.env, PORT: '0', DB_FILE: dbFile }, stdio: ['ignore', 'pipe', 'inherit'],
    });
    let resolved = false;
    child.stdout.on('data', (d) => {
      out.push(d);
      const m = /PORT=(\d+)/.exec(Buffer.concat(out).toString());
      if (m && !resolved) {
        resolved = true;
        const base = `http://127.0.0.1:${m[1]}`;
        resolve({ base, dbFile, child, stop: () => child.kill('SIGKILL') });
      }
    });
    setTimeout(() => { if (!resolved) reject(new Error('server timeout')); }, 5000).unref();
  });
}

async function api(base, method, urlPath, { token, body } = {}) {
  const res = await fetch(base + urlPath, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, headers: res.headers };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 并发发两个请求，等全部返回（用 Promise.all 而不是“先发先等”，避免人为串行化）
async function parallel(fnA, fnB) {
  const [a, b] = await Promise.allSettled([fnA(), fnB()]);
  return [a.status === 'fulfilled' ? a.value : a.reason, b.status === 'fulfilled' ? b.value : b.reason];
}

module.exports = { startServer, api, sleep, parallel };
