const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const storage = require("./storage");

const PORT = process.env.PORT || 3000;
const CHANNELS = 40;
const CAP = 4;
const LOG_MAX = 300;

// Add a region here and it gets its own URL, its own board, its own chat.
// Flip `enabled` to true when you're ready to open it up.
const REGIONS = [
  { id: "B1",   enabled: false },
  { id: "B2Z1", enabled: false },
  { id: "RD1",  enabled: true  },
  { id: "RD4",  enabled: false },
  { id: "RD6",  enabled: false },
  { id: "RD7",  enabled: false }
];
const live = REGIONS.filter(r => r.enabled).map(r => r.id);
const byId = id => REGIONS.find(r => r.id === id);

/* ---------------- state ---------------- */
const blankRegion = () => ({
  channels: Array.from({ length: CHANNELS }, () => ({ pct: 100, entries: [] })),
  log: []
});

let state = {};

function hydrate(saved) {
  if (saved && typeof saved === "object") state = saved;
  live.forEach(r => { if (!state[r]) state[r] = blankRegion(); });
}

const persist = () => storage.save(state);

const uid = () => Math.random().toString(36).slice(2, 9);
const ch = i => "CH" + String(i + 1).padStart(2, "0");
const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);

function note(region, msg, who) {
  const log = state[region].log;
  log.push({ t: Date.now(), who: who || null, msg });
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

/* ---------------- web ---------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/", (_req, res) => res.redirect("/" + live[0].toLowerCase()));

app.get("/:region", (req, res, next) => {
  const r = byId(req.params.region.toUpperCase());
  if (!r) return next();
  if (!r.enabled) return res.status(404).send(offline(r.id));
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

function offline(id) {
  return `<!doctype html><meta charset="utf-8">
  <title>${id} — not open yet</title>
  <body style="background:#050a10;color:#8ba0b4;font:14px ui-monospace,monospace;display:grid;place-items:center;height:100vh;margin:0">
  <div style="text-align:center">
    <p style="color:#22d3ee;font-size:22px;font-weight:700;margin:0 0 8px">${id}</p>
    <p style="margin:0 0 18px">This region isn't open yet.</p>
    <a href="/${live[0].toLowerCase()}" style="color:#22d3ee">Go to ${live[0]}</a>
  </div></body>`;
}

/* ---------------- realtime ---------------- */
const counts = {};

function broadcast(region) {
  io.to(region).emit("sync", state[region]);
}
function presence(region) {
  io.to(region).emit("presence", counts[region] || 0);
}

io.on("connection", socket => {
  let region = null;

  socket.on("join", raw => {
    const id = clean(raw, 12).toUpperCase();
    const r = byId(id);
    if (!r || !r.enabled) return socket.emit("denied", "Region not available");
    region = id;
    socket.join(region);
    counts[region] = (counts[region] || 0) + 1;
    socket.emit("hello", { region, regions: REGIONS, cap: CAP, channels: CHANNELS });
    socket.emit("sync", state[region]);
    presence(region);
  });

  socket.on("action", a => {
    if (!region || !a || typeof a !== "object") return;
    const board = state[region].channels;
    const by = clean(a.by, 24) || "someone";
    const at = Number(a.ch);
    const target = board[at];

    switch (a.type) {
      case "pct": {
        if (!target) return;
        const v = Math.max(0, Math.min(100, Math.round(Number(a.pct) / 10) * 10));
        if (target.pct === v) return;
        target.pct = v;
        note(region, `${ch(at)} burning set to ${v}%`);
        break;
      }
      case "add": {
        if (!target || target.entries.length >= CAP) return;
        const name = clean(a.name, 24);
        if (!name) return;
        target.entries.push({ id: uid(), name, at: Date.now() });
        note(region, `${name} added to ${ch(at)}`);
        break;
      }
      case "remove": {
        if (!target) return;
        const i = target.entries.findIndex(e => e.id === a.id);
        if (i === -1) return;
        const [gone] = target.entries.splice(i, 1);
        note(region, `${gone.name} removed from ${ch(at)}`);
        break;
      }
      case "rename": {
        if (!target) return;
        const e = target.entries.find(x => x.id === a.id);
        const name = clean(a.name, 24);
        if (!e || !name || name === e.name) return;
        note(region, `${e.name} renamed to ${name} in ${ch(at)}`);
        e.name = name;
        break;
      }
      case "timer": {
        if (!target) return;
        const e = target.entries.find(x => x.id === a.id);
        if (!e) return;
        e.at = Date.now();
        note(region, `${e.name} timer reset in ${ch(at)}`);
        break;
      }
      case "moveUser": {
        const from = board[Number(a.from)], to = board[Number(a.to)];
        if (!from || !to || from === to || to.entries.length >= CAP) return;
        const i = from.entries.findIndex(e => e.id === a.id);
        if (i === -1) return;
        const [moved] = from.entries.splice(i, 1);
        to.entries.push(moved);
        note(region, `${ch(Number(a.from))} → ${ch(Number(a.to))}: ${moved.name} moved`);
        break;
      }
      case "moveGroup": {
        const from = board[Number(a.from)], to = board[Number(a.to)];
        if (!from || !to || from === to || !from.entries.length) return;
        if (!to.entries.length) {
          note(region, `${ch(Number(a.from))} → ${ch(Number(a.to))}: ${from.entries.map(e => e.name).join(", ")} moved`);
          to.entries = from.entries;
          from.entries = [];
        } else {
          note(region, `${ch(Number(a.from))} ⇄ ${ch(Number(a.to))} swapped`);
          const tmp = to.entries; to.entries = from.entries; from.entries = tmp;
        }
        break;
      }
      case "clear": {
        board.forEach(c => (c.entries = []));
        note(region, `board cleared by ${by}`);
        break;
      }
      default:
        return;
    }
    persist();
    broadcast(region);
  });

  socket.on("chat", m => {
    if (!region || !m) return;
    const who = clean(m.who, 24) || "Guest";
    const text = clean(m.text, 200);
    if (!text) return;
    note(region, text, who);
    persist();
    broadcast(region);
  });

  socket.on("disconnect", () => {
    if (!region) return;
    counts[region] = Math.max(0, (counts[region] || 1) - 1);
    presence(region);
  });
});

async function main() {
  await storage.init();
  hydrate(await storage.load());
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Channel tracker on :${PORT} — open /${live[0].toLowerCase()}`);
  });
}

main().catch(err => {
  console.error("startup failed:", err);
  process.exit(1);
});
