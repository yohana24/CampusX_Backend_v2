(() => {
  'use strict';

  const API = '/api/v1';
  const page = location.pathname.toLowerCase().endsWith('/settings.html') ? 'settings' : 'control';
  const state = {
    user: null, rooms: [], roomId: null, health: null, sql: null,
    devices: [], latest: [], alerts: [], commands: [], states: [], rules: [],
    stream: null, streamOnline: false, refreshTimer: null, relayBusy: false,
    relayState: 'unknown', selectedRelay: '', lastRefresh: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const valueOf = (r) => r?.value ?? r?.valueNumeric ?? r?.ValueNumeric ?? r?.valueText ?? r?.ValueText ?? r?.valueJson ?? r?.ValueJson ?? null;
  const getField = (obj, ...keys) => {
    if (!obj) return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) return obj[key];
      const found = Object.keys(obj).find(k => k.toLowerCase() === key.toLowerCase());
      if (found && obj[found] !== undefined && obj[found] !== null) return obj[found];
    }
    return undefined;
  };
  const arrayOf = (r) => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
  const dateOf = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const formatDate = (v) => { const d = dateOf(v); return d ? d.toLocaleString([], {dateStyle:'medium',timeStyle:'short'}) : 'Not available'; };
  const ago = (v) => {
    const d = dateOf(v); if (!d) return 'No reading yet';
    const s = Math.max(0, Math.floor((Date.now()-d.getTime())/1000));
    if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`; return `${Math.floor(s/86400)}d ago`;
  };
  const userInitials = (name) => {
    const parts = String(name || 'CX').trim().split(/[\s._-]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0]+parts[1][0] : String(name || 'CX').slice(0,2)).toUpperCase();
  };
  const toast = (message, kind='info') => {
    let host = $('#live-page-toast');
    if (!host) { host=document.createElement('div'); host.id='live-page-toast'; host.style.cssText='position:fixed;right:20px;bottom:20px;z-index:9999;display:grid;gap:8px;max-width:min(420px,calc(100vw - 40px))'; document.body.append(host); }
    const item=document.createElement('div'); item.textContent=message;
    item.style.cssText=`padding:12px 16px;border-radius:10px;color:#fff;background:${kind==='error'?'#991b1b':kind==='success'?'#166534':'#1e3a8a'};box-shadow:0 8px 24px #0004;font:500 13px Inter, sans-serif`;
    host.append(item); setTimeout(()=>item.remove(),4500);
  };
  async function request(path, options={}) {
    const headers={...(options.headers||{})};
    if (options.body && !headers['Content-Type']) headers['Content-Type']='application/json';
    const key=sessionStorage.getItem('campusx_api_key'); if(key) headers['X-API-Key']=key;
    let response;
    try { response=await fetch(path.startsWith('/auth/') ? path : `${API}${path}`, {...options,headers,credentials:'same-origin',cache:'no-store'}); }
    catch(e){ throw new Error(`Cannot reach CampusX server: ${e.message}`); }
    if (response.status===401 && path!=='/auth/session') {
      const session=await fetch('/auth/session',{credentials:'same-origin',cache:'no-store'}).catch(()=>null);
      if (!session || session.status===401) { location.replace(`/login.html?next=${encodeURIComponent(location.pathname+location.search)}`); throw new Error('Login session expired.'); }
      if (!key && !sessionStorage.getItem('campusx_api_key')) {
        const entered=window.prompt('Enter the CampusX API key from the backend .env file (leave blank to cancel):');
        if(entered && entered.trim()){ sessionStorage.setItem('campusx_api_key',entered.trim()); return request(path,options); }
      }
    }
    const text=await response.text(); let payload={};
    try{payload=text?JSON.parse(text):{};}catch{payload={raw:text};}
    if(!response.ok) throw new Error(payload?.error?.message || payload?.message || `HTTP ${response.status}`);
    return payload;
  }
  const get=(path)=>request(path);
  const post=(path,body)=>request(path,{method:'POST',body:JSON.stringify(body)});
  const patch=(path,body)=>request(path,{method:'PATCH',body:JSON.stringify(body)});
  const show=(id,value)=>{const el=document.getElementById(id);if(el)el.textContent=value;};
  const statusTag=(id,label,ok)=>{
    const el=document.getElementById(id); if(!el)return;
    el.textContent=label; el.classList.remove('tag-online','tag-connected','tag-active');
    el.classList.add(ok?'tag-online':'tag-connected');
  };
  function addSharedUi(){
    const theme=$('#theme-toggle');
    const saved=localStorage.getItem('campusx_theme'); if(saved) document.documentElement.dataset.theme=saved;
    theme?.addEventListener('click',()=>{const next=document.documentElement.dataset.theme==='light'?'dark':'light';document.documentElement.dataset.theme=next;localStorage.setItem('campusx_theme',next);});
    $('#mobile-menu-btn')?.addEventListener('click',()=>$('.sidebar')?.classList.toggle('open'));
    $$('.header-right-group .icon-btn').forEach(b=>{if(b.id!=='theme-toggle')b.addEventListener('click',()=>location.href='/alerts.html');});
    ['settings-signout','security-signout'].forEach(id=>document.getElementById(id)?.addEventListener('click',logout));
    $('#settings-refresh')?.addEventListener('click',()=>refreshAll(true));
    $('#settings-refresh-services')?.addEventListener('click',()=>refreshAll(true));
    $('#control-refresh')?.addEventListener('click',()=>refreshAll(true));
    $('#control-rules-refresh')?.addEventListener('click',()=>refreshAll(true));
    if(window.lucide) window.lucide.createIcons();
  }
  async function logout(){
    try{await request('/auth/logout',{method:'POST'});}catch{}
    sessionStorage.removeItem('campusx_api_key'); location.replace('/login.html');
  }
  async function loadSession(){
    const session=await get('/auth/session'); state.user=session.user||{};
    const username=state.user.username||'CampusX Operator';
    show('live-header-username',username); show('live-header-account-state','Authenticated');
    show('live-header-avatar',userInitials(username));
    if(page==='settings'){
      show('live-account-initials',userInitials(username));
      const h=$('#live-account-id'); if(h)h.textContent='Authenticated session';
      show('live-account-email','Email is not configured for this account.');
      show('live-account-description','CampusX local operator account');
      const full=$('#live-account-fullname');if(full)full.value=username;
      const email=$('#live-account-email-input');if(email)email.value='Not configured';
      const dept=$('#live-account-department');if(dept)dept.value='Not configured';
      show('live-security-user',username);
      show('live-security-expiry',formatDate(state.user.expiresAt));
      const ms=dateOf(state.user.expiresAt)?.getTime()-Date.now();
      show('live-security-remaining',Number.isFinite(ms)&&ms>0?duration(ms):'Expired');
      show('live-session-governance',`Authenticated browser session for ${username}. Other-session tracking is not configured.`);
      show('live-account-session-footer',`Session expires: ${formatDate(state.user.expiresAt)}`);
      show('live-security-footer','Signed-in session uses the CampusX HttpOnly authentication cookie.');
      show('live-security-state','AUTHENTICATED SESSION');
    }
    return session;
  }
  function duration(ms){const min=Math.floor(ms/60000),h=Math.floor(min/60),d=Math.floor(h/24);if(d)return `${d}d ${h%24}h remaining`;if(h)return `${h}h ${min%60}m remaining`;return `${min}m remaining`;}
  async function loadRooms(){
    const rooms=arrayOf(await get('/rooms')); state.rooms=rooms;
    const selects=[$('#lab-select-dropdown'),$('#control-room-dropdown')].filter(Boolean);
    const saved=Number(localStorage.getItem('campusx_legacy_room_id'));
    const chosen=rooms.find(r=>Number(getField(r,'roomId','id'))===saved)||rooms.find(r=>String(getField(r,'roomCode')||'').toUpperCase()==='LAB-01')||rooms[0]||null;
    state.roomId=chosen?Number(getField(chosen,'roomId','id')):null;
    for(const select of selects){
      select.innerHTML=rooms.map(r=>{const id=getField(r,'roomId','id');const code=getField(r,'roomCode')||'';const name=getField(r,'roomName','name')||code||`Room ${id}`;return `<option value="${esc(id)}">${esc(code?`${code} - `:'')}${esc(name)}</option>`;}).join('')||'<option value="">No rooms available</option>';
      if(state.roomId) select.value=String(state.roomId);
      if (!select.dataset.liveBound) {
        select.addEventListener('change',()=>{state.roomId=Number(select.value)||null;if(state.roomId)localStorage.setItem('campusx_legacy_room_id',String(state.roomId));syncRoomSelects();refreshAll(true);});
        select.dataset.liveBound='1';
      }
    }
    return rooms;
  }
  function syncRoomSelects(){[$('#lab-select-dropdown'),$('#control-room-dropdown')].filter(Boolean).forEach(s=>{if(state.roomId)s.value=String(state.roomId);});}
  function roomQuery(){return state.roomId?`?roomId=${encodeURIComponent(state.roomId)}`:'';}
  function currentRoom(){return state.rooms.find(r=>Number(getField(r,'roomId','id'))===Number(state.roomId))||null;}
  function updateCommonHealth(health){
    state.health=health||state.health;
    const online=health?.status==='ok',db=health?.database==='connected',mqtt=health?.mqtt==='connected';
    show('live-backend-status',online?'● Live':'● Offline');show('live-database-status',db?'● Connected':'● Disconnected');show('live-mqtt-status',mqtt?'● Online':'● Offline');
    ['live-backend-status','live-database-status','live-mqtt-status'].forEach(id=>{const el=document.getElementById(id);if(el)el.className=(el.textContent.includes('Live')||el.textContent.includes('Online')||el.textContent.includes('Connected'))?'green-text':'red-text';});
    if(page==='settings'){
      const all=online&&db&&mqtt;statusTag('live-all-services',all?'● Core Services Operational':'● Service Attention Required',all);
      statusTag('live-conn-mqtt',mqtt?'Connected':'Disconnected',mqtt);
      statusTag('live-conn-db',db?'Connected':'Disconnected',db);
      statusTag('live-conn-api',online?'Available':'Unavailable',online);
    }
    if(page==='control'){
      show('control-health-label',online&&db?'● Backend & Database Online':'● Backend Attention Required');
      show('control-mqtt-label',mqtt?'MQTT: Connected':'MQTT: Disconnected');
      statusTag('control-command-broker',mqtt?'● MQTT Broker Connected':'● MQTT Broker Offline',mqtt);
    }
  }
  async function loadHealth(){
    const [healthRes,sqlRes]=await Promise.allSettled([get('/health'),get('/sqlserver/health')]);
    const health=healthRes.status==='fulfilled'?healthRes.value:null;
    state.sql=sqlRes.status==='fulfilled'?(sqlRes.value.data||sqlRes.value):null;
    updateCommonHealth(health);
    if(page==='settings'){
      const sql=state.sql||{};
      const p=$('#live-conn-db')?.closest('.connection-row')?.querySelector('.conn-info p');
      if(p)p.textContent=`Database: ${getField(sql,'databaseName','database')||'CampusX'}${getField(sql,'tableCount')!=null?` · ${getField(sql,'tableCount')} tables`:''}`;
      const apiP=$('#live-conn-api')?.closest('.connection-row')?.querySelector('.conn-info p');
      if(apiP)apiP.textContent=`${location.origin} · REST API v1`;
    }
    return health;
  }
  function latestMetric(code){
    const rows=state.latest.filter(r=>String(getField(r,'metricCode','metric')||'').toLowerCase()===code.toLowerCase());
    rows.sort((a,b)=>(dateOf(getField(b,'recordedAt','RecordedAt','receivedAt','ReceivedAt'))?.getTime()||0)-(dateOf(getField(a,'recordedAt','RecordedAt','receivedAt','ReceivedAt'))?.getTime()||0));
    return rows[0]||null;
  }
  function metricDisplay(code,unit){const row=latestMetric(code);const v=valueOf(row);return {row,value:v,text:v==null?'—':`${Number.isFinite(Number(v))?Number(v).toFixed(1):String(v)} ${unit||getField(row,'unit','defaultUnit')||''}`.trim()};}
  async function loadSharedData(){
    const roomQ=roomQuery();
    const [devices,latest,alerts,nodes,commands,states,rules]=await Promise.allSettled([
      get(`/devices${roomQ}`),get(`/telemetry/latest${roomQ}`),get(`/alerts?limit=30${state.roomId?`&roomId=${state.roomId}`:''}`),
      get(`/nodes${roomQ}`),get('/commands?limit=100'),get('/states?limit=100'),get(`/alert-rules${roomQ}`)
    ]);
    const val=(r)=>r.status==='fulfilled'?arrayOf(r.value):[];
    state.devices=val(devices);state.latest=val(latest);state.alerts=val(alerts);state.nodes=val(nodes);state.commands=val(commands);state.states=val(states);state.rules=val(rules);
    state.lastRefresh=new Date();
    show('live-alert-count',state.alerts.filter(a=>['open','acknowledged'].includes(String(getField(a,'status')||'').toLowerCase())).length);
    if(page==='settings')renderSettingsData(); else renderControlData();
    const failures=[devices,latest,alerts,nodes,commands,states,rules].filter(r=>r.status==='rejected');
    if(failures.length) toast(`${failures.length} data source(s) could not be loaded. Some fields may show unavailable.`, 'error');
  }
  function renderSettingsData(){
    const open=state.alerts.filter(a=>['open','acknowledged'].includes(String(getField(a,'status')||'').toLowerCase())).length;
    show('live-notification-summary',`${open} active alert(s) in CampusX · In-dashboard feed refreshes through SSE.`);
    show('live-connection-updated',`Last checked: ${state.lastRefresh?.toLocaleTimeString()||'—'}`);
    const sse=$('#live-conn-sse');if(sse) { sse.textContent=state.streamOnline?'Connected':'Disconnected';sse.className=state.streamOnline?'tag-online':'tag-connected'; }
    const p=$('#live-conn-sse')?.closest('.connection-row')?.querySelector('.conn-info p');if(p)p.textContent='Authenticated Server-Sent Events connection · /api/v1/stream';
    const active=state.devices.filter(d=>getField(d,'isActive')!==false).length;
    const online=state.devices.filter(d=>String(getField(d,'status')||'').toLowerCase()==='online').length;
    const uptime=$('#live-conn-mqtt')?.closest('.connection-row')?.querySelector('.uptime-text');if(uptime)uptime.textContent=state.health?.mqtt==='connected'?'Connected':'Disconnected';
    const dbUptime=$('#live-conn-db')?.closest('.connection-row')?.querySelector('.uptime-text');if(dbUptime)dbUptime.textContent=`${state.sql?.tableCount??'—'} tables`;
    const apiUptime=$('#live-conn-api')?.closest('.connection-row')?.querySelector('.uptime-text');if(apiUptime)apiUptime.textContent=`${online} online / ${active} active`;
  }
  function deviceTypeText(d){return [getField(d,'deviceType','deviceTypeName','typeName','category','type')].filter(Boolean).join(' ').toLowerCase();}
  function renderControlData(){
    const room=currentRoom();
    const temp=metricDisplay('temperature','°C'),hum=metricDisplay('humidity','%'),co2=metricDisplay('co2_ppm','ppm'),people=metricDisplay('people_count','persons');
    const tempEl=$('#control-temperature-value');if(tempEl)tempEl.textContent=temp.value==null?'— °C':`${Number(temp.value).toFixed(1)}°C`;
    show('control-temperature-meta',temp.row?`${getField(temp.row,'deviceCode')||'Sensor'} · ${ago(getField(temp.row,'recordedAt','RecordedAt'))}`:'No temperature telemetry received.');
    show('control-humidity-value',hum.value==null?'—':`${Number(hum.value).toFixed(1)} %`);
    show('control-co2-value',co2.value==null?'—':`${Number(co2.value).toFixed(0)} ppm`);
    show('control-last-telemetry',temp.row?ago(getField(temp.row,'recordedAt','RecordedAt')):'No data');
    const pCount=people.value==null?null:Number(people.value);
    const capacity=Number(getField(room,'capacity'))>0?Number(getField(room,'capacity')):null;
    const countEl=$('.headcount-num');if(countEl){const sm=$('#control-capacity-label');const countText=pCount==null?'—':String(Math.round(pCount));if(sm){const textNode=[...countEl.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);if(textNode)textNode.textContent=countText+' ';else countEl.insertBefore(document.createTextNode(countText+' '),sm);sm.textContent=capacity?`/ ${capacity} Max Persons`:'/ Capacity not configured';}else{countEl.textContent=countText;}}
    const pct=pCount!=null&&capacity?Math.min(100,Math.max(0,pCount/capacity*100)):null;
    show('control-capacity-percent',pct==null?'—':`${Math.round(pct)}%`);
    const fill=$('#control-capacity-fill');if(fill)fill.style.width=`${pct||0}%`;
    show('control-occupancy-footer',pCount==null?'No people_count telemetry received yet.':`${capacity?`${Math.max(0,capacity-Math.round(pCount))} seats remaining`:'Room capacity not configured'} · Latest count ${Math.round(pCount)} · ${people.row?ago(getField(people.row,'recordedAt','RecordedAt')):''}`);
    show('control-cv-state',people.row?'● PEOPLE COUNTER DATA RECEIVED':'● WAITING FOR CAMERA DATA');
    const tempRules=state.rules.filter(r=>String(getField(r,'metricCode','metric')||'').toLowerCase()==='temperature');
    const co2Rules=state.rules.filter(r=>String(getField(r,'metricCode','metric')||'').toLowerCase()==='co2_ppm');
    showRules('control-temperature-rules','control-temperature-rules-meta',tempRules,'°C');
    showRules('control-co2-rules','control-co2-rules-meta',co2Rules,'ppm');
    show('control-rules-updated',`Loaded ${state.rules.length} rule(s) from CampusX Alert_Rules.`);
    renderRelay();renderCommands();
    if(window.lucide)window.lucide.createIcons();
  }
  function showRules(inputId,metaId,rules,unit){
    const input=document.getElementById(inputId);const meta=document.getElementById(metaId);if(!input||!meta)return;
    const enabled=rules.filter(r=>getField(r,'isEnabled')!==false);
    input.value=enabled.length?enabled.map(r=>`${getField(r,'ruleName')||'Rule'}: ${getField(r,'operator')||'≥'} ${getField(r,'threshold')} ${unit}`).join(' | '):'No rules configured';
    meta.textContent=enabled.length?`${enabled.length} enabled rule(s) · Read-only database view`:'No enabled rules for this metric.';
  }
  function stateFromRows(device){
    const did=Number(getField(device,'deviceId','id'));
    const row=state.states.find(s=>Number(getField(s,'deviceId','DeviceId'))===did);
    if(row){
      let raw=getField(row,'stateValue','StateValue','value','Value','valueText','ValueText','valueJson','ValueJson','stateJson','StateJson');
      if(raw&&typeof raw==='object')raw=getField(raw,'state','value');
      if(typeof raw==='string'){try{const parsed=JSON.parse(raw);raw=getField(parsed,'state','value')??raw;}catch{}}
      const normalized=String(raw??'').toLowerCase();if(['on','off'].includes(normalized))return normalized;
    }
    const recent=state.commands.filter(c=>Number(getField(c,'deviceId','DeviceId'))===did && String(getField(c,'commandType','type')||'').toLowerCase()==='set_state')
      .sort((a,b)=>(dateOf(getField(b,'createdAt','CreatedAt'))?.getTime()||0)-(dateOf(getField(a,'createdAt','CreatedAt'))?.getTime()||0))[0];
    if(recent&&String(getField(recent,'status')||'').toLowerCase()==='completed'){
      let payload=getField(recent,'payload','payloadJson','PayloadJson');if(typeof payload==='string'){try{payload=JSON.parse(payload)}catch{payload={}}}
      const desired=String(getField(payload,'state')||'').toLowerCase();if(['on','off'].includes(desired))return desired;
    }
    return 'unknown';
  }
  function renderRelay(){
    const relays=state.devices.filter(d=>/relay|actuator|fan/.test(deviceTypeText(d))||/relay|fan/i.test(String(getField(d,'deviceCode','deviceName')||'')));
    const select=$('#control-relay-select');if(!select)return;
    const preferred=relays.find(d=>getField(d,'deviceCode')==='fan-relay-lab-01')||relays[0];
    const prev=state.selectedRelay||preferred&&String(getField(preferred,'deviceCode'))||'';
    select.innerHTML=relays.map(d=>`<option value="${esc(getField(d,'deviceCode'))}">${esc(getField(d,'deviceName')||getField(d,'deviceCode'))}</option>`).join('')||'<option value="">No Relay registered</option>';
    state.selectedRelay=relays.some(d=>String(getField(d,'deviceCode'))===prev)?prev:(preferred?String(getField(preferred,'deviceCode')):'');
    select.value=state.selectedRelay;
    const device=relays.find(d=>String(getField(d,'deviceCode'))===state.selectedRelay);
    state.relayState=device?stateFromRows(device):'unknown';
    const btn=$('#control-relay-toggle');if(btn)btn.disabled=!device||state.relayBusy;
    const badge=$('#control-relay-state');if(badge){badge.textContent=state.relayBusy?'● COMMAND PENDING':`● STATE: ${state.relayState.toUpperCase()}`;badge.classList.toggle('pill-badge-green',state.relayState==='on');}
    if(btn)btn.classList.toggle('active',state.relayState==='on');
    show('control-relay-hint',device?(state.relayBusy?'Waiting for device acknowledgement…':`Selected: ${getField(device,'deviceCode')} · Click to ${state.relayState==='on'?'turn OFF':'turn ON'}.`):'No Relay/actuator device is registered in this room.');
    if(!select.dataset.bound){select.addEventListener('change',()=>{state.selectedRelay=select.value;renderRelay();});select.dataset.bound='1';}
  }
  async function toggleRelay(){
    if(state.relayBusy)return;
    const code=$('#control-relay-select')?.value;if(!code){toast('No registered Relay device is available.','error');return;}
    const desired=state.relayState==='on'?'off':'on';state.relayBusy=true;renderRelay();
    try{
      const res=await post('/commands',{deviceCode:code,commandType:'set_state',payload:{state:desired}});
      const cmd=res.data||res;toast(`Command #${getField(cmd,'commandId','id')??'—'} sent. Waiting for device acknowledgement.`, 'success');
      const id=getField(cmd,'commandId','id');
      for(let i=0;i<10;i++){
        await new Promise(r=>setTimeout(r,1000));
        const [commands,states]=await Promise.allSettled([get('/commands?limit=20'),get('/states?limit=100')]);
        if(commands.status==='fulfilled')state.commands=arrayOf(commands.value);
        if(states.status==='fulfilled')state.states=arrayOf(states.value);
        const updated=state.commands.find(c=>String(getField(c,'commandId','id'))===String(id));
        if(updated&&['completed','failed'].includes(String(getField(updated,'status')||'').toLowerCase())){
          if(String(getField(updated,'status')).toLowerCase()==='completed')toast(`Relay acknowledged: ${desired.toUpperCase()}.`,'success');
          else toast(`Relay command failed: ${desired.toUpperCase()}.`,'error');
          break;
        }
      }
    }catch(e){toast(e.message,'error');}
    finally{state.relayBusy=false;await refreshAll(false);}
  }
  function renderCommands(){
    const list=$('#control-command-list');if(!list)return;
    const roomDeviceIds=new Set(state.devices.map(d=>Number(getField(d,'deviceId','id'))));
    const scoped=state.commands.filter(c=>roomDeviceIds.has(Number(getField(c,'deviceId','DeviceId'))));
    const rows=scoped.slice(0,6);
    list.innerHTML=rows.length?rows.map(c=>{
      const id=getField(c,'commandId','id')??'—';const device=getField(c,'deviceCode')||'Device';const type=getField(c,'commandType','type')||'Command';const status=String(getField(c,'status')||'unknown');
      let payload=getField(c,'payload','payloadJson','PayloadJson')||'';if(typeof payload==='object')payload=JSON.stringify(payload);if(typeof payload==='string'&&payload.length>80)payload=payload.slice(0,80);
      return `<div class="stream-item"><span>● #${esc(id)} · ${esc(device)} · ${esc(type)} ${esc(payload)}</span><small>${esc(status)} · ${esc(formatDate(getField(c,'createdAt','CreatedAt')))}</small></div>`;
    }).join(''):'<div class="stream-item">No commands have been issued.</div>';
    const latest=rows[0];
    show('control-command-latest-title',latest?`Command #${getField(latest,'commandId','id')} · ${getField(latest,'status')}`:'No commands recorded yet.');
    show('control-command-latest-detail',latest?`${getField(latest,'deviceCode')||'Device'} · ${getField(latest,'commandType','type')||'Command'} · ${formatDate(getField(latest,'completedAt','CompletedAt','createdAt','CreatedAt'))}`:'Command history is empty.');
    show('control-command-latest-status',latest?String(getField(latest,'status')||'unknown'):'—');
    if(window.lucide)window.lucide.createIcons();
  }
  async function setCapacity(){
    const room=currentRoom();if(!room){toast('Select a room first.','error');return;}
    const current=Number(getField(room,'capacity'))||'';const raw=prompt(`Set maximum occupancy for ${getField(room,'roomCode')||getField(room,'roomName')||'selected room'}:`,current);
    if(raw===null)return;const capacity=Number(raw);if(!Number.isInteger(capacity)||capacity<1){toast('Capacity must be a positive whole number.','error');return;}
    try{await patch(`/rooms/${getField(room,'roomId','id')}`,{capacity});toast('Room capacity updated in CampusX.','success');await loadRooms();await loadSharedData();}
    catch(e){toast(e.message,'error');}
  }
  async function refreshSettingsData(){
    const open=state.alerts.filter(a=>['open','acknowledged'].includes(String(getField(a,'status')||'').toLowerCase())).length;
    show('live-notification-summary',`${open} active alert(s) recorded in CampusX SQL Server. Delivery: in-dashboard SSE feed.`);
  }
  async function refreshAll(showToast=false){
    try{await loadHealth();await loadSharedData();if(page==='settings')await refreshSettingsData();if(showToast)toast('Data refreshed from CampusX Backend.','success');}
    catch(e){toast(e.message,'error');console.error('[CampusX legacy pages]',e);}
  }
  function connectSse(){
    const key=sessionStorage.getItem('campusx_api_key');const url=`${API}/stream${key?`?apiKey=${encodeURIComponent(key)}`:''}`;
    if(state.stream)state.stream.close();state.stream=new EventSource(url);
    state.stream.addEventListener('open',()=>{state.streamOnline=true;if(page==='settings'){const tag=$('#live-conn-sse');if(tag){tag.textContent='Connected';tag.className='tag-online';}}});
    state.stream.addEventListener('error',()=>{state.streamOnline=false;if(page==='settings'){const tag=$('#live-conn-sse');if(tag){tag.textContent='Reconnecting…';tag.className='tag-connected';}}});
    ['telemetry','device.status','alert','command','device.state','device.created','device.updated','room.updated'].forEach(type=>state.stream.addEventListener(type,()=>{
      clearTimeout(state.refreshTimer);state.refreshTimer=setTimeout(()=>refreshAll(false),400);
    }));
  }
  async function init(){
    addSharedUi();
    try{await loadSession();await loadRooms();await refreshAll(false);connectSse();}
    catch(e){toast(e.message,'error');console.error('[CampusX legacy pages]',e);}
    setInterval(()=>{refreshAll(false);if(page==='settings'&&state.user?.expiresAt){const ms=new Date(state.user.expiresAt).getTime()-Date.now();show('live-security-remaining',ms>0?duration(ms):'Expired');}},20000);
    if(page==='control'){
      $('#control-relay-toggle')?.addEventListener('click',toggleRelay);
      $('#control-set-capacity')?.addEventListener('click',setCapacity);
    }
    if(window.lucide)window.lucide.createIcons();
  }
  document.addEventListener('DOMContentLoaded',init);
})();
