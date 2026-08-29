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
const MUSIC_LOG_MAX = 120;      // the music log is shown on every board, so keep it short
const MVP_TIMER_MS = (29 * 60 + 30) * 1000;   // 29:30

// Add a region here and it gets its own URL, its own board, its own chat.
// Flip `enabled` to true when you're ready to open it up.
const REGIONS = [
  { id: "B1",   area: "B1",  enabled: true },
  { id: "RD1",  area: "RD",  enabled: true },
  { id: "RD4",  area: "RD",  enabled: true },
  { id: "RD6",  area: "RD",  enabled: true },
  { id: "RD7",  area: "RD",  enabled: true },
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
  channels: Array.from({ length: CHANNELS }, () => ({ pct: 100, pctAt: null, emptiedAt: null, occupiedAt: null, pendingAt: null, entries: [] })),
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
  // whatever was playing carries on across a restart, picked up from where it got to
  const cur = state.music.playing;
  if (cur && (typeof cur.startedAt !== "number" || !cur.videoId)) state.music.playing = null;
  if (!state.mvpTimer || typeof state.mvpTimer !== "object") state.mvpTimer = null;

  // Music is the one thing that happens everywhere at once, so its log is
  // global: it shows in the activity pane of every board, whichever board the
  // action was sent from. It used to sit in the chat — move those across, once.
  /* Bans, and a short record of who has been on the site.
     The record is only what the server already sees on every request — a
     browser id, the name they chose, the address they came from — kept so
     there is something to point at when deciding whether to ban. */
  if (!state.bans || typeof state.bans !== "object") state.bans = {};
  if (!state.bans.ids || typeof state.bans.ids !== "object") state.bans.ids = {};
  if (!state.bans.ips || typeof state.bans.ips !== "object") state.bans.ips = {};
  if (!state.seen || typeof state.seen !== "object") state.seen = {};

  if (!Array.isArray(state.musicLog)) state.musicLog = [];
  const keepChat = [];
  state.chat.forEach(e => {
    if (e && e.sys === "music") state.musicLog.push(e); else keepChat.push(e);
  });
  state.chat = keepChat;
  state.musicLog.sort((a, b) => a.t - b.t);
  if (state.musicLog.length > MUSIC_LOG_MAX) {
    state.musicLog.splice(0, state.musicLog.length - MUSIC_LOG_MAX);
  }

  // How burning is projected. These are game rules, not preferences, so they
  // live on the server and everyone reads the same numbers — otherwise two
  // people looking at the same channel would see different predictions.
  const dp = { gain: 10, curfewStart: 22, curfewEnd: 8, drop: 10, dropEvery: 15 };
  if (!state.proj || typeof state.proj !== "object") state.proj = {};
  const whole = (v, d, lo, hi) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  state.proj = {
    gain:        whole(state.proj.gain,        dp.gain,        1, 50),
    // burning falls this much every this many minutes while people are on it
    drop:        whole(state.proj.drop,        dp.drop,        1, 50),
    dropEvery:   whole(state.proj.dropEvery,   dp.dropEvery,   1, 240),
    curfewStart: whole(state.proj.curfewStart, dp.curfewStart, 0, 23),
    curfewEnd:   whole(state.proj.curfewEnd,   dp.curfewEnd,   0, 23),
    // write the projection in as the real reading when someone arrives
    settle:      state.proj.settle !== false
  };

  // A channel needs to know when its current sitting began, to count the drops.
  // Boards saved before this existed have no such field, so take the earliest
  // person on the channel as the start rather than pretending it just began.
  REGIONS.forEach(r => {
    const b = state[r.id] && state[r.id].channels;
    if (!b) return;
    b.forEach(c => {
      if (typeof c.pendingAt !== "number") c.pendingAt = null;
      if (!c.entries.length) { c.occupiedAt = null; return; }
      c.pendingAt = null;
      if (typeof c.occupiedAt !== "number" || !c.occupiedAt) {
        c.occupiedAt = Math.min.apply(null, c.entries.map(e => e.at || Date.now()));
      }
    });
  });

  state.chat.sort((a, b) => a.t - b.t);
  if (state.chat.length > LOG_MAX) state.chat.splice(0, state.chat.length - LOG_MAX);
}

const persist = () => storage.save(state);

const uid = () => Math.random().toString(36).slice(2, 9);
const ch = i => "CH" + String(i + 1).padStart(2, "0");

/* Somebody landing on a channel that is already going joins its clock rather
   than starting their own. The channel has been up thirty-five minutes, so a
   latecomer is thirty-five minutes in as well — the forty minute mark belongs
   to the channel, not to whoever happened to walk in last. The oldest entry is
   the one to match, since that is the channel's real age. */
function joinClock(chan) {
  if (!chan || !chan.entries.length) return Date.now();
  const ats = chan.entries.map(e => e.at).filter(v => typeof v === "number");
  return ats.length ? Math.min.apply(null, ats) : Date.now();
}
const clean = (s, n) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
// "Guest" is the placeholder a new browser starts on. The client will not let
// you act under it, and this is the other half of that: a tab left open from
// before, or anything talking to the socket directly, gets the same answer.
const nameless = n => {
  const t = String(n || "").trim().toLowerCase();
  return !t || t === "guest" || t === "someone";
};

function note(region, msg, who) {
  const log = state[region].log;
  log.push({ t: Date.now(), who: who || null, msg });
  if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
}

/* ---------------- web ---------------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Render sits behind a proxy, so without this every visitor looks like the
// proxy's own address rather than their own
app.set("trust proxy", true);

/* ---------------- who is who ----------------
   A per-browser id, set as a cookie on the page itself. The browser hands it
   back on every request after that, including the socket handshake, so the
   server can tell one browser from another without the page having to do
   anything — which matters here, because touching public/index.html would
   make every open tab prompt for a reload.
   It is a random string and nothing else. It says nothing about the person. */
const ID_COOKIE = "ct_id";
const YEAR = 365 * 24 * 60 * 60 * 1000;

function readCookies(header) {
  const out = {};
  String(header || "").split(";").forEach(part => {
    const i = part.indexOf("=");
    if (i < 0) return;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
const browserIdOf = req => readCookies(req.headers && req.headers.cookie)[ID_COOKIE] || "";
const ipOf = req => String((req.headers && req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  || (req.socket && req.socket.remoteAddress) || "").replace(/^::ffff:/, "");

app.use(express.static(path.join(__dirname, "public"), { index: false }));

app.get("/version", (_req, res) => res.json({ build: BUILD }));

/* ---------------- the quiet door ----------------
   Set ADMIN_KEY in the environment on Render and the page lives at
   /admin/<that key>. With no key set the route does not exist at all, and a
   wrong key 404s exactly like any other unknown address — there is nothing to
   find by guessing, and nothing anywhere else on the site points at it. */
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();

const esc = t => String(t == null ? "" : t)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const since = t => {
  if (!t) return "—";
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  return h < 24 ? h + "h ago" : Math.floor(h / 24) + "d ago";
};

function adminPage() {
  const seen = Object.values(state.seen).sort((a, b) => (b.last || 0) - (a.last || 0));
  const rows = seen.map(v => `<tr>
      <td>${esc(v.name || "—")}</td>
      <td class="dim">${esc(v.ip || "—")}</td>
      <td class="dim">${esc(since(v.last))}</td>
      <td class="dim">${v.acts || 0}</td>
      <td class="dim mono">${esc(String(v.id).slice(0, 10))}</td>
      <td>
        <a class="btn" href="?ban=${encodeURIComponent(v.id)}">ban browser</a>
        ${v.ip ? `<a class="btn" href="?banip=${encodeURIComponent(v.ip)}">ban address</a>` : ""}
      </td>
    </tr>`).join("");

  const banRows = Object.keys(state.bans.ids).map(id => {
    const b = state.bans.ids[id];
    return `<tr><td>${esc((b && b.name) || "—")}</td><td class="dim mono">${esc(id.slice(0, 10))}</td>
      <td class="dim">browser</td><td class="dim">${esc(since(b && b.at))}</td>
      <td><a class="btn" href="?unban=${encodeURIComponent(id)}">lift</a></td></tr>`;
  }).concat(Object.keys(state.bans.ips).map(ipk => {
    const b = state.bans.ips[ipk];
    return `<tr><td>${esc((b && b.name) || "—")}</td><td class="dim mono">${esc(ipk)}</td>
      <td class="dim">address</td><td class="dim">${esc(since(b && b.at))}</td>
      <td><a class="btn" href="?unbanip=${encodeURIComponent(ipk)}">lift</a></td></tr>`;
  })).join("");

  return `<!doctype html><meta charset="utf-8"><title>·</title>
<meta name="robots" content="noindex,nofollow">
<style>
  body{background:#050a10;color:#e6edf5;font:13px ui-monospace,monospace;margin:0;padding:22px}
  h2{font-size:12px;letter-spacing:.16em;color:#22d3ee;margin:0 0 10px;font-weight:700}
  h2.two{margin-top:26px}
  table{border-collapse:collapse;width:100%;max-width:900px}
  th{text-align:left;font-size:10px;letter-spacing:.1em;color:#5f7285;padding:6px 10px 6px 0;font-weight:600}
  td{padding:7px 10px 7px 0;border-top:1px solid #16202b;vertical-align:middle}
  .dim{color:#8ba0b4}.mono{font-size:11px}
  .btn{display:inline-block;color:#8ba0b4;text-decoration:none;border:1px solid #22303f;
       border-radius:6px;padding:3px 8px;margin-right:5px;font-size:11px}
  .btn:hover{color:#f87171;border-color:#f87171}
  .none{color:#5f7285;padding:10px 0}
</style>
<h2>ON THE SITE LATELY</h2>
${rows ? `<table><tr><th>name</th><th>address</th><th>last seen</th><th>actions</th><th>browser</th><th></th></tr>${rows}</table>`
       : `<p class="none">Nobody yet.</p>`}
<h2 class="two">BANNED</h2>
${banRows ? `<table><tr><th>name</th><th>what</th><th>kind</th><th>when</th><th></th></tr>${banRows}</table>`
          : `<p class="none">Nobody.</p>`}`;
}

if (ADMIN_KEY) {
  app.get("/admin/:key", (req, res, next) => {
    if (req.params.key !== ADMIN_KEY) return next();      // 404, like any bad address
    const q = req.query || {};
    let changed = false;

    if (q.ban) {
      const v = state.seen[q.ban] || {};
      state.bans.ids[q.ban] = { at: Date.now(), name: v.name || "", ip: v.ip || "" };
      changed = true;
    }
    if (q.banip) {
      const owner = Object.values(state.seen).find(v => v.ip === q.banip);
      state.bans.ips[q.banip] = { at: Date.now(), name: (owner && owner.name) || "" };
      changed = true;
    }
    if (q.unban)   { delete state.bans.ids[q.unban];   changed = true; }
    if (q.unbanip) { delete state.bans.ips[q.unbanip]; changed = true; }

    if (changed) {
      persist();
      dropBanned();
      // strip the query so a refresh does not repeat it
      return res.redirect("/admin/" + encodeURIComponent(ADMIN_KEY));
    }
    res.set("Cache-Control", "no-store").send(adminPage());
  });
}

app.get("/", (_req, res) => res.redirect("/" + live[0].toLowerCase()));

app.get("/:region", (req, res, next) => {
  const r = byId(req.params.region.toUpperCase());
  if (!r) return next();
  if (!r.enabled) return res.status(404).send(offline(r.id));
  // hand this browser an id if it does not have one yet
  if (!browserIdOf(req)) {
    res.cookie
      ? res.cookie(ID_COOKIE, uid() + uid(), { maxAge: YEAR, sameSite: "Lax", httpOnly: true })
      : res.setHeader("Set-Cookie",
          ID_COOKIE + "=" + uid() + uid() + "; Max-Age=" + Math.floor(YEAR / 1000)
          + "; Path=/; SameSite=Lax; HttpOnly");
  }
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

/* ---------------- bans ----------------
   Two things get banned: the browser id from the cookie, and the address.
   The id survives a new address; the address catches a fresh browser on the
   same machine. Neither is watertight on its own — clearing cookies beats the
   first, a phone hotspot beats the second — so both are checked.
   Nothing about this is visible from the outside. A banned browser simply
   fails to connect, the same as the site being down. */
const SEEN_MAX = 400;

function isBanned(id, ip) {
  if (id && state.bans.ids[id]) return true;
  if (ip && state.bans.ips[ip]) return true;
  return false;
}

function noteSeen(id, ip, name) {
  if (!id) return;
  const now = Date.now();
  const was = state.seen[id] || { id, first: now, acts: 0 };
  was.last = now;
  if (ip) was.ip = ip;
  if (name && !nameless(name)) was.name = name;
  state.seen[id] = was;
  // keep the newest few hundred, so this cannot grow without limit
  const keys = Object.keys(state.seen);
  if (keys.length > SEEN_MAX) {
    keys.sort((a, b) => (state.seen[a].last || 0) - (state.seen[b].last || 0))
        .slice(0, keys.length - SEEN_MAX)
        .forEach(k => delete state.seen[k]);
  }
}

// throw off anyone already connected who has just been banned
function dropBanned() {
  io.sockets.sockets.forEach(sock => {
    const c = readCookies(sock.handshake.headers.cookie);
    const ip = String((sock.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim()
      || sock.handshake.address || "").replace(/^::ffff:/, "");
    if (isBanned(c[ID_COOKIE], ip)) sock.disconnect(true);
  });
}

/* ---------------- realtime ---------------- */
let online = 0;      // everyone connected, whichever region they're looking at
// who has the music playing, by socket, so the drawer can name them and not
// just count them. a Map keyed on socket id keeps a refresh or a second tab
// from leaving a ghost behind — the entry goes when that socket does.
const listeners = new Map();   // socket.id -> display name

/* Drop anyone whose socket has gone.
   Normally the disconnect handler clears them, but a browser that dies without
   closing cleanly — a laptop lid, a dropped connection, a tab killed by the OS
   — leaves the old socket behind until the server notices. Meanwhile the same
   person reconnects on a fresh socket id and appears twice. Checking against
   the live socket list on the way out costs nothing and cannot go stale. */
function pruneListeners() {
  let gone = false;
  for (const id of [...listeners.keys()]) {
    if (!io.sockets.sockets.has(id)) { listeners.delete(id); gone = true; }
  }
  return gone;
}

function listenersView() {
  pruneListeners();
  const list = [...listeners.entries()]
    .map(([id, name]) => ({ id, name: name || "someone" }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { n: list.length, who: list.map(x => x.name), list };
}
function broadcastListeners() { io.emit("listeners", listenersView()); }

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
/* ---------------- projected burning ----------------
   The same sums the client draws in the Projected Burns list, done here so the
   server can commit one as a real reading. An empty channel climbs `gain` an
   hour from whichever is more recent — the last confirmed reading, or the
   moment the last person left, which costs `loss` straight away. The clock
   stops during the curfew window.
   -------------------------------------------------------------------------- */

// milliseconds between two times that actually count, curfew removed
function projActiveMs(from, to) {
  if (to <= from) return 0;
  const { curfewStart, curfewEnd } = state.proj;
  if (curfewStart === curfewEnd) return to - from;      // no freeze window set
  let total = 0;
  let cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let guard = 0; guard < 400 && cursor.getTime() < to; guard++) {
    const dayStart = cursor.getTime();
    const a = Math.max(from, dayStart + curfewEnd * 3600000);
    const b = Math.min(to, dayStart + curfewStart * 3600000);
    if (b > a) total += b - a;
    cursor = new Date(dayStart + 86400000);
  }
  return total;
}

/* What the climb has reached, or null if there's nothing to measure from.
   Deliberately does NOT check whether anyone is on the channel: the caller that
   settles a reading runs just after people have arrived, and still needs the
   number the channel had climbed to while it was empty. */
function projectedFor(c) {
  if (!c) return null;
  const left = c.emptiedAt || 0, set = c.pctAt || 0;
  const anchor = Math.max(left, set);
  if (!anchor) return null;
  // A drop was still in flight when the channel cleared. It lands whether or
  // not anyone is standing there, so it is held until its moment rather than
  // taken up front — the board should not read 10 low for those few minutes.
  const pend = (c.pendingAt && Date.now() >= c.pendingAt) ? state.proj.drop : 0;
  // Every drop, including the one that landed after the last person left, is
  // already written into c.pct by the emptying code. Nothing more comes off
  // here, or the same fall would be counted twice.
  const start = c.pct - pend;
  // it steps up on the hour, it doesn't creep — 80% holds at 80% until the tick
  const hours = Math.floor(projActiveMs(anchor, Date.now()) / 3600000);
  return Math.max(0, Math.min(100, start + state.proj.gain * hours));
}

// music happens everywhere at once, so this log is global — every board's
// activity pane shows the same lines, whichever board they were sent from
function broadcastMusicLog() {
  io.emit("musiclog", state.musicLog);
}
function musicNote(msg) {
  state.musicLog.push({ t: Date.now(), sys: "music", msg });
  if (state.musicLog.length > MUSIC_LOG_MAX) {
    state.musicLog.splice(0, state.musicLog.length - MUSIC_LOG_MAX);
  }
  broadcastMusicLog();
}
const mmss = s => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
let lastSeekNote = 0;
let lastSeekAt = 0;
let songHandle = null;

/* A song's clock is started slightly in the future.
   Every browser needs a second or two to fetch and buffer the video, and if the
   clock is already running by the time the player is ready it dutifully seeks
   past the opening — which is why songs used to begin two or three seconds in.
   Starting the clock a moment ahead gives everyone time to be ready, and the
   offset they each compute is negative until then, which clamps to zero. So
   they all begin at the beginning, together, without anyone special-casing
   "this song is new" — which is what made the wallpaper and the main player
   disagree, since they load at different moments. */
const SONG_LEAD = 2500;

function startNext() {
  const next = state.music.queue.shift();
  state.music.playing = next
    ? { id: next.id, videoId: next.videoId, title: next.title, by: next.by,
        token: next.token, startedAt: Date.now() + SONG_LEAD,
        duration: next.duration || 0, paused: false, at: 0 }
    : null;
  scheduleSongEnd();
}

// the server moves the queue along itself once it knows how long a song runs,
// so nothing stalls just because nobody happens to be listening
/* ---------------- the drop that was still coming ----------------
   When a channel empties, one more drop is usually still in flight. Working out
   *when* it lands is not enough on its own: something has to wake up and take
   it off, or the board sits on the old number until somebody happens to open
   the projections list. So each pending drop gets a timer, and applying it is a
   real edit — it changes the stored burning, writes a log line, and goes out to
   everyone, exactly as if a person had set it. */
const dropTimers = new Map();          // "RD1:12" -> timeout handle

function clearDropTimer(region, idx) {
  const k = region + ":" + idx;
  if (dropTimers.has(k)) {
    clearTimeout(dropTimers.get(k));
    dropTimers.delete(k);
  }
}

function applyPendingDrop(region, idx) {
  const board = state[region] && state[region].channels;
  const c = board && board[idx];
  if (!c || !c.pendingAt) return;
  if (c.entries.length) { c.pendingAt = null; return; }   // somebody came back
  if (Date.now() < c.pendingAt) { scheduleDrop(region, idx); return; }

  const landed = c.pendingAt;
  const was = c.pct;
  c.pct = Math.max(0, Math.min(100, was - state.proj.drop));
  // stamped when it actually fell, not when this timer happened to fire, so the
  // climb back up counts from the right moment
  c.pctAt = landed;
  c.emptiedAt = landed;
  c.pendingAt = null;
  if (c.pct !== was) {
    note(region, `${ch(idx)} burning ${was}% → ${c.pct}% — the drop that was still coming`);
  }
  persist();
  broadcast(region);
}

function scheduleDrop(region, idx) {
  clearDropTimer(region, idx);
  const board = state[region] && state[region].channels;
  const c = board && board[idx];
  if (!c || !c.pendingAt || c.entries.length) return;
  const wait = c.pendingAt - Date.now();
  if (wait <= 0) { applyPendingDrop(region, idx); return; }
  const k = region + ":" + idx;
  dropTimers.set(k, setTimeout(() => {
    dropTimers.delete(k);
    applyPendingDrop(region, idx);
  }, wait + 250));
}

// after a restart, pick up every drop that was owed — including any that fell
// while the process was down
function scheduleAllDrops() {
  REGIONS.forEach(r => {
    const b = state[r.id] && state[r.id].channels;
    if (!b) return;
    b.forEach((c, i) => { if (c.pendingAt) scheduleDrop(r.id, i); });
  });
}

function scheduleSongEnd() {
  clearTimeout(songHandle);
  songHandle = null;
  const cur = state.music.playing;
  if (!cur || !cur.duration || cur.paused) return;   // a paused song has no end coming
  const left = cur.startedAt + cur.duration * 1000 + 2000 - Date.now();
  if (left <= 0) {
    startNext();
    persist();
    broadcastMusic();
    return;
  }
  songHandle = setTimeout(() => {
    startNext();
    persist();
    broadcastMusic();
  }, left);
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
// who is on the site at all, by socket, so the counter can name them
const watchers = new Map();          // socket.id -> display name
function presence() {
  const who = [...watchers.values()].filter(Boolean);
  who.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  io.emit("presence", { n: online, who });
}

io.on("connection", socket => {
  const cookies = readCookies(socket.handshake.headers.cookie);
  const browserId = cookies[ID_COOKIE] || "";
  const ip = String((socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || socket.handshake.address || "").replace(/^::ffff:/, "");

  // banned browsers get nothing. no message, no explanation — from their side
  // it is indistinguishable from the site being unreachable.
  if (isBanned(browserId, ip)) { socket.disconnect(true); return; }
  noteSeen(browserId, ip, "");

  let viewing = null;   // the tab they're looking at right now

  socket.on("join", raw => {
    const id = clean(raw, 12).toUpperCase();
    const r = byId(id);
    if (!r || !r.enabled) return socket.emit("denied", "Region not available");

    // subscribe to all of them, so switching tabs needs no round trip
    live.forEach(x => socket.join(x));
    if (!viewing) online++;          // count the person once, not once per tab switch
    if (!watchers.has(socket.id)) watchers.set(socket.id, "");
    viewing = id;

    socket.emit("hello", { region: id, regions: REGIONS, cap: CAP, channels: CHANNELS, build: BUILD });
    live.forEach(x => socket.emit("sync", snapshot(x)));
    socket.emit("chatlog", state.chat);
    socket.emit("roster", state.rosters);
    socket.emit("notice", state.notice);
    socket.emit("mvpmsg", state.mvpMsg);
    socket.emit("mvptimer", state.mvpTimer);
    socket.emit("music", musicView());
    socket.emit("musiclog", state.musicLog);
    socket.emit("proj", state.proj);
    socket.emit("listeners", listenersView());
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
    if (nameless(by)) return;          // say who you are first
    if (isBanned(browserId, ip)) { socket.disconnect(true); return; }
    noteSeen(browserId, ip, by);
    if (state.seen[browserId]) state.seen[browserId].acts =
      (state.seen[browserId].acts || 0) + 1;
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
        // a number someone actually set supersedes any drop we were holding
        target.pendingAt = null;
        clearDropTimer(region, at);
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

        target.entries.push({ id: uid(), name, at: joinClock(target) });
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
        moved.at = joinClock(to);        // joins the clock already running there
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
        // merging into a channel that is already going? take its clock. an
        // empty one is a fresh start, so that keeps the reset.
        const stamp = to.entries.length ? joinClock(to) : now;
        moving.forEach(e => { e.at = stamp; });
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
        // the drop count is measured from the same moment, so correcting how
        // long the channel has been going has to move that anchor too — else
        // the timer says 40m while the burning has only fallen for two
        target.occupiedAt = base;
        target.pctAt = Math.min(target.pctAt || base, base);
        note(region, `${ch(at)} set to ${mins}m by ${by}`);
        break;
      }
      case "person-color": {
        const area = areaOf(region);
        const p = findPerson(a.id, area);
        const col = clean(a.color, 12);
        if (!p || !/^#[0-9a-fA-F]{6}$/.test(col)) return;
        // an optional second colour: the name and its glow blend between the
        // two. anything that isn't a hex clears it back to a single colour.
        // up to two more, in order. a colour cannot sit in the third slot with
        // the second empty, so they are packed down — the client does the same,
        // this is here so a hand-rolled action cannot leave a gap.
        const hex = v => (/^#[0-9a-fA-F]{6}$/.test(v) ? v : null);
        const extra = [hex(clean(a.color2, 12)), hex(clean(a.color3, 12))]
          .filter(Boolean)
          .filter((v, i, arr) => v !== col && arr.indexOf(v) === i);
        p.color = col;
        p.color2 = extra[0] || null;
        p.color3 = extra[1] || null;
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
        musicNote(`${by} queued a song`);
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
          musicNote(`${by} removed the playing song`);
          startNext();
        } else {
          const i = state.music.queue.findIndex(t => t.id === a.id);
          if (i === -1) return;
          if (state.music.queue[i].token !== token) return;
          const [gone] = state.music.queue.splice(i, 1);
          musicNote(`${by} removed ${gone.title || "a song"} from the queue`);
        }
        persist();
        broadcastMusic();
        return;
      }
      case "music-skip": {
        if (!state.music.playing) return;
        musicNote(`${by} skipped a song`);
        startNext();
        persist();
        broadcastMusic();
        return;
      }
      case "music-duration": {
        const secs = Math.max(0, Math.min(60 * 60 * 6, Math.round(Number(a.seconds))));
        if (!secs) return;
        if (state.music.playing && state.music.playing.id === a.id && !state.music.playing.duration) {
          state.music.playing.duration = secs;
          scheduleSongEnd();
          persist();
          broadcastMusic();
        }
        const q = state.music.queue.find(t => t.id === a.id);
        if (q) q.duration = secs;
        return;
      }
      case "music-pause": {
        // pausing is shared: it stops for everyone, and resumes for everyone
        const cur = state.music.playing;
        if (!cur || cur.id !== a.id) return;
        const want = !!a.paused;
        if (want === !!cur.paused) return;                 // already in that state
        if (Date.now() - (cur.lastToggle || 0) < 1200) return;   // echo from another listener
        cur.lastToggle = Date.now();
        if (want) {
          const at = Number(a.seconds);
          cur.at = isFinite(at) && at >= 0 ? at : (Date.now() - cur.startedAt) / 1000;
          cur.paused = true;
          musicNote(`${by} paused the music`);
        } else {
          cur.paused = false;
          cur.startedAt = Date.now() - (cur.at || 0) * 1000;
          musicNote(`${by} started it again`);
        }
        scheduleSongEnd();
        persist();
        broadcastMusic();
        return;
      }
      case "music-seek": {
        // somebody dragged the scrubber — move the shared clock so everyone follows
        const cur = state.music.playing;
        if (!cur || cur.id !== a.id) return;
        if (cur.paused) return;                  // nothing is running to move
        const secs = Math.max(0, Math.min(60 * 60 * 6, Math.round(Number(a.seconds))));
        if (!isFinite(secs)) return;

        // Backstop against a feedback loop. A listener whose player stalls
        // reports its own lagging position as a seek; that rewinds everyone,
        // whose players then correct, which their watchers can read as another
        // seek. Two of these fighting will yank a song back and forth forever.
        // The client filters most of it out, but the shared clock is the thing
        // being damaged, so it defends itself too.
        const already = (Date.now() - cur.startedAt) / 1000;
        if (Math.abs(secs - already) < 3) return;      // it is already there
        if (Date.now() - lastSeekAt < 1500) return;    // an echo of the last one
        lastSeekAt = Date.now();

        cur.startedAt = Date.now() - secs * 1000;
        cur.at = secs;
        // a drag fires this repeatedly — one line per few seconds is plenty
        if (Date.now() - lastSeekNote > 4000) {
          lastSeekNote = Date.now();
          musicNote(`${by} jumped to ${mmss(secs)}`);
        }
        scheduleSongEnd();
        persist();
        broadcastMusic();
        return;
      }
      case "music-title": {
        const title = clean(a.title, 120);
        if (!title) return;
        if (state.music.playing && state.music.playing.id === a.id) {
          const first = !state.music.playing.title;
          state.music.playing.title = title;
          if (first) musicNote(`now playing: ${title} — added by ${state.music.playing.by}`);
        }
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
      case "proj-set": {
        // the projection rules are shared, so a change lands on every board
        const p = state.proj;
        const num = (v, cur, lo, hi) => {
          if (v === undefined || v === null || v === "") return cur;
          const n = Math.round(Number(v));
          return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : cur;
        };
        const next = {
          gain:        num(a.gain,        p.gain,        1, 50),
          drop:        num(a.drop,        p.drop,        1, 50),
          dropEvery:   num(a.dropEvery,   p.dropEvery,   1, 240),
          curfewStart: num(a.curfewStart, p.curfewStart, 0, 23),
          curfewEnd:   num(a.curfewEnd,   p.curfewEnd,   0, 23),
          settle:      a.settle === undefined ? p.settle : !!a.settle
        };
        if (JSON.stringify(next) === JSON.stringify(p)) return;
        state.proj = next;
        note(region, `projection rules changed by ${by}`
          + ` — +${next.gain}%/h up, −${next.drop}% every ${next.dropEvery}m sat on, curfew `
          + String(next.curfewStart).padStart(2, "0") + ":00–"
          + String(next.curfewEnd).padStart(2, "0") + ":00 UTC, "
          + (next.settle ? "confirm on arrival" : "no confirm on arrival"));
        persist();
        io.emit("proj", state.proj);
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
        const token = clean(a.token, 64);
        if (!list || !name || !token) return;
        if (name.toLowerCase() === "guest") return;   // guests stay guests
        if (list.some(p => p.name.toLowerCase() === name.toLowerCase())) return;
        if (list.length >= 200) return;
        // whoever adds a name owns it straight away
        list.push({ id: uid(), name, color: null, color2: null, color3: null, claimedBy: token, claimedName: by });
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
        target.entries.push({ id: uid(), pid: p.id, name: p.name, at: joinClock(target) });
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
    // A channel left sitting empty has been climbing. The moment someone walks
    // onto it that projection is the best reading anyone has, so it becomes the
    // confirmed one — otherwise the card keeps showing a two-hour-old 80% for a
    // channel that is really at 100%, and whoever moved has to fix it by hand.
    if (state.proj.settle) {
      board.forEach((c, i) => {
        if (before[i] !== 0 || !c.entries.length) return;   // only empty → occupied
        const p = projectedFor(c);
        if (p === null || p === c.pct) return;
        note(region, `${ch(i)} burning ${c.pct}% → ${p}% — projection confirmed on arrival`);
        c.pct = p;
        c.pctAt = Date.now();
        c.pendingAt = null;      // it is folded into the number now
      });
    }

    /* Burning falls while a channel is being farmed — one drop every
       `dropEvery` minutes of sitting on it. Nobody wants to keep typing that
       in, so the board does the sum itself the moment the last person leaves.

       The part that is easy to get wrong is the drop already in flight. A
       sitting of 42 minutes with drops every 15 saw two of them, at 15 and 30,
       and a third is due at 45 — three minutes after everyone walked off. That
       one still lands, because the cycle does not care whether anyone is
       standing there. So the reading written down is the value after that
       third drop, and the climb back up is held until the moment it falls.
       Leave at 16 minutes and it is one seen plus one in flight: −20%. */
    board.forEach((c, i) => {
      const nowN = c.entries.length;
      const t = Date.now();

      if (before[i] > 0 && nowN === 0) {
        /* The falling clock starts on the first kill and runs on its own from
           there — writing a reading down tells us the value at that moment, it
           does not restart the cycle. So the drops owed are simply the ones
           that landed since whenever somebody last wrote a number down, and the
           next one is due on the cycle's own schedule, not fifteen minutes
           after the last reading. */
        const cycle = c.occupiedAt || c.pctAt || 0;
        if (cycle) {
          /* Plain wall-clock time, not the curfew-adjusted kind.
             The freeze window is about burning not *climbing* while a channel
             sits empty. The fall while people are farming it keeps running
             regardless — using the frozen clock here meant that between 22:00
             and 08:00 UTC nothing dropped at all, which is most of the day in
             half the world. */
          const every = state.proj.dropEvery * 60000;
          const sinceStart = Math.max(0, t - cycle);
          const landed = Math.floor(sinceStart / every);          // since the first kill
          const readAt = Math.min(t, Math.max(c.pctAt || 0, cycle));
          const atRead = Math.floor(Math.max(0, readAt - cycle) / every);
          const owed = Math.max(0, landed - atRead);              // the ones nobody logged
          const wait = (landed + 1) * every - sinceStart;         // until the next falls
          const was = c.pct;
          const next = Math.max(0, Math.min(100, was - state.proj.drop * owed));
          if (next !== was) {
            note(region, `${ch(i)} burning ${was}% → ${next}% — `
              + `${owed} drop${owed === 1 ? "" : "s"} nobody wrote down`);
          }
          c.pct = next;
          c.pctAt = t;
          c.pendingAt = t + wait;      // the drop still to come
          c.emptiedAt = c.pendingAt;   // and the climb starts when it does
          scheduleDrop(region, i);     // and something has to actually apply it
        } else {
          c.emptiedAt = t;
          c.pendingAt = null;
          clearDropTimer(region, i);
        }
        c.occupiedAt = null;
      } else if (nowN > 0) {
        c.emptiedAt = null;
        c.pendingAt = null;            // somebody is on it again
        clearDropTimer(region, i);
        if (!c.occupiedAt) c.occupiedAt = t;
      }
    });

    persist();
    broadcast(region);
  });

  // "MVP is up" — one shout that reaches anyone currently on a channel, any board
  let lastMvp = 0;
  // the name this browser goes by, for the watching list
  socket.on("whoami", n => {
    const who = clean(n, 24);
    noteSeen(browserId, ip, who);
    const next = nameless(who) ? "" : who;
    if (watchers.get(socket.id) === next) return;
    watchers.set(socket.id, next);
    presence();
  });

  // whether this browser currently has the queue playing
  let isListening = false;
  socket.on("listening", v => {
    // older clients sent a bare boolean; newer ones send the name along with it
    const on = (v && typeof v === "object") ? !!v.on : !!v;
    const who = clean((v && typeof v === "object") ? v.who : "", 24) || "Guest";
    const same = on === isListening && listeners.get(socket.id) === who;
    isListening = on;
    if (on) listeners.set(socket.id, who);
    else listeners.delete(socket.id);
    // still sweep even when nothing changed here — this is the message that
    // arrives when somebody reconnects, which is exactly when a ghost appears
    if (!same || pruneListeners()) broadcastListeners();
  });

  // turn somebody else's music off — for the ones who wander away with it on
  socket.on("music-kick", id => {
    const target = clean(id, 40);
    if (!listeners.has(target)) return;
    const who = listeners.get(target) || "someone";
    const by = watchers.get(socket.id) || "someone";
    if (nameless(by)) return;
    listeners.delete(target);
    const sock = io.sockets.sockets.get(target);
    if (sock) sock.emit("unlisten", { by });     // their player stops itself
    musicNote(`${by} turned the music off for ${who}`);
    broadcastListeners();
  });

  socket.on("mvp", m => {
    if (!viewing) return;
    const now = Date.now();
    if (now - lastMvp < 5000) return;              // no spamming the button
    lastMvp = now;
    const by = clean(m && m.by, 24) || "someone";
    if (nameless(by)) return;
    note(viewing, `MVP called by ${by}`);
    persist();
    broadcast(viewing);
    io.emit("mvp", { by, t: now, msg: state.mvpMsg });
  });

  socket.on("chat", m => {
    if (!m || !viewing) return;
    const who = clean(m.who, 24) || "Guest";
    if (nameless(who)) return;         // say who you are first
    const text = clean(m.text, 200);
    if (!text) return;
    state.chat.push({ t: Date.now(), who, msg: text });
    if (state.chat.length > LOG_MAX) state.chat.splice(0, state.chat.length - LOG_MAX);
    persist();
    broadcastChat();
  });

  socket.on("disconnect", () => {
    if (isListening || listeners.has(socket.id)) {
      isListening = false;
      listeners.delete(socket.id);
      broadcastListeners();
    }
    const wasWatching = watchers.delete(socket.id);
    if (!viewing) { if (wasWatching) presence(); return; }
    online = Math.max(0, online - 1);
    presence();
  });
});

async function main() {
  await storage.init();
  hydrate(await storage.load());
  scheduleMvpTimer();
  scheduleSongEnd();
  scheduleAllDrops();     // any drop that fell while we were down lands now
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Channel tracker on :${PORT} — open /${live[0].toLowerCase()}`);
  });
}

main().catch(err => {
  console.error("startup failed:", err);
  process.exit(1);
});
