const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const storage = require("./storage");

const PORT = process.env.PORT || 3000;
const CHANNELS = 40;
const CAP = 4;
const LOG_MAX = 300;
const MVP_TIMER_MS = (29 * 60 + 30) * 1000;   // 29:30

// Add a region here and it gets its own URL, its own board, its own chat.
// Flip `enabled` to true when you're ready to open it up.
const REGIONS = [
  { id: "B1",   area: "B1",  enabled: true },
  { id: "RD1",  area: "RD",  enabled: true },
  { id: "RD2",  area: "RD",  enabled: true },
  { id: "RD3",  area: "RD",  enabled: true },
  { id: "RD4",  area: "RD",  enabled: true },
  { id: "GOB1", area: "GOB", enabled: true },
  { id: "GOB5", area: "GOB", enabled: true },
  { id: "GOB7", area: "GOB", enabled: true },
  { id: "GOB8", area: "GOB", enabled: true }
];
const AREAS = [...new Set(REGIONS.filter(r => r.enabled).map(r => r.area))];
const areaOf = id => (byId(id) || {}).area;
const regionsIn = area => live.filter(r => areaOf(r) === area);
const live = REGIONS.filter(r => r.enabled).map(r => r.id);

// fingerprint of the client file, so open browsers can tell when a deploy has landed
let BUILD = "dev";
try {
  const page = fs.readFileSync(path.join(__dirname, "public", "index.html"));
  BUILD = crypto.createHash("sha1").update(page).digest("hex").slice(0, 12);
} catch (e) {
  BUILD = String(Date.now());
}
const byId = id => REGIONS.find(r => r.id === id);

/* ---------------- state ---------------- */
const blankRegion = () => ({
  channels: Array.from({ length: CHANNELS }, () => ({ pct: 100, pctAt: null, emptiedAt: null, entries: [] })),
  log: []
});

let state = {};

function hydrate(saved) {
  if (saved && typeof saved === "object") state = saved;
  live.forEach(r => { if (!state[r]) state[r] = blankRegion(); });

  // chat and the people list are shared across every region
  if (!Array.isArray(state.chat)) state.chat = [];
  // one people list per area (RD boards share one, GOB boards share another)
  if (!state.rosters || typeof state.rosters !== "object") state.rosters = {};
  AREAS.forEach(a => { if (!Array.isArray(state.rosters[a])) state.rosters[a] = []; });
  if (Array.isArray(state.roster) && state.roster.length) {   // carry over the old global list
    state.rosters[AREAS[0]] = state.rosters[AREAS[0]].concat(state.roster);
    delete state.roster;
  }
  // pull any chat lines out of the old per-region logs, once
  live.forEach(r => {
    const keep = [];
    state[r].log.forEach(entry => {
      if (entry && entry.who) state.chat.push(entry); else keep.push(entry);
    });
    state[r].log = keep;
  });
  if (!state.notice || typeof state.notice !== "object") state.notice = { text: "", by: "", at: 0 };
  if (typeof state.mvpMsg !== "string") state.mvpMsg = "";
  // shared music queue. whatever was mid-song when the server stopped is dropped,
  // but the queue itself survives
  if (!state.music || typeof state.music !== "object") state.music = { queue: [], playing: null };
  if (!Array.isArray(state.music.queue)) state.music.queue = [];
  state.music.playing = null;
  if (!state.mvpTimer || typeof state.mvpTimer !== "object") state.mvpTimer = null;
  state.chat.sort((a, b) => a.t - b.t);
  if (state.chat.length > LOG_MAX) state.chat.splice(0, state.chat.length - LOG_MAX);
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

app.get("/version", (_req, res) => res.json({ build: BUILD }));

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
let online = 0;   // everyone connected, whichever region they're looking at

function snapshot(region) {
  return { region, channels: state[region].channels, log: state[region].log };
}
function broadcast(region) {
  io.to(region).emit("sync", snapshot(region));
}
function broadcastChat() {
  io.emit("chatlog", state.chat);
}
let mvpTimerHandle = null;

function fireMvpCall(by) {
  io.emit("mvp", { by, t: Date.now(), msg: state.mvpMsg });
}

function scheduleMvpTimer() {
  clearTimeout(mvpTimerHandle);
  mvpTimerHandle = null;
  if (!state.mvpTimer || !state.mvpTimer.endsAt) return;
  const left = state.mvpTimer.endsAt - Date.now();
  if (left <= 0) {                       // missed it while the server was down
    state.mvpTimer = null;
    persist();
    io.emit("mvptimer", null);
    return;
  }
  const by = state.mvpTimer.by || "timer";
  mvpTimerHandle = setTimeout(() => {
    state.mvpTimer = null;
    persist();
    io.emit("mvptimer", null);
    fireMvpCall(by);
    live.forEach(r => note(r, `MVP timer finished (started by ${by})`));
    live.forEach(broadcast);
  }, left);
}

/* ---------------- music ---------------- */
function videoIdFrom(raw) {
  const v = String(raw || "").trim();
  if (/^[\w-]{11}$/.test(v)) return v;                       // already an id
  const patterns = [
    /youtu\.be\/([\w-]{11})/,
    /[?&]v=([\w-]{11})/,
    /\/shorts\/([\w-]{11})/,
    /\/embed\/([\w-]{11})/,
    /\/live\/([\w-]{11})/
  ];
  for (const re of patterns) {
    const m = v.match(re);
    if (m) return m[1];
  }
  return null;
}

function musicView() {
  return {
    queue: state.music.queue.map(t => ({
      id: t.id, videoId: t.videoId, title: t.title, by: t.by, token: t.token
    })),
    playing: state.music.playing
  };
}
function broadcastMusic() {
  io.emit("music", musicView());
}
function startNext() {
  const next = state.music.queue.shift();
  state.music.playing = next
    ? { id: next.id, videoId: next.videoId, title: next.title, by: next.by, token: next.token, startedAt: Date.now() }
    : null;
}

function broadcastNotice() {
  io.emit("notice", state.notice);
}
function broadcastRoster() {
  io.emit("roster", state.rosters);
}
function findPerson(id, area) {
  return (state.rosters[area] || []).find(p => p.id === id);
}
// pull someone off whatever channel they're on, within their own area
function liftPerson(pid, area) {
  let from = null;
  regionsIn(area).forEach(r => {
    state[r].channels.forEach((c, idx) => {
      const i = c.entries.findIndex(e => e.pid === pid);
      if (i !== -1) { c.entries.splice(i, 1); from = { region: r, idx }; }
    });
  });
  return from;
}
function presence() {
  io.emit("presence", { n: online });
}

io.on("connection", socket => {
  let viewing = null;   // the tab they're looking at right now

  socket.on("join", raw => {
    const id = clean(raw, 12).toUpperCase();
    const r = byId(id);
    if (!r || !r.enabled) return socket.emit("denied", "Region not available");

    // subscribe to all of them, so switching tabs needs no round trip
    live.forEach(x => socket.join(x));
    if (!viewing) online++;          // count the person once, not once per tab switch
    viewing = id;

    socket.emit("hello", { region: id, regions: REGIONS, cap: CAP, channels: CHANNELS, build: BUILD });
    live.forEach(x => socket.emit("sync", snapshot(x)));
    socket.emit("chatlog", state.chat);
    socket.emit("roster", state.rosters);
    socket.emit("notice", state.notice);
    socket.emit("mvpmsg", state.mvpMsg);
    socket.emit("mvptimer", state.mvpTimer);
    socket.emit("music", musicView());
    presence();
  });

  // just changing tabs — no reload, only the watcher count moves
  socket.on("view", raw => {
    const id = clean(raw, 12).toUpperCase();
    const r = byId(id);
    if (!r || !r.enabled || id === viewing) return;
    viewing = id;                    // switching tabs doesn't change the head count
  });

  socket.on("action", a => {
    if (!a || typeof a !== "object") return;
    const region = (clean(a.region, 12).toUpperCase() || viewing);
    const r = byId(region);
    if (!r || !r.enabled) return;
    const board = state[region].channels;
    const before = board.map(c => c.entries.length);
    const by = clean(a.by, 24) || "someone";
    const at = Number(a.ch);
    const target = board[at];

    switch (a.type) {
      case "pct": {
        if (!target) return;
        const v = Math.max(0, Math.min(100, Math.round(Number(a.pct) / 10) * 10));
        // picking the same number again is a fresh confirmation:
        // the reading still stands, so the projection clock restarts from now
        const same = target.pct === v;
        target.pct = v;
        target.pctAt = Date.now();
        note(region, same
          ? `${ch(at)} still ${v}% — confirmed by ${by}`
          : `${ch(at)} burning set to ${v}% by ${by}`);
        break;
      }
      case "add": {
        if (!target) return;
        const name = clean(a.name, 24);
        if (!name) return;
        const key = name.toLowerCase();

        // already on this channel? just restart their timer
        const here = target.entries.find(e => e.name.toLowerCase() === key);
        if (here) {
          here.at = Date.now();
          note(region, `${here.name} timer reset in ${ch(at)} by ${by}`);
          break;
        }
        if (target.entries.length >= CAP) return;

        // one person, one channel — pull them off wherever else they were
        let cameFrom = null;
        board.forEach((c, idx) => {
          const i = c.entries.findIndex(e => e.name.toLowerCase() === key);
          if (i !== -1) { c.entries.splice(i, 1); cameFrom = idx; }
        });

        target.entries.push({ id: uid(), name, at: Date.now() });
        note(region, cameFrom === null
          ? `${name} added to ${ch(at)} by ${by}`
          : `${name} moved ${ch(cameFrom)} → ${ch(at)} by ${by}`);
        break;
      }
      case "remove": {
        if (!target) return;
        const i = target.entries.findIndex(e => e.id === a.id);
        if (i === -1) return;
        const [gone] = target.entries.splice(i, 1);
        note(region, `${gone.name} removed from ${ch(at)} by ${by}`);
        break;
      }
      case "rename": {
        if (!target) return;
        const e = target.entries.find(x => x.id === a.id);
        const name = clean(a.name, 24);
        if (!e || !name || name === e.name) return;
        note(region, `${e.name} renamed to ${name} in ${ch(at)} by ${by}`);
        e.name = name;
        break;
      }
      case "timer": {
        if (!target) return;
        const e = target.entries.find(x => x.id === a.id);
        if (!e) return;
        e.at = Date.now();
        note(region, `${e.name} timer reset in ${ch(at)} by ${by}`);
        break;
      }
      case "moveUser": {
        const from = board[Number(a.from)], to = board[Number(a.to)];
        if (!from || !to || from === to || to.entries.length >= CAP) return;
        const i = from.entries.findIndex(e => e.id === a.id);
        if (i === -1) return;
        const [moved] = from.entries.splice(i, 1);
        moved.at = Date.now();
        to.entries.push(moved);
        note(region, `${moved.name} moved ${ch(Number(a.from))} → ${ch(Number(a.to))} by ${by}`);
        break;
      }
      case "moveGroup": {
        const from = board[Number(a.from)], to = board[Number(a.to)];
        if (!from || !to || from === to || !from.entries.length) return;
        const A = ch(Number(a.from)), B = ch(Number(a.to));
        const now = Date.now();
        const room = CAP - to.entries.length;

        // no room at all — fall back to swapping the two channels
        if (room <= 0) {
          note(region, `${A} ⇄ ${B} swapped by ${by}`);
          from.entries.concat(to.entries).forEach(e => { e.at = now; });
          const tmp = to.entries; to.entries = from.entries; from.entries = tmp;
          break;
        }

        // otherwise merge in as many as will fit
        const moving = from.entries.splice(0, Math.min(room, from.entries.length));
        moving.forEach(e => { e.at = now; });
        to.entries = to.entries.concat(moving);
        const left = from.entries.length;
        note(region, `${moving.map(e => e.name).join(", ")} moved ${A} → ${B} by ${by}`
          + (left ? ` — ${left} stayed on ${A}, ${B} is full` : ""));
        break;
      }
      case "duration": {
        if (!target || !target.entries.length) return;
        const mins = Math.max(0, Math.min(180, Math.round(Number(a.minutes))));
        if (!isFinite(mins)) return;
        const base = Date.now() - mins * 60000;
        target.entries.forEach(e => { e.at = base; });     // one clock for the whole channel
        note(region, `${ch(at)} set to ${mins}m by ${by}`);
        break;
      }
      case "person-color": {
        const area = areaOf(region);
        const p = findPerson(a.id, area);
        const col = clean(a.color, 12);
        if (!p || !/^#[0-9a-fA-F]{6}$/.test(col)) return;
        p.color = col;
        persist();
        broadcastRoster();
        return;
      }
      case "claim": {
        const area = areaOf(region);
        const p = findPerson(a.pid, area);
        const token = clean(a.token, 64);
        if (!p || !token) return;
        if (p.claimedBy && p.claimedBy !== token) return;   // already someone else's
        p.claimedBy = token;
        p.claimedName = clean(a.who, 24) || "someone";
        persist();
        broadcastRoster();
        return;
      }
      case "unclaim": {
        const area = areaOf(region);
        const p = findPerson(a.pid, area);
        const token = clean(a.token, 64);
        if (!p || !token || p.claimedBy !== token) return;   // only the owner can let go
        p.claimedBy = null;
        p.claimedName = null;
        persist();
        broadcastRoster();
        return;
      }
      case "music-add": {
        const videoId = videoIdFrom(a.url);
        const token = clean(a.token, 64);
        if (!videoId || !token) return;
        if (state.music.queue.length >= 100) return;
        const item = { id: uid(), videoId, title: "", by, token, at: Date.now() };
        state.music.queue.push(item);
        if (!state.music.playing) startNext();
        note(region, `queued a song`, null);
        persist();
        broadcastMusic();
        broadcast(region);
        return;
      }
      case "music-remove": {
        const token = clean(a.token, 64);
        if (!token) return;
        const cur = state.music.playing;
        if (cur && cur.id === a.id) {
          if (cur.token !== token) return;      // only whoever queued it
          startNext();
        } else {
          const i = state.music.queue.findIndex(t => t.id === a.id);
          if (i === -1) return;
          if (state.music.queue[i].token !== token) return;
          state.music.queue.splice(i, 1);
        }
        persist();
        broadcastMusic();
        return;
      }
      case "music-title": {
        const title = clean(a.title, 120);
        if (!title) return;
        if (state.music.playing && state.music.playing.id === a.id) state.music.playing.title = title;
        const q = state.music.queue.find(t => t.id === a.id);
        if (q) q.title = title;
        persist();
        broadcastMusic();
        return;
      }
      case "music-ended": {
        // whichever listener finishes first moves it along; the rest are ignored
        if (!state.music.playing || state.music.playing.id !== a.id) return;
        startNext();
        persist();
        broadcastMusic();
        return;
      }
      case "mvptimer": {
        if (a.stop) {
          state.mvpTimer = null;
          note(region, `MVP timer stopped by ${by}`);
        } else {
          state.mvpTimer = { endsAt: Date.now() + MVP_TIMER_MS, by };
          note(region, `MVP timer started by ${by}`);
        }
        persist();
        scheduleMvpTimer();
        io.emit("mvptimer", state.mvpTimer);
        broadcast(region);
        return;
      }
      case "mvpmsg": {
        state.mvpMsg = clean(a.text, 140);
        note(region, state.mvpMsg
          ? `MVP alert message set by ${by}`
          : `MVP alert message reset by ${by}`);
        persist();
        io.emit("mvpmsg", state.mvpMsg);
        broadcast(region);
        return;
      }
      case "notice": {
        const text = clean(a.text, 240);
        state.notice = text
          ? { text, by, at: Date.now() }
          : { text: "", by: "", at: 0 };
        note(region, text ? `announcement posted by ${by}` : `announcement cleared by ${by}`);
        persist();
        broadcastNotice();
        broadcast(region);
        return;
      }
      case "person-add": {
        const area = areaOf(region);
        const list = state.rosters[area];
        const name = clean(a.name, 24);
        if (!list || !name) return;
        if (name.toLowerCase() === "guest") return;   // guests stay guests
        if (list.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
        if (list.length >= 200) return;
        list.push({ id: uid(), name, color: null, claimedBy: null, claimedName: null });
        list.sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
        persist();
        broadcastRoster();
        return;
      }
      case "person-rename": {
        const area = areaOf(region);
        const p = findPerson(a.id, area);
        const name = clean(a.name, 24);
        if (!p || !name || name === p.name) return;
        p.name = name;
        regionsIn(area).forEach(r => state[r].channels.forEach(c =>
          c.entries.forEach(e => { if (e.pid === p.id) e.name = name; })));
        state.rosters[area].sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
        persist();
        broadcastRoster();
        regionsIn(area).forEach(broadcast);
        return;
      }
      case "person-remove": {
        const area = areaOf(region);
        const p = findPerson(a.id, area);
        if (!p) return;
        // a claimed name can only be deleted by whoever claimed it
        if (p.claimedBy && p.claimedBy !== clean(a.token, 64)) return;
        liftPerson(p.id, area);
        state.rosters[area] = state.rosters[area].filter(x => x.id !== p.id);
        persist();
        broadcastRoster();
        regionsIn(area).forEach(broadcast);
        return;
      }
      case "assign": {
        const area = areaOf(region);
        const p = findPerson(a.pid, area);
        if (!p || !target) return;
        const already = target.entries.find(e => e.pid === p.id);
        if (already) { already.at = Date.now(); note(region, `${p.name} timer reset in ${ch(at)} by ${by}`); break; }
        if (target.entries.length >= CAP) return;
        const from = liftPerson(p.id, area);
        target.entries.push({ id: uid(), pid: p.id, name: p.name, at: Date.now() });
        if (from && from.region === region) {
          note(region, `${p.name} moved ${ch(from.idx)} → ${ch(at)} by ${by}`);
        } else if (from) {
          note(from.region, `${p.name} left ${ch(from.idx)} by ${by}`);
          note(region, `${p.name} added to ${ch(at)} by ${by} — was on ${from.region}`);
          broadcast(from.region);
        } else {
          note(region, `${p.name} added to ${ch(at)} by ${by}`);
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
    // a channel only decays once it has been farmed and then abandoned
    board.forEach((c, i) => {
      const now = c.entries.length;
      if (before[i] > 0 && now === 0) c.emptiedAt = Date.now();
      else if (now > 0) c.emptiedAt = null;
    });

    persist();
    broadcast(region);
  });

  // "MVP is up" — one shout that reaches anyone currently on a channel, any board
  let lastMvp = 0;
  socket.on("mvp", m => {
    if (!viewing) return;
    const now = Date.now();
    if (now - lastMvp < 5000) return;              // no spamming the button
    lastMvp = now;
    const by = clean(m && m.by, 24) || "someone";
    note(viewing, `MVP called by ${by}`);
    persist();
    broadcast(viewing);
    io.emit("mvp", { by, t: now, msg: state.mvpMsg });
  });

  socket.on("chat", m => {
    if (!m || !viewing) return;
    const who = clean(m.who, 24) || "Guest";
    const text = clean(m.text, 200);
    if (!text) return;
    state.chat.push({ t: Date.now(), who, msg: text });
    if (state.chat.length > LOG_MAX) state.chat.splice(0, state.chat.length - LOG_MAX);
    persist();
    broadcastChat();
  });

  socket.on("disconnect", () => {
    if (!viewing) return;
    online = Math.max(0, online - 1);
    presence();
  });
});

async function main() {
  await storage.init();
  hydrate(await storage.load());
  scheduleMvpTimer();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Channel tracker on :${PORT} — open /${live[0].toLowerCase()}`);
  });
}

main().catch(err => {
  console.error("startup failed:", err);
  process.exit(1);
});
