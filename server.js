const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.MAINTENANCE_TOKEN;
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
body{margin:0;min-height:100vh;background:#10131a;color:#f4f6fb;display:grid;place-items:center;padding:20px}
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
<body><main>
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
<button class="restart" id="restart" type="button">↻ Перезапустить сервер</button>
<div id="notice" role="status" aria-live="polite"></div>
<small>Перезапуск временно отключит API. Текущее состояние обслуживания сбросится после перезапуска. Доступ защищён входом администратора.</small>
</main>
<script>
const statusBox=document.getElementById('status');
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
refresh();
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

  if (url.pathname === "/admin/maintenance" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    return handleMaintenancePost(req, res);
  }

  if (url.pathname === "/admin/restart" && req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    res.writeHead(202, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
    res.end(JSON.stringify({ok:true,message:"Restart requested"}));
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
    return handleMaintenancePost(req, res);
  }

  return sendJson(res, 404, { error: "Not found" });
});

function handleMaintenancePost(req, res) {
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

    maintenance = {
      active: data.active,
      message: typeof data.message === "string" && data.message.trim()
        ? data.message.trim().slice(0, 500)
        : maintenance.message
    };
    broadcast();
    return sendJson(res, 200, { ok: true, ...maintenance });
  });
}

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CASE Online maintenance API listening on port ${PORT}`);
  if (!TOKEN) console.warn("MAINTENANCE_TOKEN is not set; maintenance changes are disabled.");
});
