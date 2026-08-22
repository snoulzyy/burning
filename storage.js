/**
 * Storage.
 *
 * If DATABASE_URL is set, the board is kept in Postgres and survives restarts,
 * redeploys, and free-tier hosts that wipe the disk.
 *
 * If it isn't set, the board is written to data.json next to this file. That's
 * fine locally and on Reserved VM, but on a free Render instance the disk is
 * wiped whenever the service restarts, so the board resets.
 */
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
let pool = null;
let timer = null;

async function init() {
  if (!process.env.DATABASE_URL) {
    console.log("storage: data.json (no DATABASE_URL set)");
    return;
  }
  try {
    const { Pool } = require("pg");
    const candidate = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000
    });
    await candidate.query(
      "CREATE TABLE IF NOT EXISTS tracker_state (id text PRIMARY KEY, data jsonb NOT NULL)"
    );
    candidate.on("error", e => console.error("postgres pool error:", e.message));
    pool = candidate;
    console.log("storage: postgres");
  } catch (e) {
    pool = null;
    console.error("---------------------------------------------------------");
    console.error("DATABASE_URL is set but the database could not be reached:");
    console.error("  " + e.message);
    console.error("Falling back to data.json. The board will still work, but");
    console.error("it resets whenever this instance restarts. Check the value");
    console.error("of DATABASE_URL — it should end in ?sslmode=require");
    console.error("---------------------------------------------------------");
  }
}

async function load() {
  try {
    if (pool) {
      const r = await pool.query("SELECT data FROM tracker_state WHERE id = 'board'");
      return r.rows[0] ? r.rows[0].data : null;
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return null;
  }
}

// Debounced — a burst of edits results in one write.
function save(state) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      if (pool) {
        await pool.query(
          `INSERT INTO tracker_state (id, data) VALUES ('board', $1)
           ON CONFLICT (id) DO UPDATE SET data = $1`,
          [JSON.stringify(state)]
        );
      } else {
        fs.writeFile(DATA_FILE, JSON.stringify(state), err => {
          if (err) console.error("save failed:", err.message);
        });
      }
    } catch (e) {
      console.error("save failed:", e.message);
    }
  }, 800);
}

module.exports = { init, load, save };
