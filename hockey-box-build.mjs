// Box scores for the Team Matchup page and the player sheet.
// hockey-box.json = { builtAt, names: {pid: name}, games: { gid: [[side, pid, pos, g, a, sog, toiSec], ...] } }
// Covers each team's last 10 games plus the last 7 meetings of every team pair (ids from hockey-teamlog.json).
// Reads the season cache (no network) except a one-time name lookup for players no longer on a roster.
import fs from "node:fs";

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const cache = readJSON("hockey-season-cache.json", null);
const TL = readJSON("hockey-teamlog.json", null);
if (!cache || !TL) { console.log("box: missing season cache or teamlog"); process.exit(0); }

const want = new Set();
for (const ids of Object.values(TL.teams)) ids.slice(0, 10).forEach((id) => want.add(String(id)));
for (const ids of Object.values(TL.pairs)) ids.slice(0, 7).forEach((id) => want.add(String(id)));

const games = {};
const need = new Set();
for (const id of want) {
  const g = cache.games[id]; if (!g?.p) continue;
  const rows = [];
  for (const [pid, x] of Object.entries(g.p)) {
    if (x[1] === "G") continue;
    // x = [side, pos, g, a, sog, toiSec, ...]
    rows.push([x[0], +pid, x[1], x[2], x[3], x[4], x[5] ?? 0]);
    need.add(+pid);
  }
  rows.sort((a, b) => a[0] - b[0] || (b[3] + b[4]) - (a[3] + a[4]) || b[5] - a[5] || b[6] - a[6]);
  games[id] = rows;
}

// names: teamlog, teams file, slate players, shared cache, then NHL landing for the rest (cached)
const names = {};
const T = readJSON("hockey-teams.json", {});
const H = readJSON("hockey.json", {});
const nameCache = readJSON("hockey-names-cache.json", {});
for (const p of H.players ?? []) names[p.pid] = p.name;
for (const [pid, v] of Object.entries(T.names ?? {})) if (!names[pid] && v?.[0]) names[pid] = v[0];
for (const [pid, v] of Object.entries(TL.names ?? {})) if (!names[pid] && v) names[pid] = v;
for (const [pid, v] of Object.entries(nameCache)) if (!names[pid] && v) names[pid] = v;
const missing = [...need].filter((id) => !names[id]);
const WEB = "https://api-web.nhle.com/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of missing.slice(0, 150)) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(`${WEB}/player/${id}/landing`);
      if (r.status === 429) { await sleep(1500 * (t + 1)); continue; }
      if (!r.ok) break;
      const j = await r.json();
      if (j?.firstName?.default) { names[id] = `${j.firstName.default} ${j.lastName.default}`; nameCache[id] = names[id]; }
      break;
    } catch { break; }
  }
  await sleep(250);
}
if (missing.length) fs.writeFileSync("hockey-names-cache.json", JSON.stringify(nameCache));
const outNames = Object.fromEntries([...need].map((id) => [id, names[id] ?? null]));
fs.writeFileSync("hockey-box.json", JSON.stringify({ builtAt: new Date().toISOString(), names: outNames, games }));
console.log("hockey-box.json", (fs.statSync("hockey-box.json").size / 1024).toFixed(0), "KB", Object.keys(games).length, "games; looked up", missing.length, "names");
