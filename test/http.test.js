'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os'); const path = require('node:path'); const fs=require('node:fs');
const { startServer } = require('../src/server');

let server;
async function call(method, route, body, token, deviceToken){
  const res=await fetch(`http://127.0.0.1:${server.port}/api${route}`,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(deviceToken?{'X-Device-Token':deviceToken}:{})},body:body?JSON.stringify(body):undefined});
  const data=await res.json();
  if(!res.ok){const e=new Error(data.error.message);e.status=res.status;e.data=data;throw e;}
  return data;
}
test.before(async()=>{ server=await startServer({port:0,filename:path.join(fs.mkdtempSync(path.join(os.tmpdir(),'md-')),'t.db')}); });
test.after(()=>server.server.close());
test('HTTP acceptance: booking facts, out-of-order event cursor, device freshness and background asset remain available', async()=>{
  const login=await call('POST','/login',{email:'alice@example.com',password:'password123'});
  const rooms=await call('GET','/rooms',null,login.token);
  const room=rooms[0];
  const start=new Date(Date.now()+3600000).toISOString().slice(0,16);
  const end=new Date(Date.now()+7200000).toISOString().slice(0,16);
  const m=await call('POST','/meetings',{roomId:room.id,subject:'HTTP review',startLocal:start,endLocal:end,timezone:'UTC',privacy:'busy_only'},login.token);
  assert.equal(m.time.boundary,'half-open-start-inclusive-end-exclusive');
  const e1=await call('GET','/events?after=0',null,login.token);
  assert.ok(e1.cursor>=1);
  const e2=await call('GET',`/events?after=${e1.cursor}`,null,login.token);
  assert.equal(e2.events.length,0);

  const adminLogin=await call('POST','/login',{email:'admin@example.com',password:'password123'});
  const device=await call('POST','/admin/devices',{roomId:room.id,name:'ci-door',offlinePolicy:'cache_view_only'},adminLogin.token);
  const door=await call('GET','/door',null,null,device.deviceToken);
  assert.equal(door.freshness.state,'fresh');
  assert.equal(door.room.backgroundUrl,'/assets/company-bg.svg');
  assert.match(JSON.stringify(door),/serverTimeUtc/);
  const res=await fetch(`http://127.0.0.1:${server.port}${door.room.backgroundUrl}`);
  assert.equal(res.status,200);
  assert.match(await res.text(),/ACME WORKPLACE/);

  const changed=await call('POST','/meetings/cancel',{meetingId:m.id},login.token);
  const events=await call('GET','/events?after=0',null,login.token);
  const conditional=await fetch(`http://127.0.0.1:${server.port}/api/events?after=0`,{headers:{authorization:'Bearer '+login.token,'if-none-match':`"events-${events.cursor}"`}});
  assert.equal(conditional.status,304);
  assert.ok(events.events.some(e=>e.type==='cancelled'));

  const badDoor=await fetch(`http://127.0.0.1:${server.port}/api/door`,{headers:{'X-Device-Token':'malformed-token'}});
  assert.equal(badDoor.status,401);

  await assert.rejects(call('POST','/door/checkin',{meetingId:m.id,clientClockUtc:Date.now(),confirmation:'x'},null,device.deviceToken),e=>e.status===403);
});
