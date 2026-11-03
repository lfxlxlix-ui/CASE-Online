const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.MAINTENANCE_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const LOG_FILE = path.join(__dirname, "case-online-logs.json");
const adminSessions = new Set();
let eventLogs = [];
try { eventLogs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); if (!Array.isArray(eventLogs)) eventLogs = []; } catch { eventLogs = []; }
function addLog(actor, action) { eventLogs.push({ actor, action, time: new Date().toISOString() }); eventLogs = eventLogs.slice(-200); try { fs.writeFileSync(LOG_FILE, JSON.stringify(eventLogs, null, 2)); } catch (error) { console.error("Log write failed:", error.message); } }
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

let maintenance = {
  active: false,
  message: "Идёт плановое техническое обслуживание. Подожди несколько минут — игра скоро снова станет доступна."
};

const clients = new Set();

function sendJson(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, x-maintenance-token"
  });
  res.end(JSON.stringify(value));
}

function safeEqual(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  if (!TOKEN || typeof req.headers["x-maintenance-token"] !== "string") return false;
  return safeEqual(req.headers["x-maintenance-token"], TOKEN);
}

function adminAuthorized(req) {
  if (!TOKEN || typeof req.headers.authorization !== "string") return false;
  const match = req.headers.authorization.match(/^Basic\s+(.+)$/i);
  if (!match) return false;
  let decoded;
  try { decoded = Buffer.from(match[1], "base64").toString("utf8"); }
  catch { return false; }
  const separator = decoded.indexOf(":");
  if (separator < 0) return false;
  return decoded.slice(0, separator) === "admin" && safeEqual(decoded.slice(separator + 1), TOKEN);
}

function hasAdminSession(req) {
  const entry = String(req.headers.cookie || "").split(";").map(x => x.trim()).find(x => x.startsWith("case_admin_session="));
  return !!entry && adminSessions.has(entry.slice("case_admin_session=".length));
}
function requireSecondFactor(req, res) { if (hasAdminSession(req)) return true; sendJson(res, 401, { error: "Дополнительный вход не выполнен." }); return false; }
function requireAdmin(req, res) {
  if (adminAuthorized(req)) return true;
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="CASE Online Admin", charset="UTF-8"',
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8"
  });
  res.end("Требуется вход администратора.");
  return false;
}

function broadcast() {
  const frame = `data: ${JSON.stringify(maintenance)}\n\n`;
  for (const client of clients) {
    try { client.write(frame); } catch { clients.delete(client); }
  }
}

const adminHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>CASE Online — Админ-панель</title>
<style>
:root{color-scheme:dark;font-family:system-ui,-apple-system,Segoe UI,sans-serif}
*{box-sizing:border-box}
#secondGate{width:min(100%,420px);background:#191e29;border:1px solid #343b4b;border-radius:18px;padding:28px}#secondGate input{width:100%;padding:13px;border-radius:9px;border:1px solid #454d60;background:#10131a;color:#fff;font:inherit}#secondGate button{width:100%;margin-top:12px;background:#42d392;color:#062217}body{margin:0;min-height:100vh;background:#10131a;color:#f4f6fb;display:grid;place-items:center;padding:20px}
main{width:min(100%,520px);background:#191e29;border:1px solid #343b4b;border-radius:20px;padding:clamp(20px,5vw,32px);box-shadow:0 20px 70px #0005}
.tag{color:#aab5cb;font-size:.85rem;letter-spacing:.08em;text-transform:uppercase}
h1{font-size:clamp(1.7rem,5vw,2.2rem);margin:.5rem 0}
p{color:#c4ccda;line-height:1.55}
.status{display:flex;align-items:center;gap:10px;padding:14px 16px;border-radius:12px;background:#11151d;margin:22px 0;font-weight:650}
.dot{width:11px;height:11px;border-radius:50%;background:#7d8798}
.status.on .dot{background:#ff626b}.status.off .dot{background:#42d392}
label{display:block;font-weight:600;margin:18px 0 8px}
textarea{width:100%;min-height:110px;resize:vertical;border-radius:10px;border:1px solid #454d60;background:#10131a;color:#fff;padding:12px;font:inherit}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px}
button{min-height:48px;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:700;cursor:pointer}
button:disabled{opacity:.55;cursor:wait}
.start{background:#ff626b;color:#21070a}.stop{background:#42d392;color:#062217}
.restart{background:#f5bd54;color:#271a00;width:100%;margin-top:12px}
#notice{min-height:1.5em;margin-top:14px;font-size:.92rem}
small{display:block;color:#aab5cb;line-height:1.5;margin-top:18px}
@media(max-width:380px){.actions{grid-template-columns:1fr}}
</style>
</head>
<body><section id="secondGate"><div class="tag">Дополнительная защита</div><h1>Повторный вход</h1><p>Введи дополнительный пароль администратора.</p><form id="unlockForm"><input id="adminPassword" type="password" autocomplete="current-password" required><button type="submit">Разблокировать панель</button></form><p id="unlockNotice" role="status"></p></section><main id="adminPanel" hidden>
<div class="tag">CASE: Online / Control</div>
<h1>Панель обслуживания</h1>
<p>Управляй режимом обслуживания. Изменения сразу отправляются всем открытым страницам игры.</p>
<div id="status" class="status"><span class="dot"></span><span id="statusText">Загрузка статуса…</span></div>
<label for="message">Сообщение посетителям</label>
<textarea id="message" maxlength="500">Идёт плановое техническое обслуживание. Подожди несколько минут — игра скоро снова станет доступна.</textarea>
<div class="actions">
<button class="start" id="enable" type="button">Включить обслуживание</button>
<button class="stop" id="disable" type="button">Выключить обслуживание</button>
</div>
<button class="restart" id="restart" type="button">↻ Перезапустить сервер</button><h2>Журнал событий</h2><div id="eventLogs" aria-live="polite">Загрузка…</div>
<div id="notice" role="status" aria-live="polite"></div>
<small>Перезапуск временно отключит API. Текущее состояние обслуживания сбросится после перезапуска. Доступ защищён входом администратора.</small>
</main>
<script>
const gate=document.getElementById("secondGate"),panel=document.getElementById("adminPanel");
document.getElementById("unlockForm").addEventListener("submit",async e=>{e.preventDefault();const note=document.getElementById("unlockNotice");note.textContent="Проверяю…";try{const r=await fetch("/admin/unlock",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:document.getElementById("adminPassword").value})});const d=await r.json();if(!r.ok)throw new Error(d.error||"Ошибка входа");gate.hidden=true;panel.hidden=false;refresh();loadLogs();}catch(x){note.textContent=x.message;}});
async function loadLogs(){try{const r=await fetch("/admin/logs",{cache:"no-store"});if(!r.ok)throw new Error("Не удалось загрузить журнал");const d=await r.json(),box=document.getElementById("eventLogs");box.replaceChildren();if(!d.logs.length){box.textContent="Событий пока нет.";return;}d.logs.slice().reverse().forEach(item=>{const p=document.createElement("p");p.textContent=(item.actor||"System")+" — "+(item.action||item.event||"Событие")+" — "+new Date(item.time).toLocaleString("ru-RU");box.appendChild(p);});}catch(e){document.getElementById("eventLogs").textContent=e.message;}}
const statusBox=document.getElementById("status");
const statusText=document.getElementById('statusText');
const messageInput=document.getElementById('message');
const notice=document.getElementById('notice');
const buttons=[document.getElementById('enable'),document.getElementById('disable')];
const restartButton=document.getElementById('restart');
function render(data){
  statusBox.className='status '+(data.active?'on':'off');
  statusText.textContent=data.active?'Обслуживание ВКЛЮЧЕНО':'Обслуживание ВЫКЛЮЧЕНО';
  if(typeof data.message==='string' && data.message) messageInput.value=data.message;
}
async function refresh(){
  try{
    const response=await fetch('/api/maintenance',{cache:'no-store'});
    if(!response.ok) throw new Error('Не удалось получить статус ('+response.status+')');
    render(await response.json());
  }catch(error){notice.textContent=error.message||'Ошибка загрузки статуса.';}
}
async function setMaintenance(active){
  buttons.forEach(button=>button.disabled=true);
  notice.textContent='Сохраняю изменения…';
  try{
    const response=await fetch('/admin/maintenance',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({active,message:messageInput.value})
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok) throw new Error(data.error||'Ошибка запроса ('+response.status+')');
    render(data);
    notice.textContent=active?'Обслуживание включено.':'Обслуживание выключено.';
  }catch(error){notice.textContent=error.message||'Не удалось изменить режим.';}
  finally{buttons.forEach(button=>button.disabled=false);}
}
buttons[0].addEventListener('click',()=>setMaintenance(true));
buttons[1].addEventListener('click',()=>setMaintenance(false));
restartButton.addEventListener('click',async()=>{
  if(!window.confirm('Перезапустить сервер сейчас? На время перезапуска API будет недоступен, а режим обслуживания сбросится.')) return;
  restartButton.disabled=true;
  buttons.forEach(button=>button.disabled=true);
  notice.textContent='Отправляю команду перезапуска… Страница может временно перестать отвечать.';
  try{
    const response=await fetch('/admin/restart',{method:'POST'});
    if(!response.ok) throw new Error('Не удалось запросить перезапуск ('+response.status+').');
    notice.textContent='Команда принята. Подожди, пока Render перезапустит сервис, затем обнови страницу.';
  }catch(error){
    notice.textContent='Соединение прервано или перезапуск начался. Подожди немного и обнови страницу.';
  }
});
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-maintenance-token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    if (!requireAdmin(req, res)) return;
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer"
    });
    return res.end(adminHtml);
  }

  if (url.pathname === "/admin/unlock" && req.method === "POST") { return handleUnlock(req, res); }
  if (url.pathname === "/admin/logs" && req.method === "GET") { if (!requireSecondFactor(req, res)) return; return sendJson(res, 200, { logs: eventLogs }); }
  if (url.pathname === "/admin/maintenance" && req.method === "POST") {
    if (!requireSecondFactor(req, res)) return;
    return handleMaintenancePost(req, res, "Admin");
  }

  if (url.pathname === "/admin/restart" && req.method === "POST") {
    if (!requireSecondFactor(req, res)) return;
    res.writeHead(202, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({ok:true,message:"Restart requested"}));
    addLog("Admin", "перезапустил сервер");
    console.warn("Admin requested a service restart.");
    setTimeout(() => process.exit(1), 300);
    return;
  }

  if (url.pathname === "/api/maintenance" && req.method === "GET") {
    return sendJson(res, 200, maintenance);
  }

  if (url.pathname === "/api/maintenance/events" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN
    });
    res.write(`data: ${JSON.stringify(maintenance)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/maintenance" && req.method === "POST") {
    if (!authorized(req)) return sendJson(res, 401, { error: "Unauthorized" });
    return handleMaintenancePost(req, res, "System");
  }

  return sendJson(res, 404, { error: "Not found" });
});


const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN === "*" ? true : ALLOWED_ORIGIN, methods: ["GET", "POST"] },
  maxHttpBufferSize: 1e5
});
const rooms = new Map();
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeRoomCode() {
  let code;
  do { code = Array.from({length:5}, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join(""); }
  while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, status: room.status, maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map(p => ({id:p.id,name:p.name,ready:p.ready,role:p.role,x:p.x,y:p.y,angle:p.angle,survivorClass:p.survivorClass,animatronicChoice:p.animatronicChoice,character:p.character}))
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function ackError(ack, error) { if (typeof ack === "function") ack({ok:false,error}); }
function findRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}
function leaveRoom(socket) {
  const room = findRoom(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);
  socket.data.roomCode = null;
  if (!room.players.size) { rooms.delete(room.code); return; }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.status === "playing") {
    room.status = "finished";
    io.to(room.code).emit("game:ended", {message:"Игрок покинул матч."});
    rooms.delete(room.code);
  } else emitRoom(room);
}
io.on("connection", socket => {
  socket.on("room:create", (data={}, ack) => {
    leaveRoom(socket);
    const room = {code:makeRoomCode(),hostId:socket.id,status:"waiting",maxPlayers:5,players:new Map()};
    room.players.set(socket.id,{id:socket.id,name:String(data.name||"Игрок").trim().slice(0,18)||"Игрок",ready:false,role:null,x:2.5,y:1.5,angle:0,survivorClass:"aimer",animatronicChoice:"owl"});
    rooms.set(room.code,room);socket.join(room.code);socket.data.roomCode=room.code;
    if(typeof ack==="function")ack({ok:true,room:publicRoom(room),host:true});
    emitRoom(room);
  });
  socket.on("room:join", (data={}, ack) => {
    const code=String(data.code||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    const room=rooms.get(code);
    if(!room||room.status!=="waiting")return ackError(ack,"Комната не найдена или матч уже начался.");
    if(room.players.size>=room.maxPlayers)return ackError(ack,"Комната заполнена.");
    leaveRoom(socket);
    room.players.set(socket.id,{id:socket.id,name:String(data.name||"Игрок").trim().slice(0,18)||"Игрок",ready:false,role:null,x:2.5,y:1.5,angle:0,survivorClass:"aimer",animatronicChoice:"owl"});
    socket.join(room.code);socket.data.roomCode=room.code;
    if(typeof ack==="function")ack({ok:true,room:publicRoom(room),host:false});
    emitRoom(room);
  });
  socket.on("player:ready", (ready, ack) => {
    const room=findRoom(socket),p=room?.players.get(socket.id);
    if(!p||room.status!=="waiting")return ackError(ack,"Сейчас нельзя изменить готовность.");
    p.ready=!!ready;if(typeof ack==="function")ack({ok:true,room:publicRoom(room),host:room.hostId===socket.id});emitRoom(room);
  });
  socket.on("player:loadout", (data={}, ack) => {
    const room=findRoom(socket),p=room?.players.get(socket.id);
    if(!p||room.status!=="waiting")return ackError(ack,"Комната не найдена.");
    if(["aimer","medic","support"].includes(data.survivorClass))p.survivorClass=data.survivorClass;
    if(["cat","wolf","bull","owl"].includes(data.animatronicChoice))p.animatronicChoice=data.animatronicChoice;
    if(typeof ack==="function")ack({ok:true,room:publicRoom(room),host:room.hostId===socket.id});emitRoom(room);
  });
  socket.on("game:start", (ack) => {
    const room=findRoom(socket);
    if(!room||room.hostId!==socket.id)return ackError(ack,"Начать матч может только создатель комнаты.");
    if(room.status!=="waiting"||room.players.size<2)return ackError(ack,"Для матча нужно минимум два игрока.");
    if([...room.players.values()].some(p=>!p.ready&&p.id!==room.hostId))return ackError(ack,"Не все игроки готовы.");
    room.status="playing";
    const players=[...room.players.values()],hunter=players[crypto.randomInt(players.length)];
    players.forEach((p,i)=>{p.role=p===hunter?"animatronic":"survivor";p.x=p.role==="animatronic"?12.5:2.5+(i%2)*.5;p.y=p.role==="animatronic"?8.5:1.5+Math.floor(i/2)*.5;p.angle=0;p.ready=false;p.character=p.role==="animatronic"?p.animatronicChoice:p.survivorClass;});
    const state=publicRoom(room);
    io.to(room.code).emit("game:started",state);
    if(typeof ack==="function")ack({ok:true,room:state,host:true});
    emitRoom(room);
  });
  socket.on("player:move", data => {
    const room=findRoom(socket),p=room?.players.get(socket.id);
    if(!p||room.status!=="playing"||!data)return;
    const x=Number(data.x),y=Number(data.y),angle=Number(data.angle);
    if(!Number.isFinite(x)||!Number.isFinite(y)||!Number.isFinite(angle)||Math.abs(x)>100||Math.abs(y)>100)return;
    p.x=x;p.y=y;p.angle=angle;
    socket.to(room.code).emit("player:moved",{id:p.id,x:p.x,y:p.y,angle:p.angle,role:p.role,character:p.character});
  });
  socket.on("player:tag", data => {
    const room=findRoom(socket),hunter=room?.players.get(socket.id),target=room?.players.get(String(data?.targetId||""));
    if(!room||room.status!=="playing"||!hunter||hunter.role!=="animatronic"||!target||target.role!=="survivor")return;
    if(Math.hypot(target.x-hunter.x,target.y-hunter.y)>1.5)return;
    io.to(room.code).emit("game:ended",{message:"Аниматроник поймал игрока. Раунд завершён."});
    room.status="finished";rooms.delete(room.code);
    for(const id of room.players.keys()){const s=io.sockets.sockets.get(id);if(s)s.data.roomCode=null;}
  });
  socket.on("room:leave",()=>leaveRoom(socket));
  socket.on("disconnect",()=>leaveRoom(socket));
});

function handleUnlock(req, res) {
  let body=""; req.on("data",c=>{body+=c;}); req.on("end",()=>{let d;try{d=JSON.parse(body||"{}");}catch{return sendJson(res,400,{error:"Invalid JSON"});} if(!ADMIN_PASSWORD)return sendJson(res,503,{error:"ADMIN_PASSWORD не задана в Render."}); if(typeof d.password!=="string"||!safeEqual(d.password,ADMIN_PASSWORD))return sendJson(res,401,{error:"Неверный дополнительный пароль."}); const id=crypto.randomBytes(32).toString("hex");adminSessions.add(id);res.writeHead(200,{"Set-Cookie":"case_admin_session="+id+"; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=43200","Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});res.end(JSON.stringify({ok:true}));});
}
function handleMaintenancePost(req, res, actor = "System") {
  let body = "";
  let tooLarge = false;
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 10000 && !tooLarge) {
      tooLarge = true;
      sendJson(res, 413, { error: "Payload too large" });
    }
  });

  req.on("end", () => {
    if (tooLarge) return;
    let data;
    try { data = JSON.parse(body || "{}"); }
    catch { return sendJson(res, 400, { error: "Invalid JSON" }); }

    if (typeof data.active !== "boolean") {
      return sendJson(res, 400, { error: 'Expected {"active":true} or {"active":false}' });
    }

    const wasActive = maintenance.active;
    maintenance = {
      active: data.active,
      message: typeof data.message === "string" && data.message.trim()
        ? data.message.trim().slice(0, 500)
        : maintenance.message
    };
    if (wasActive !== maintenance.active) addLog(actor, maintenance.active ? "включил технические работы" : "выключил технические работы");
    broadcast();
    return sendJson(res, 200, { ok: true, ...maintenance });
  });
}

server.listen(PORT, "0.0.0.0", () => {
  addLog("System", "сервер запущен / перезапущен");
  console.log(`CASE Online maintenance API listening on port ${PORT}`);
  if (!TOKEN) console.warn("MAINTENANCE_TOKEN is not set; maintenance changes are disabled.");
});
