'use strict';
const $ = id => document.getElementById(id);
const state = { token: localStorage.token || '', user: null, rooms: [], meetings: [], selected: null, lastEventId: 0, latestAppliedSeq: -1, deviceTokens: JSON.parse(localStorage.deviceTokens || '{}'), door: null };

function toast(msg, ok=false){ const el=document.createElement('div'); el.className='toast'; el.textContent=msg; document.body.appendChild(el); setTimeout(()=>el.remove(),4500); el.style.background=ok?'#14613b':'#8b1f2a'; }
async function api(path, opts={}){
  const res=await fetch('/api'+path,{method:opts.method||'GET',headers:{'content-type':'application/json',...(state.token?{authorization:'Bearer '+state.token}:{}),...(opts.deviceToken?{'X-Device-Token':opts.deviceToken}:{})},body:opts.body?JSON.stringify(opts.body):undefined});
  const data=await res.json().catch(()=>({}));
  if(!res.ok){ const err=new Error(data.error?.message||res.statusText); err.data=data; throw err; }
  return data;
}
function esc(s){ return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function localInput(d, offsetMinutes=0){ const p=new Intl.DateTimeFormat('en-CA',{timeZone:d.timezone,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).formatToParts(new Date(Date.now()+offsetMinutes*60000)); const m=Object.fromEntries(p.filter(x=>x.type!=='literal').map(x=>[x.type,x.value])); return `${m.year}-${m.month}-${m.day}T${m.hour}:${m.minute}`; }
function fmtUtc(ms){ return new Date(ms).toISOString().replace('.000Z','Z'); }
function fmtLocal(t){ try{ return new Intl.DateTimeFormat('zh-CN',{timeZone:t.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(t.startUtc)); }catch{ return t.startLocal; } }

async function boot(){
  if(state.token){ try{ state.user=await api('/me'); await loadAll(); }catch{ localStorage.removeItem('token'); state.token=''; } }
  draw(); setInterval(tick,1000); setInterval(syncPush,5000);
}
$('loginBtn').onclick=async()=>{ try{ const r=await api('/login',{method:'POST',body:{email:$('email').value,password:$('password').value}}); state.token=r.token; localStorage.token=r.token; state.user=r.user; await loadAll(); }catch(e){toast(e.message)} };
$('refreshBtn').onclick=()=>loadAll().then(()=>toast('已从服务端重新加载预约事实',true)).catch(toast);
$('bookBtn').onclick=()=>book();
$('pushBtn').onclick=()=>simulateOutOfOrderPush();
$('registerDeviceBtn').onclick=registerDevice;
$('templateBtn').onclick=updateTemplate;

async function loadAll(){ await Promise.all([loadRooms(),syncPush(true)]); const room=state.rooms.find(r=>r.id===state.selected)||state.rooms[0]; if(room) await selectRoom(room.id); draw(); }
async function loadRooms(){ state.rooms=await api('/rooms'); state.selected=state.selected && state.rooms.some(r=>r.id===state.selected)?state.selected:state.rooms[0]?.id; fillRoomSelects(); }
function fillRoomSelects(){ for(const sel of [$('roomId'),$('adminRoom')]){ sel.innerHTML=state.rooms.map(r=>`<option value="${r.id}">${esc(r.name)} · ${esc(r.timezone)}</option>`).join(''); sel.value=state.selected; } if(state.rooms[0]){$('startLocal').value=localInput(state.rooms.find(r=>r.id==state.selected)||state.rooms[0]); $('endLocal').value=localInput(state.rooms.find(r=>r.id==state.selected)||state.rooms[0],60); } }
$('roomId').onchange=e=>{state.selected=+e.target.value;selectRoom(state.selected);};$('adminRoom').onchange=e=>state.selected=+e.target.value;
window.selectRoom=selectRoom;
async function selectRoom(id){
  state.selected=+id;
  const room=state.rooms.find(r=>r.id===id);
  if (state.user?.role==='template_editor') { state.meetings=[]; drawMeetings(); await loadDoor(); return; }
  $('startLocal').value=localInput(room); $('endLocal').value=localInput(room,60);
  await loadMeetings(); await loadDoor();
}
async function loadMeetings(){ const q=new URLSearchParams({roomId:state.selected}); state.meetings=await api('/meetings?'+q); drawMeetings(); }
async function book(){
  try{ const m=await api('/meetings',{method:'POST',body:{roomId:+$('roomId').value,subject:$('subject').value,startLocal:$('startLocal').value,endLocal:$('endLocal').value,dstOccurrence:$('dstOccurrence').value,privacy:$('privacy').value}}); toast(`预约已成为事实 #${m.id}；UTC ${fmtUtc(m.time.startUtc)} 至 ${fmtUtc(m.time.endUtc)}，边界 ${m.time.boundary}`,true); await Promise.all([loadMeetings(), loadDoor()]); }
  catch(e){ if(e.data?.error?.code==='LOCAL_TIME_GAP'){ if(confirm('该本地时间在春令时间隙不存在，是否跳到建议时间？')){ $('startLocal').value=e.data.error.details.gap? $('startLocal').value:''; } toast(`${e.message}\n${JSON.stringify(e.data.error.details,null,2)}`); } else toast(`${e.message}\n${e.data?JSON.stringify(e.data.error.details??''):''}`); }
}
async function action(url, body, msg){ try{ const r=await api(url,{method:'POST',body}); toast(msg||'操作成功',true); await Promise.all([loadMeetings(), loadDoor()]); return r; }catch(e){toast(e.message+' '+JSON.stringify(e.data?.error?.details||''));} }
window.reschedule=(id,version,start,end)=>{ const room=state.rooms.find(r=>r.id===state.selected); action('/meetings/reschedule',{meetingId:id,expectedVersion:version,timezone:room.timezone,startLocal:document.getElementById('s'+id).value,endLocal:document.getElementById('e'+id).value,dstOccurrence:'first'},'改期已通过服务端冲突与版本检查'); };
window.extend=(id,version)=>action('/meetings/extend',{meetingId:id,endLocal:document.getElementById('x'+id).value,dstOccurrence:'first'},'延长已重新检查下一场会议，而非只改倒计时');
window.checkin=(id,version)=>action('/meetings/checkin',{meetingId:id,expectedVersion:version},'签到成功（在线原子结果）');
window.cancel=(id,version)=>action('/meetings/cancel',{meetingId:id,expectedVersion:version},'预约已撤销；旧离线确认将在上传时拒绝');
window.setPriv=(id,version,privacy)=>action('/meetings/privacy',{meetingId:id,expectedVersion:version,privacy},'隐私设置已更新');
window.uploadOfflineOld=(meetingId)=>offlineUpload(meetingId,Date.now()-365*24*3600*1000);
window.uploadOfflineNow=async meetingId=>offlineUpload(meetingId,Date.now());
async function offlineUpload(meetingId, clientClock){
  const tok=state.deviceTokens[state.selected]; if(!tok)return toast('请先由管理员注册并保存设备令牌');
  try{ const r=await api('/door/checkin',{method:'POST',deviceToken:tok,body:{meetingId,clientClockUtc:clientClock,lastKnownServerClockUtc:Date.now()-1000,maxAbsClockSkewMs:5*60*1000,confirmation:`offline-${meetingId}-${clientClock}-${crypto.randomUUID()}`}}); toast(`离线签到上传裁决：${r.status}${r.rejectionReason?'；'+r.rejectionReason:''}`,r.status==='accepted'); await Promise.all([loadMeetings(), loadDoor()]); }catch(e){toast(e.message)}
}
async function registerDevice(){
  try{ const r=await api('/admin/devices',{method:'POST',body:{roomId:+$('adminRoom').value,name:$('deviceName').value||'Door',offlinePolicy:$('offlinePolicy').value}}); state.deviceTokens[r.roomId]=r.deviceToken; localStorage.deviceTokens=JSON.stringify(state.deviceTokens); $('deviceToken').textContent=`设备令牌（仅本次显示，C 端配置使用）：\n${r.deviceToken}`; await loadDoor(); toast('门牌已注册',true); }catch(e){toast(e.message)}
}
async function updateTemplate(){
  try{ const r=await api('/template',{method:'POST',body:{roomId:state.selected,backgroundUrl:'/assets/company-bg.svg?rev='+Date.now()}}); toast(`模板已更新；meetingDetailsAccessible=${r.meetingDetailsAccessible}，编辑者未获得会议详情`,true); }catch(e){toast(e.message)}
}
async function loadDoor(){
  const tok=state.deviceTokens[state.selected]; if(!tok){state.door=null;drawDoor();return;}
  try{ state.door=await api('/door',{deviceToken:tok}); }catch(e){state.door={error:e.message,freshness:{state:'unauthorized'}};}
  drawDoor();
}
async function syncPush(first=false){
  if(!state.token)return;
  try{ const r=await api('/events?after='+state.lastEventId); state.lastEventId=r.cursor; if(!first && r.events.length){ drawMeetings(); loadMeetings(); } }catch{}
}
function applyPush(ev){ if(ev.meetingSeq <= state.latestAppliedSeq){toast(`丢弃乱序/过期推送 seq=${ev.meetingSeq}`);return false;} state.latestAppliedSeq=ev.meetingSeq; return true; }
function simulateOutOfOrderPush(){ applyPush({meetingSeq:5}); applyPush({meetingSeq:6}); const ignored=applyPush({meetingSeq:5}); toast(ignored?'':'已模拟后台乱序：新事件先应用，旧事件被丢弃，不覆盖预约事实',true); }
function draw(){
  $('userBox').innerHTML=state.user?`${esc(state.user.displayName)} · ${esc(state.user.role)} <button class="secondary" onclick="localStorage.clear();location.reload()">退出</button>`:'未登录';
  $('loginForm').hidden=!!state.user; $('bookingForm').hidden=!state.user || state.user.role==='template_editor'; $('admin').hidden=!(state.user&&(state.user.role==='admin'||state.user.role==='template_editor'));
  drawMeetings(); drawDoor(); tick();
}
function drawMeetings(){
  const el=$('meetings'); if(!state.user)return;
  el.innerHTML=state.meetings.map(m=>`<div class="meeting ${esc(m.status)}">
    <div class="row" style="justify-content:space-between"><strong>${esc(m.subject)}</strong><span class="pill ${m.status==='checked_in'?'good':m.status==='cancelled'?'bad':''}">${esc(m.status)} · v${m.version}</span></div>
    <div class="muted">${esc(m.roomName)} / ${esc(m.organizer?.displayName||'')} / 门牌：${esc(m.effectivePrivacy==='full_subject'?'完整主题':'仅占用')}</div>
    <div>本地：${esc(fmtLocal(m.time))}（${esc(m.time.timezone)}）</div>
    <div class="fact">UTC 事实：[${fmtUtc(m.time.startUtc)}, ${fmtUtc(m.time.endUtc)})
offset ${m.time.startOffsetSeconds}s → ${m.time.endOffsetSeconds}s；半开，首尾相邻不冲突${m.dstAmbiguous?`；DST重复时刻=${esc(m.dstOccurrence||'')}`:''}</div>
    <div class="row"><input id="s${m.id}" value="${esc(m.time.startLocal)}" style="max-width:210px"><input id="e${m.id}" value="${esc(m.time.endLocal)}" style="max-width:210px"><button onclick="reschedule(${m.id},${m.version})">改期</button></div>
    <div class="row"><input id="x${m.id}" value="${esc(m.time.endLocal)}" style="max-width:210px"><button class="secondary" onclick="extend(${m.id},${m.version})">临时延长</button>
    <button onclick="checkin(${m.id},${m.version})">签到</button><button class="danger" onclick="cancel(${m.id},${m.version})">撤销</button>
    <select onchange="setPriv(${m.id},${m.version},this.value)"><option value="inherit">继承</option><option value="full_subject">完整主题</option><option value="busy_only">仅占用</option></select></div>
    <div class="row"><button class="secondary" onclick="uploadOfflineNow(${m.id})">上传当前离线确认</button><button class="secondary" onclick="uploadOfflineOld(${m.id})">上传漂移旧确认</button></div>
  </div>`).join('')||'<p class="muted">暂无预约</p>';
  $('rooms').innerHTML=state.rooms.map(r=>`<div class="meeting"><strong>${esc(r.name)}</strong><div class="muted">${esc(r.timezone)} · 默认${r.defaultPrivacy==='full_subject'?'完整主题':'仅占用'}</div><button onclick="selectRoom(${r.id})">查看</button></div>`).join('');
}
function drawDoor(){
  const el=$('rooms'); const panel=document.getElementById('doorPreview'); if(!el)return;
  let old=document.getElementById('doorPreview'); if(old)old.remove();
  if(!state.user)return;
  const d=document.createElement('div'); d.id='doorPreview'; d.className='door'; d.style.marginTop='14px';
  const snap=state.door; const room=state.rooms.find(r=>r.id===state.selected);
  const bg=(snap?.room?.backgroundUrl||room?.backgroundUrl||'/assets/company-bg.svg');
  const c=snap?.current,n=snap?.next;
  let fresh='未注册设备';
  if(snap?.serverTimeUtc){ const age=Date.now()-snap.serverTimeUtc; fresh=age<60000?`新鲜 · ${Math.max(0,Math.round(age/1000))}s ago · ${snap.device.offlinePolicy==='offline_checkin_allowed'?'离线可签到':'离线只读缓存'}`:`过期 ${Math.round(age/1000)}s：继续显示缓存但标记陈旧`; }
  if(snap?.error)fresh='设备未授权：'+snap.error;
  d.innerHTML=`<img class="bg" src="${esc(bg)}" alt="" onerror="this.classList.add('failed');document.getElementById('networkNote').textContent='背景加载失败，但房间状态仍可见'"><div class="door-content"><div class="muted" style="color:#d9ecff">${esc(room?.name||'')} 门牌预览</div><div class="big">${c?(esc(c.subject)+(c.status==='checked_in'?' · 已签到':'')):'空闲'}</div><div class="time">${c?`${esc(fmtLocal(c.time))} → ${esc(fmtUtc(c.time.endUtc))}`:'当前无进行中会议'}</div><p>${n?'下一场：'+esc(n.subject)+' '+esc(fmtLocal(n.time)):'无下一场缓存'}</p><div class="statusbar"><span class="pill good">设备显示新鲜度：${esc(fresh)}</span><span id="networkNote" class="pill warn"></span></div></div>`;
  el.after(d);
}
function tick(){ $('clock').textContent='浏览器 UTC: '+new Date().toISOString(); if(state.door)drawDoor(); }
boot();
