// MatrixHockey season cache: every finished regular-season game (2025-26 + current)
// -> compact per-game record from NHL play-by-play + shift charts.
// Incremental: only fetches games not yet in hockey-season-cache.json.
import fs from "node:fs";

const SEASONS = ["20252026", "20262027"];
const STATS = "https://api.nhle.com/stats/rest/en";
const WEB = "https://api-web.nhle.com/v1";
const CACHE = "hockey-season-cache.json";

async function fetchJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 MatrixHockey" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) { console.warn("fail", url, e.message); return null; }
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } }));
  return out;
}
const mmss = (s) => { if (!s) return 0; const [m, x] = s.split(":").map(Number); return m * 60 + x; };
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }

let cache = readJSON(CACHE, { v: 3, games: {} });
if ((cache.v ?? 1) < 3) { console.log("cache -> v3 rebuild"); cache = { v: 3, games: {} }; }
const standings = await fetchJSON(`${WEB}/standings/now`);
const TEAMS = [...new Set((standings?.standings ?? []).map((t) => t.teamAbbrev.default))];
if (TEAMS.length < 30) throw new Error("no teams");

const meta = new Map();
for (const season of SEASONS) {
  await pool(TEAMS, 8, async (t) => {
    const s = await fetchJSON(`${WEB}/club-schedule-season/${t}/${season}`);
    for (const g of s?.games ?? []) {
      if (g.gameType !== 2 || !["OFF", "FINAL"].includes(g.gameState)) continue;
      meta.set(g.id, { id: g.id, d: g.gameDate, s: season });
    }
  });
}
let todo = [...meta.values()].filter((g) => !cache.games[g.id]).sort((a, b) => (a.d < b.d ? -1 : 1));
if (process.env.LIMIT) todo = todo.slice(0, +process.env.LIMIT);
console.log("finished games", meta.size, "to fetch", todo.length);

function greedyUnits(entries, need, max, okFn) {
  const used = new Set(), out = [];
  for (const [ids, v] of entries.sort((a, b) => b[1] - a[1])) {
    if (out.length >= max) break;
    if (ids.length !== need || ids.some((p) => used.has(p) || !okFn(p))) continue;
    ids.forEach((p) => used.add(p)); out.push(ids);
  }
  return out;
}

async function processGame(g) {
  const [pbp, sh] = await Promise.all([
    fetchJSON(`${WEB}/gamecenter/${g.id}/play-by-play`),
    fetchJSON(`${STATS}/shiftcharts?cayenneExp=gameId=${g.id}`),
  ]);
  if (!pbp?.plays || !pbp.rosterSpots) return null;
  const A = pbp.awayTeam.abbrev, H = pbp.homeTeam.abbrev, hId = pbp.homeTeam.id;
  const pos = {}, side = {};
  for (const r of pbp.rosterSpots) { pos[r.playerId] = r.positionCode; side[r.playerId] = r.teamId === hId ? 1 : 0; }
  const P = {};
  const ens = (pid) => (P[pid] ??= { s: side[pid] ?? 0, pos: pos[pid] ?? "C", g: 0, a: 0, sog: 0, toi: 0, es: 0, pp: 0, slot: "", pu: 0, fo: 0, pk: 0 });
  // --- timeline (skaters only)
  const rows = (sh?.data ?? []).filter((x) => x.typeCode === 517 && x.duration && pos[x.playerId] && pos[x.playerId] !== "G");
  const tl = [[], []]; let maxSec = 0;
  for (const x of rows) {
    const sd = side[x.playerId];
    const st = (x.period - 1) * 1200 + mmss(x.startTime), en = (x.period - 1) * 1200 + mmss(x.endTime);
    if (en <= st) continue;
    maxSec = Math.max(maxSec, en);
    ens(x.playerId).toi += en - st;
    for (let s = st; s < en; s++) (tl[sd][s] ??= []).push(x.playerId);
  }
  const acc = [0, 1].map(() => ({ trio: {}, dpair: {}, pp: {} }));
  const isF = (p) => pos[p] && pos[p] !== "D" && pos[p] !== "G";
  const mu = {}; // "hKey|aKey" -> [sec, hgf, agf, hsf, asf]
  const keysOf = (on) => {
    const f = on.filter(isF).sort((a, b) => a - b), d = on.filter((p) => pos[p] === "D").sort((a, b) => a - b);
    return [f.length === 3 ? "F" + f.join("-") : null, d.length === 2 ? "D" + d.join("-") : null];
  };
  const muPairs = (h, a) => {
    const out = [];
    if (h[0] && a[0]) out.push(`${h[0]}|${a[0]}`);
    if (h[0] && a[1]) out.push(`${h[0]}|${a[1]}`);
    if (h[1] && a[0]) out.push(`${h[1]}|${a[0]}`);
    return out;
  };
  for (let s = 0; s < maxSec; s++) {
    const on = [tl[0][s] ?? [], tl[1][s] ?? []];
    if (on[0].length === 5 && on[1].length === 5) for (const k of muPairs(keysOf(on[1]), keysOf(on[0]))) (mu[k] ??= [0, 0, 0, 0, 0])[0]++;
    for (const sd of [0, 1]) {
      const mine = on[sd], th = on[1 - sd];
      if (!mine.length) continue;
      const state = mine.length === th.length ? "es" : mine.length > th.length ? "pp" : "pk";
      for (const p of mine) { if (state === "es") P[p].es++; else if (state === "pp") P[p].pp++; else P[p].pk++; }
      if (state === "es") {
        const f = mine.filter(isF).sort((a, b) => a - b), d = mine.filter((p) => pos[p] === "D").sort((a, b) => a - b);
        if (f.length === 3) { const k = f.join("-"); acc[sd].trio[k] = (acc[sd].trio[k] ?? 0) + 1; }
        if (d.length === 2) { const k = d.join("-"); acc[sd].dpair[k] = (acc[sd].dpair[k] ?? 0) + 1; }
      } else if (state === "pp" && mine.length >= 4) {
        for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
          const k = mine[i] < mine[j] ? `${mine[i]}-${mine[j]}` : `${mine[j]}-${mine[i]}`;
          acc[sd].pp[k] = (acc[sd].pp[k] ?? 0) + 1;
        }
      }
    }
  }
  // --- slots
  for (const sd of [0, 1]) {
    const tri = greedyUnits(Object.entries(acc[sd].trio).map(([k, v]) => [k.split("-").map(Number), v]), 3, 4, isF);
    tri.sort((a, b) => b.reduce((x, p) => x + P[p].es, 0) - a.reduce((x, p) => x + P[p].es, 0));
    tri.forEach((ids, i) => ids.forEach((p) => (P[p].slot = `L${i + 1}`)));
    const dp = greedyUnits(Object.entries(acc[sd].dpair).map(([k, v]) => [k.split("-").map(Number), v]), 2, 3, (p) => pos[p] === "D");
    dp.sort((a, b) => b.reduce((x, p) => x + P[p].es, 0) - a.reduce((x, p) => x + P[p].es, 0));
    dp.forEach((ids, i) => ids.forEach((p) => (P[p].slot = `D${i + 1}`)));
    // PP units: greedy clique on PP pair seconds
    const used = new Set();
    const cands = Object.keys(P).map(Number).filter((p) => P[p].s === sd && P[p].pp > 20);
    for (let u = 1; u <= 2; u++) {
      const c = cands.filter((p) => !used.has(p)).sort((a, b) => P[b].pp - P[a].pp);
      if (!c.length) break;
      const unit = [c[0]];
      while (unit.length < 5) {
        let best = null, bv = 20;
        for (const x of c) {
          if (unit.includes(x)) continue;
          const v = Math.min(...unit.map((m) => acc[sd].pp[m < x ? `${m}-${x}` : `${x}-${m}`] ?? 0));
          if (v > bv) { bv = v; best = x; }
        }
        if (!best) break;
        unit.push(best);
      }
      if (unit.length < 4) break;
      unit.forEach((p) => { used.add(p); P[p].pu = u; });
    }
  }
  // --- events
  const unitStats = {}; // `${sd}|${key}` -> [sec,gf,ga,sf,sa]
  for (const sd of [0, 1]) {
    for (const [k, v] of Object.entries(acc[sd].trio)) unitStats[`${sd}|F${k}`] = [v, 0, 0, 0, 0];
    for (const [k, v] of Object.entries(acc[sd].dpair)) unitStats[`${sd}|D${k}`] = [v, 0, 0, 0, 0];
  }
  const unitsAt = (sd, t) => {
    const on = tl[sd][Math.max(0, t - 1)] ?? [];
    const f = on.filter(isF).sort((a, b) => a - b), d = on.filter((p) => pos[p] === "D").sort((a, b) => a - b);
    const out = [];
    if (f.length === 3) out.push(`${sd}|F${f.join("-")}`);
    if (d.length === 2) out.push(`${sd}|D${d.join("-")}`);
    return out;
  };
  const ev = [], gl = {}, pen = [0, 0];
  const ST = { wrist: 1, snap: 2, slap: 3, backhand: 4, "tip-in": 5, deflected: 6, "wrap-around": 7, poke: 8, bat: 8, "between-legs": 8, cradle: 8 };
  let prev = null; const lastAtt = [-99, -99];
  for (const pl of pbp.plays) {
    const pd = pl.periodDescriptor ?? {};
    if (pd.periodType === "SO") continue;
    const det = pl.details ?? {};
    const tNow = (pd.number - 1) * 1200 + mmss(pl.timeInPeriod);
    const ownNow = det.eventOwnerTeamId === hId ? 1 : 0;
    const prevPlay = prev; prev = { t: tNow, own: ownNow, z: det.zoneCode, k: pl.typeDescKey, p: pd.number };
    if (pl.typeDescKey === "missed-shot") { lastAtt[ownNow] = tNow; continue; }
    if (pl.typeDescKey === "faceoff") {
      if (det.winningPlayerId) ens(det.winningPlayerId).fo++;
      if (det.losingPlayerId) ens(det.losingPlayerId).fo++;
      continue;
    }
    if (pl.typeDescKey === "penalty") {
      if (["MIN", "MAJ", "BEN"].includes(det.typeCode)) pen[det.eventOwnerTeamId === hId ? 1 : 0]++;
      continue;
    }
    const goal = pl.typeDescKey === "goal";
    if (!goal && pl.typeDescKey !== "shot-on-goal") continue;
    const t = (pd.number - 1) * 1200 + mmss(pl.timeInPeriod);
    const own = det.eventOwnerTeamId === hId ? 1 : 0;
    const sc = String(pl.situationCode ?? "1551").padStart(4, "0");
    const ag = +sc[0], as = +sc[1], hs = +sc[2], hg = +sc[3];
    const mineSk = own ? hs : as, thSk = own ? as : hs, thG = own ? ag : hg;
    const str = thG === 0 ? "n" : mineSk === thSk ? "e" : mineSk > thSk ? "p" : "s";
    const hDir = pl.homeTeamDefendingSide === "right" ? -1 : 1;
    const dir = own ? hDir : -hDir;
    const x = det.xCoord != null ? det.xCoord * dir : null, y = det.yCoord != null ? det.yCoord * dir : null;
    const shooter = goal ? det.scoringPlayerId : det.shootingPlayerId;
    if (shooter) { ens(shooter).sog++; if (goal) P[shooter].g++; }
    const a1 = goal ? det.assist1PlayerId ?? 0 : 0, a2 = goal ? det.assist2PlayerId ?? 0 : 0;
    if (a1) ens(a1).a++; if (a2) ens(a2).a++;
    // flags: 1 rebound (own attempt <=3s before), 2 rush (prior event in neutral/own zone <=4s before)
    let fl = 0;
    if (t - lastAtt[own] <= 3 && t >= lastAtt[own]) fl |= 1;
    if (prevPlay && prevPlay.p === pd.number && t >= prevPlay.t && t - prevPlay.t <= 4 && prevPlay.z) {
      const z = prevPlay.own === own ? prevPlay.z : prevPlay.z === "O" ? "D" : prevPlay.z === "D" ? "O" : "N";
      if (z === "N" || z === "D") fl |= 2;
    }
    lastAtt[own] = t;
    const row = [own, shooter ?? 0, x, y, goal ? 1 : 0, str, a1, a2, t, det.goalieInNetId ?? 0, ST[det.shotType] ?? 0, fl];
    // special teams: on-ice skaters for the attacking side and the defending side
    if (str === "p" || str === "s") { const k = Math.max(0, t - 1); row.push(tl[own][k] ?? [], tl[1 - own][k] ?? []); }
    ev.push(row);
    if (det.goalieInNetId) { const gg = (gl[det.goalieInNetId] ??= [1 - own, 0, 0]); gg[1]++; if (goal) gg[2]++; }
    if (str === "e") {
      for (const k of unitsAt(own, t)) if (unitStats[k]) { unitStats[k][3]++; if (goal) unitStats[k][1]++; }
      for (const k of unitsAt(1 - own, t)) if (unitStats[k]) { unitStats[k][4]++; if (goal) unitStats[k][2]++; }
      const ku = (sd) => { const on = tl[sd][Math.max(0, t - 1)] ?? []; return on.length === 5 ? keysOf(on) : [null, null]; };
      for (const k of muPairs(ku(1), ku(0))) if (mu[k]) { if (own) { mu[k][3]++; if (goal) mu[k][1]++; } else { mu[k][4]++; if (goal) mu[k][2]++; } }
    }
  }
  const u = Object.entries(unitStats).filter(([, v]) => v[0] >= 60)
    .map(([k, v]) => { const [sd, key] = k.split("|"); return [+sd, key, ...v]; });
  const m = Object.entries(mu).filter(([, v]) => v[0] >= 30).map(([k, v]) => [...k.split("|"), ...v]);
  const p = {};
  for (const [pid, x] of Object.entries(P)) p[pid] = [x.s, x.pos, x.g, x.a, x.sog, x.toi, x.es, x.pp, x.slot, x.pu, x.fo, x.pk];
  return {
    d: g.d, s: g.s, a: A, h: H, p, ev, u, m, gl, pen, sc: [pbp.awayTeam.score ?? null, pbp.homeTeam.score ?? null],
    shifts: rows.length ? 1 : 0,
  };
}

let done = 0;
const save = () => fs.writeFileSync(CACHE, JSON.stringify(cache));
if (!todo.length) fs.writeFileSync(".season-new", "0");
await pool(todo, 8, async (g) => {
  const rec = await processGame(g);
  if (rec) cache.games[g.id] = rec;
  if (++done % 100 === 0) { console.log("processed", done); save(); }
});
save();
fs.writeFileSync(".season-new", String(done));
console.log("cache games", Object.keys(cache.games).length, (fs.statSync(CACHE).size / 1e6).toFixed(1), "MB");
