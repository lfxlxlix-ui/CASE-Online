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

function authorized(req) {
  if (!TOKEN || typeof req.headers["x-maintenance-token"] !== "string") return false;
  const supplied = Buffer.from(req.headers["x-maintenance-token"]);
  const expected = Buffer.from(TOKEN);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function broadcast() {
  const frame = `data: ${JSON.stringify(maintenance)}\n\n`;
  for (const client of clients) {
    try { client.write(frame); } catch { clients.delete(client); }
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-maintenance-token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

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

    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 10000) {
        res.writeHead(413);
        res.end();
        req.destroy();
      }
    });

    req.on("end", () => {
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
    return;
  }

  return sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`CASE Online maintenance API listening on port ${PORT}`);
  if (!TOKEN) console.warn("MAINTENANCE_TOKEN is not set; POST changes are disabled.");
});
