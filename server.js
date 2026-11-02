const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("node:crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = Number(process.env.PORT) || 3000;
const rooms = new Map();
const socketRooms = new Map();

app.use(express.static(__dirname));
app.get("/health", (_req, res) => res.json({ ok: true, service: "case-online", rooms: rooms.size }));

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}
function publicRoom(room) {
  return {
    code: room.code,
    status: room.status,
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, ready: p.ready, x: p.x, y: p.y
    }))
  };
}
function leaveRoom(socket) {
  const code = socketRooms.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRooms.delete(socket.id);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(code);
  if (room.players.size === 0) {
    rooms.delete(code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  io.to(code).emit("room:update", publicRoom(room));
  io.to(code).emit("game:notice", "Игрок покинул комнату.");
}

io.on("connection", socket => {
  socket.emit("server:hello", { online: true, version: "0.2.0" });

  socket.on("room:create", (payload = {}, callback = () => {}) => {
    leaveRoom(socket);
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = {
      code, hostId: socket.id, status: "lobby", maxPlayers: 6,
      players: new Map()
    };
    const name = String(payload.name || "Игрок").trim().slice(0, 18) || "Игрок";
    room.players.set(socket.id, { id: socket.id, name, ready: false, x: 150, y: 150 });
    rooms.set(code, room);
    socketRooms.set(socket.id, code);
    socket.join(code);
    callback({ ok: true, room: publicRoom(room), host: true });
    io.to(code).emit("room:update", publicRoom(room));
  });

  socket.on("room:join", (payload = {}, callback = () => {}) => {
    const code = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    const room = rooms.get(code);
    if (!room) return callback({ ok: false, error: "Комната не найдена. Проверь код." });
    if (room.status !== "lobby") return callback({ ok: false, error: "Матч уже начался." });
    if (room.players.size >= room.maxPlayers) return callback({ ok: false, error: "Комната заполнена." });
    leaveRoom(socket);
    const name = String(payload.name || "Игрок").trim().slice(0, 18) || "Игрок";
    room.players.set(socket.id, { id: socket.id, name, ready: false, x: 180, y: 150 });
    socketRooms.set(socket.id, code);
    socket.join(code);
    callback({ ok: true, room: publicRoom(room), host: room.hostId === socket.id });
    io.to(code).emit("room:update", publicRoom(room));
    io.to(code).emit("game:notice", name + " подключился.");
  });

  socket.on("player:ready", (value, callback = () => {}) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || room.status !== "lobby") return callback({ ok: false });
    const player = room.players.get(socket.id);
    if (player) player.ready = Boolean(value);
    io.to(room.code).emit("room:update", publicRoom(room));
    callback({ ok: true });
  });

  socket.on("game:start", (callback = () => {}) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room) return callback({ ok: false, error: "Сначала войди в комнату." });
    if (room.hostId !== socket.id) return callback({ ok: false, error: "Начать матч может создатель комнаты." });
    if (room.players.size < 1) return callback({ ok: false, error: "Нет игроков." });
    room.status = "playing";
    room.startedAt = Date.now();
    for (const p of room.players.values()) { p.x = 150; p.y = 150; }
    io.to(room.code).emit("game:started", publicRoom(room));
    io.to(room.code).emit("room:update", publicRoom(room));
    callback({ ok: true });
  });

  socket.on("player:move", (payload = {}) => {
    const room = rooms.get(socketRooms.get(socket.id));
    if (!room || room.status !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    const x = Number(payload.x), y = Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // Basic bounds and speed sanity check; the full collision map will be server-authoritative later.
    const nx = Math.max(20, Math.min(940, x));
    const ny = Math.max(20, Math.min(520, y));
    if (Math.hypot(nx - player.x, ny - player.y) > 65) return;
    player.x = nx; player.y = ny;
    socket.to(room.code).emit("player:moved", { id: socket.id, x: player.x, y: player.y });
  });

  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("CASE: Online server listening on port " + PORT);
});