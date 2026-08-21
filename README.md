# Channel Tracker

A shared board for tracking who's sitting on which channel. Everyone looking at the
same URL sees the same board — a move by one person lands on everyone else's screen
instantly, and every change is written to a running log alongside the chat.

Right now **RD1** is the only open region. Each region gets its own URL and its own
separate board, so adding more later is a one-line change.

## Running it on Render (free)

Replit's free plan can't publish this — a Node server holding websocket
connections needs a paid deployment type there. Render's free tier runs it fine.

1. Put this folder in a GitHub repo (free account, can be private).
2. On render.com: **New → Web Service**, connect the repo. Render reads
   `render.yaml` and fills everything in. If you'd rather set it by hand:
   runtime **Node**, build `npm install`, start `npm start`.
3. Deploy. You get a URL like `channel-tracker.onrender.com` — share it with
   `/rd1` on the end.

Two things to know about the free tier:

**It sleeps.** After ~15 minutes with no traffic the instance shuts down, and
the next visitor waits 30–60 seconds while it wakes. Everyone after that gets it
instantly. A free pinger (cron-job.org, every 10 minutes, pointed at your `/rd1`
URL) keeps it awake if that's annoying.

**The disk is wiped on restart.** Without a database the board resets each time
it wakes. To keep it: create a free Postgres on Render, copy its *Internal
Database URL*, and add it to the web service as an environment variable named
`DATABASE_URL`. The app picks it up automatically — no code change. Note that
Render's free Postgres expires after a set period; if you want it permanent, a
free Supabase or Neon database works the same way, same variable.

## Running it on Replit

1. Go to replit.com and create a Repl → **Import from ZIP** (or make a blank Node.js
   Repl and drag these files in). If Replit asks, the language is **Node.js**.
2. Open the Shell tab and run:
   ```
   npm install
   ```
3. Press **Run**. The webview opens on `/rd1`.
4. To give other people a link, hit **Deploy** in the top right and pick
   **Autoscale** (or **Reserved VM** — see the note below). You'll get a permanent
   `.replit.app` URL. Share that URL + `/rd1`.

Replit sets `PORT` itself, so you don't need to configure anything.

### Which deployment type

**Reserved VM** is the better fit. The board is held in memory and written to
`data.json` on disk, which means:

- Reserved VM: one always-on machine, disk persists, board survives restarts. ✅
- Autoscale: can run multiple instances that each have their own copy of the board,
  and the disk resets. Two people could end up on different boards.

If you'd rather stay on Autoscale, swap `data.json` for Replit's key-value store or a
Postgres/Supabase table — say the word and I'll rewrite that part.

## Opening another region

In `index.js`, near the top:

```js
const REGIONS = [
  { id: "B1",   enabled: false },
  { id: "B2Z1", enabled: false },
  { id: "RD1",  enabled: true  },
  ...
];
```

Flip `enabled` to `true` and restart. That region immediately gets:

- its own link — `/rd4`, `/b2z1`, and so on
- its own 40 channels, its own burning percentages
- its own chat and activity log, fully separate from RD1

Disabled regions still show in the tab bar, greyed out, and their URLs return a
"not open yet" page.

## How it works

- `index.js` — Express + Socket.IO. Holds the authoritative board, validates every
  action, writes the log entry, then broadcasts the new board to everyone in that
  region's room. Saves to `data.json` shortly after each change.
- `public/index.html` — the whole client: board, burning % popover, chat. It never
  edits the board directly; it sends an action and waits for the broadcast, so two
  people clicking at once can't get out of sync.

Names, timers, and positions all live on the server. The only thing kept in the
browser is your display name.

## Using the board

| Action | How |
| --- | --- |
| Set burning % | Click the percentage badge → pick from the 0–100 grid |
| Add someone | Click **+**, type a name, press Enter (4 per channel) |
| Rename | Pencil icon |
| Remove | ✕ icon |
| Reset a timer | Click the timer itself |
| Move one person | Drag their name (or their initial chip) onto another channel |
| Move a whole channel | Drag the ⋮⋮ grip in the card header |
| Chat | Click your name at the bottom to set it, then type |

Dropping a full channel on an empty one moves it. Dropping it on an occupied one
swaps the two. A single person won't drop onto a channel that already has four.

Timers count up from when the person was added and turn red past 90 minutes.
