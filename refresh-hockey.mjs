// MatrixHockey refresh — builds hockey.json (board/stacks/lines) and
// hockey-picks.json (pre-puck-drop snapshot + next-day grading).
//
// Sources (all public NHL):
//   api.nhle.com/stats/rest   — per-game skater/goalie/team logs (bulk, per team)
//   api.nhle.com/stats/rest/en/shiftcharts — every shift of every player
//   api-web.nhle.com/v1       — schedule, rosters, boxscores, NHL Edge
//
// Design:
//   * Model inputs use a recency-decayed blend of LAST season + CURRENT season,
//     so the model starts on last year's data and sharpens as games accumulate.
//   * Lines / PP units are derived from shift charts of each team's most recent
//     games (preseason until the regular season has games). Even strength vs
//     power play is determined second-by-second by counting skaters on ice.
//   * Picks are snapshotted per game until puck drop, then frozen, then graded
//     from the boxscore once the game is final.

import fs from "node:fs";

import { bucketsOf, multFor, baseLambdas, applyContext, probs as probsOf, FACTOR_KEYS, seasonWeights } from "./hockey-factors.mjs";
import { buildGradeCtx, gradePlayer } from "./hockey-grades-core.mjs";
const PREV = "20252026";
const CUR = "20262027";
const STATS = "https://api.nhle.com/stats/rest/en";
const WEB = "https://api-web.nhle.com/v1";
const TZ = "America/Toronto";

// ---------------------------------------------------------------- utils
async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { redirect: "follow", headers: { "User-Agent": "matrixhockey/1.0" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) { console.warn("fetch failed", url, e.message); return null; }
      await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }
  }
}
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
function etDate(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function addDays(ymd, n) {
  const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
const mmss = (s) => { if (!s) return 0; const [m, x] = s.split(":").map(Number); return m * 60 + x; };
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function readJSON(path, dflt) { try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return dflt; } }
const poisGE = (lam, k) => { // P(X >= k)
  let p = 0, t = Math.exp(-lam);
  for (let i = 0; i < k; i++) { p += t; t = (t * lam) / (i + 1); }
  return clamp(1 - p, 0, 1);
};

// ---------------------------------------------------------------- 1. schedule
const today = etDate();
const slateDates = [today, addDays(today, 1)];
const sched = await fetchJSON(`${WEB}/schedule/${today}`);
const gamesByDate = {};
for (const day of sched?.gameWeek ?? []) {
  if (!slateDates.includes(day.date)) continue;
  gamesByDate[day.date] = (day.games ?? [])
    .filter((g) => g.gameType === 2 || g.gameType === 3)
    .map((g) => ({
      id: g.id, date: day.date, startUTC: g.startTimeUTC, state: g.gameState,
      away: g.awayTeam.abbrev, home: g.homeTeam.abbrev,
      awayScore: g.awayTeam.score ?? null, homeScore: g.homeTeam.score ?? null,
    }));
}
for (const d of slateDates) gamesByDate[d] ??= [];
const slateTeams = new Set(Object.values(gamesByDate).flat().flatMap((g) => [g.away, g.home]));
console.log("slate", Object.fromEntries(Object.entries(gamesByDate).map(([d, g]) => [d, g.length])));

// ---------------------------------------------------------------- 2. rosters
const standings = await fetchJSON(`${WEB}/standings/now`);
const ALL_TEAMS = [...new Set((standings?.standings ?? []).map((t) => t.teamAbbrev.default))];
if (ALL_TEAMS.length < 30) throw new Error("could not load team list");
const roster = {}; // id -> {name, team, pos, shoots}
const goalieIds = new Set();
await pool(ALL_TEAMS, 8, async (t) => {
  const r = await fetchJSON(`${WEB}/roster/${t}/current`);
  for (const grp of ["forwards", "defensemen", "goalies"]) {
    for (const p of r?.[grp] ?? []) {
      roster[p.id] = {
        name: `${p.firstName.default} ${p.lastName.default}`, team: t,
        pos: p.positionCode, shoots: p.shootsCatches, num: p.sweaterNumber ?? null,
      };
      if (grp === "goalies") goalieIds.add(p.id);
    }
  }
});
console.log("roster players", Object.keys(roster).length);

// ---------------------------------------------------------------- 3. game logs
// Per team, both seasons. Joins summary (G/A/PTS/SOG) with timeonice (TOI/PPTOI).
async function teamLogs(season, team) {
  const q = `cayenneExp=seasonId=${season}%20and%20gameTypeId=2%20and%20teamAbbrev=%22${team}%22`;
  const [s, t] = await Promise.all([
    fetchJSON(`${STATS}/skater/summary?isAggregate=false&isGame=true&start=0&limit=-1&${q}`),
    fetchJSON(`${STATS}/skater/timeonice?isAggregate=false&isGame=true&start=0&limit=-1&${q}`),
  ]);
  const toi = new Map((t?.data ?? []).map((x) => [`${x.playerId}:${x.gameId}`, x]));
  return (s?.data ?? []).map((x) => {
    const tt = toi.get(`${x.playerId}:${x.gameId}`);
    return {
      pid: x.playerId, gid: x.gameId, d: x.gameDate, team: x.teamAbbrev, opp: x.opponentTeamAbbrev,
      h: x.homeRoad === "H" ? 1 : 0, g: x.goals, a: x.assists, pts: x.points, sog: x.shots,
      ppp: x.ppPoints, toi: tt?.timeOnIce ?? x.timeOnIcePerGame ?? 0, pptoi: tt?.ppTimeOnIce ?? 0,
      pos: x.positionCode,
    };
  });
}
const logsByPlayer = new Map();
for (const season of [PREV, CUR]) {
  const all = await pool(ALL_TEAMS, 6, (t) => teamLogs(season, t));
  for (const rows of all) for (const r of rows) {
    if (!logsByPlayer.has(r.pid)) logsByPlayer.set(r.pid, []);
    logsByPlayer.get(r.pid).push({ ...r, s: season });
  }
}
for (const arr of logsByPlayer.values()) arr.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)); // newest first
console.log("players with logs", logsByPlayer.size);

// Team per-game logs (GA/SA) both seasons -> defensive context.
async function teamGameLogs(season) {
  const r = await fetchJSON(`${STATS}/team/summary?isAggregate=false&isGame=true&start=0&limit=-1&cayenneExp=seasonId=${season}%20and%20gameTypeId=2`);
  return (r?.data ?? []).map((x) => ({
    team: null, teamName: x.teamFullName, teamId: x.teamId, gid: x.gameId, d: x.gameDate, s: season,
    ga: x.goalsAgainst, gf: x.goalsFor, sa: x.shotsAgainstPerGame, sf: x.shotsForPerGame,
    pk: x.penaltyKillPct, pp: x.powerPlayPct,
  }));
}
// Map team full name -> abbrev from standings.
const nameToAbbr = {};
for (const t of standings.standings) nameToAbbr[t.teamName.default] = t.teamAbbrev.default;
for (const t of standings.standings) nameToAbbr[`${t.placeName?.default ?? ""} ${t.teamCommonName?.default ?? ""}`.trim()] = t.teamAbbrev.default;
const teamLogsByTeam = {};
for (const season of [PREV, CUR]) {
  for (const x of await teamGameLogs(season)) {
    const ab = nameToAbbr[x.teamName] ?? null;
    if (!ab) continue;
    (teamLogsByTeam[ab] ??= []).push({ ...x, team: ab });
  }
}
for (const a of Object.values(teamLogsByTeam)) a.sort((x, y) => (x.d < y.d ? 1 : -1));

// Goalie logs both seasons.
const goalieLogs = {};
for (const season of [PREV, CUR]) {
  const r = await fetchJSON(`${STATS}/goalie/summary?isAggregate=false&isGame=true&start=0&limit=-1&cayenneExp=seasonId=${season}%20and%20gameTypeId=2`);
  for (const x of r?.data ?? []) {
    (goalieLogs[x.playerId] ??= []).push({ d: x.gameDate, team: x.teamAbbrev, gs: x.gamesStarted, sa: x.shotsAgainst, sv: x.saves, ga: x.goalsAgainst, s: season });
  }
}
for (const a of Object.values(goalieLogs)) a.sort((x, y) => (x.d < y.d ? 1 : -1));

// ---------------------------------------------------------------- 4. decay blend
const HALF_LIFE = 25; // games
const decayW = (i) => Math.pow(0.5, i / HALF_LIFE);
function decayedMean(rows, f, prior, k) {
  let num = prior * k, den = k;
  rows.forEach((r, i) => { const w = decayW(i); num += w * f(r); den += w; });
  return num / den;
}
function windowAgg(rows) {
  const n = rows.length;
  if (!n) return null;
  const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
  return {
    gp: n, g: sum((r) => r.g), a: sum((r) => r.a), pts: sum((r) => r.pts), sog: sum((r) => r.sog),
    ppp: sum((r) => r.ppp),
    toi: r1(sum((r) => r.toi) / n / 60), pptoi: r1(sum((r) => r.pptoi) / n / 60),
    p1: r3(rows.filter((r) => r.pts >= 1).length / n),
    p2: r3(rows.filter((r) => r.pts >= 2).length / n),
    g1: r3(rows.filter((r) => r.g >= 1).length / n),
    s3: r3(rows.filter((r) => r.sog >= 3).length / n),
  };
}

// League averages (per team-game) from last season + current.
function teamBlend(team) {
  const rows = teamLogsByTeam[team] ?? [];
  // team context decays slower; current season ramps to a guaranteed share n/(n+3)
  const w = seasonWeights(rows, (i) => decayW(i * 0.6), (r) => r.s === CUR, 5);
  const W = w.reduce((a, b) => a + b, 0) || 1;
  const m = (f) => rows.reduce((a, r, i) => a + w[i] * f(r), 0) / W;
  const ga = m((r) => r.ga), sa = m((r) => r.sa), gf = m((r) => r.gf), sf = m((r) => r.sf);
  const l10 = rows.slice(0, 10);
  const avg = (arr, f) => (arr.length ? arr.reduce((a, r) => a + f(r), 0) / arr.length : null);
  const cur = rows.filter((r) => r.s === CUR), prev = rows.filter((r) => r.s === PREV);
  const pack = (arr) => arr.length ? {
    gp: arr.length, gapg: r3(avg(arr, (r) => r.ga)), sapg: r1(avg(arr, (r) => r.sa)),
    gfpg: r3(avg(arr, (r) => r.gf)), sfpg: r1(avg(arr, (r) => r.sf)),
    svPct: r3(1 - avg(arr, (r) => r.ga) / Math.max(1, avg(arr, (r) => r.sa))),
  } : null;
  return {
    blend: { gapg: ga, sapg: sa, gfpg: gf, sfpg: sf, svPct: 1 - ga / Math.max(1, sa) },
    prev: pack(prev), cur: pack(cur), l10: pack(l10),
  };
}
const teamCtx = {};
for (const t of ALL_TEAMS) teamCtx[t] = teamBlend(t);
const lg = (() => {
  const b = Object.values(teamCtx).map((t) => t.blend);
  const m = (f) => b.reduce((a, x) => a + f(x), 0) / b.length;
  return { gapg: m((x) => x.gapg), sapg: m((x) => x.sapg), svPct: m((x) => x.svPct) };
})();

// Position priors (per game) from last season.
const posPrior = { F: { pts: 0.45, g: 0.17, sog: 1.8, p1: 0.35 }, D: { pts: 0.3, g: 0.05, sog: 1.4, p1: 0.25 } };

// ---------------------------------------------------------------- 5. shifts -> lines
// For each slate team: latest up to 3 games (current regular season, else preseason).
const shiftCache = new Map();
async function gameShifts(gid) {
  if (shiftCache.has(gid)) return shiftCache.get(gid);
  const r = await fetchJSON(`${STATS}/shiftcharts?cayenneExp=gameId=${gid}`);
  const rows = (r?.data ?? []).filter((x) => x.typeCode === 517 && x.duration);
  shiftCache.set(gid, rows);
  return rows;
}
// Last-season TOI/gp per player — used to score how "NHL-like" a preseason lineup is.
const prevToi = {};
for (const [pid, rows] of logsByPlayer) {
  const pr = rows.filter((r) => r.s === PREV);
  if (pr.length >= 10) prevToi[pid] = pr.reduce((a, r) => a + r.toi, 0) / pr.length;
}
async function recentGameIds(team) {
  const s = await fetchJSON(`${WEB}/club-schedule-season/${team}/${CUR}`);
  const done = (s?.games ?? []).filter((g) => ["OFF", "FINAL"].includes(g.gameState));
  const reg = done.filter((g) => g.gameType === 2).sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1));
  const pre = done.filter((g) => g.gameType === 1).sort((a, b) => (a.gameDate < b.gameDate ? 1 : -1));
  const fmt = (g, score) => ({ id: g.id, date: g.gameDate, type: g.gameType, score });
  // Once 2+ regular-season games exist, use the latest 3 regular-season games only.
  if (reg.length >= 2) return reg.slice(0, 3).map((g) => fmt(g));
  // Otherwise rank preseason games by how many real NHL minutes the dressed
  // lineup carried last season (filters out split-squad / prospect games).
  const scored = [];
  for (const g of pre) {
    const rows = await gameShifts(g.id);
    const ids = new Set(rows.filter((x) => x.teamAbbrev === team).map((x) => x.playerId));
    let sc = 0;
    for (const id of ids) if (roster[id]?.team === team && !goalieIds.has(id)) sc += prevToi[id] ?? 0;
    scored.push(fmt(g, Math.round(sc / 60)));
  }
  scored.sort((a, b) => b.score - a.score || (a.date < b.date ? 1 : -1));
  const best = scored.slice(0, 3).sort((a, b) => (a.date < b.date ? 1 : -1));
  return [...reg.map((g) => fmt(g)), ...best].slice(0, 3);
}
// Returns per-game { onIce: Map<sec, {team: Set<pid>}>, dressed: Map<team, Set<pid>> }
function secondTimeline(rows) {
  const maxSec = rows.reduce((a, x) => Math.max(a, (x.period - 1) * 1200 + mmss(x.endTime)), 0);
  const byTeam = {};
  const dressed = {};
  for (const x of rows) {
    (dressed[x.teamAbbrev] ??= new Set()).add(x.playerId);
    const st = (x.period - 1) * 1200 + mmss(x.startTime);
    const en = (x.period - 1) * 1200 + mmss(x.endTime);
    const t = (byTeam[x.teamAbbrev] ??= []);
    for (let s = st; s < en; s++) (t[s] ??= []).push(x.playerId);
  }
  return { byTeam, dressed, maxSec };
}
function analyzeGame(rows, team, weight, acc) {
  const { byTeam, dressed, maxSec } = secondTimeline(rows);
  const teams = Object.keys(byTeam);
  const opp = teams.find((t) => t !== team);
  if (!byTeam[team] || !opp) return null;
  const mine = byTeam[team], theirs = byTeam[opp];
  for (let s = 0; s < maxSec; s++) {
    const a = (mine[s] ?? []).filter((p) => !goalieIds.has(p));
    const b = (theirs[s] ?? []).filter((p) => !goalieIds.has(p));
    if (!a.length) continue;
    const state = a.length === b.length ? "es" : a.length > b.length ? "pp" : "pk";
    if (state === "pk") continue;
    const M = acc[state];
    for (let i = 0; i < a.length; i++) {
      M.solo[a[i]] = (M.solo[a[i]] ?? 0) + weight;
      for (let j = i + 1; j < a.length; j++) {
        const k = a[i] < a[j] ? `${a[i]}-${a[j]}` : `${a[j]}-${a[i]}`;
        M.pair[k] = (M.pair[k] ?? 0) + weight;
      }
    }
    if (state === "es") {
      const fw = a.filter((p) => (roster[p]?.pos ?? "C") !== "D").sort((x, y) => x - y);
      if (fw.length === 3) { const k = fw.join("-"); M.trio[k] = (M.trio[k] ?? 0) + weight; }
    }
  }
  return dressed[team];
}
const pairKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
function buildLines(team, acc, dressedSet, nGamesW, preseason) {
  const isD = (p) => roster[p]?.pos === "D";
  const pool0 = [...dressedSet].filter((p) => !goalieIds.has(p) && roster[p]?.team === team);
  const F = pool0.filter((p) => !isD(p)), D = pool0.filter(isD);
  const es = acc.es, pp = acc.pp;
  // Forward trios: greedy on trio seconds.
  const lines = [];
  const used = new Set();
  const trios = Object.entries(es.trio).map(([k, v]) => [k.split("-").map(Number), v]).sort((a, b) => b[1] - a[1]);
  for (const [ids, v] of trios) {
    if (lines.length >= 4) break;
    if (ids.some((p) => used.has(p) || !F.includes(p))) continue;
    ids.forEach((p) => used.add(p));
    lines.push({ ids, esSecPerGame: Math.round(v / nGamesW) });
  }
  // Leftover forwards: attach by pair time (rare).
  const leftF = F.filter((p) => !used.has(p)).sort((a, b) => (es.solo[b] ?? 0) - (es.solo[a] ?? 0));
  while (leftF.length >= 3 && lines.length < 4) { const ids = leftF.splice(0, 3); ids.forEach((p) => used.add(p)); lines.push({ ids, esSecPerGame: 0 }); }
  // 1-2 stragglers: slot each into the line he shared the most ES time with
  // (if it has room), else start a short line so no dressed forward is lost.
  for (const p of leftF) {
    let best = null, bv = -1;
    for (const l of lines) {
      if (l.ids.length >= 3) continue;
      const v = l.ids.reduce((a, m) => a + (es.pair[pairKey(m, p)] ?? 0), 0);
      if (v > bv) { bv = v; best = l; }
    }
    if (best) best.ids.push(p);
    else if (lines.length < 4) lines.push({ ids: [p], esSecPerGame: 0 });
    else lines[lines.length - 1].ids.push(p);
    used.add(p);
  }
  // Order lines by total ES TOI of members.
  // Regular season: rank by ES minutes actually played. Preseason: stars are
  // managed, so rank by last season's TOI/gp (unknown rookies get 12 min F / 16 min D).
  const esTot = preseason
    ? (ids) => ids.reduce((a, p) => a + (prevToi[p] ?? (roster[p]?.pos === "D" ? 960 : 720)), 0)
    : (ids) => ids.reduce((a, p) => a + (es.solo[p] ?? 0), 0);
  lines.sort((a, b) => esTot(b.ids) / b.ids.length - esTot(a.ids) / a.ids.length);
  // D pairs greedy on pair time.
  const pairs = [];
  const usedD = new Set();
  const dp = Object.entries(es.pair).map(([k, v]) => [k.split("-").map(Number), v])
    .filter(([ids]) => ids.every((p) => D.includes(p))).sort((a, b) => b[1] - a[1]);
  for (const [ids, v] of dp) {
    if (pairs.length >= 3) break;
    if (ids.some((p) => usedD.has(p))) continue;
    ids.forEach((p) => usedD.add(p));
    pairs.push({ ids, esSecPerGame: Math.round(v / nGamesW) });
  }
  pairs.sort((a, b) => esTot(b.ids) - esTot(a.ids));
  let ppUnits = [];
  if (preseason) {
    // Preseason PP deployment is noise — use last season's PP TOI/gp ranking,
    // max 2 D per unit.
    const ppAvg = (p) => {
      const pr = (logsByPlayer.get(p) ?? []).filter((r) => r.s === PREV);
      return pr.length >= 10 ? pr.reduce((a, r) => a + r.pptoi, 0) / pr.length : 0;
    };
    const ranked = pool0.map((p) => [p, ppAvg(p)]).filter(([, v]) => v > 20).sort((a, b) => b[1] - a[1]);
    const used = new Set();
    for (let u = 0; u < 2; u++) {
      const unit = []; let d = 0;
      for (const [p] of ranked) {
        if (unit.length >= 5 || used.has(p)) continue;
        if (roster[p]?.pos === "D") { if (d >= 2) continue; d++; }
        unit.push(p);
      }
      if (unit.length < 4) break;
      unit.forEach((p) => used.add(p));
      ppUnits.push({ ids: unit, ppSecPerGame: Math.round(Math.min(...unit.map(ppAvg))), basis: "last season PP TOI" });
    }
  } else {
  // PP units: greedy clique on PP pair time.
    
    const usedPP = new Set();
    for (let u = 0; u < 2; u++) {
      const cand = pool0.filter((p) => !usedPP.has(p) && (pp.solo[p] ?? 0) > 0).sort((a, b) => (pp.solo[b] ?? 0) - (pp.solo[a] ?? 0));
      if (!cand.length) break;
      const unit = [cand[0]];
      while (unit.length < 5) {
        let best = null, bv = 0;
        for (const c of cand) {
          if (unit.includes(c)) continue;
          const v = Math.min(...unit.map((m) => pp.pair[pairKey(m, c)] ?? 0));
          if (v > bv) { bv = v; best = c; }
        }
        if (!best) break;
        unit.push(best);
      }
      if (unit.length < 4) break;
      unit.forEach((p) => usedPP.add(p));
      ppUnits.push({ ids: unit, ppSecPerGame: Math.round(Math.min(...unit.map((p) => pp.solo[p] ?? 0)) / nGamesW) });
    }
  }
  return { F: lines, D: pairs, PP: ppUnits };
}

const lines = {};     // team -> {F, D, PP, source}
const rosterAdds = {}; // team -> Set of regulars added without shift data
const dressedByTeam = {}; // team -> Set of projected dressed skaters
const pairShared = {}; // team -> {pairKey: esSecPerGame}, {trioKey: sec}
await pool([...slateTeams], 4, async (team) => {
  const games = await recentGameIds(team);
  if (!games.length) return;
  const acc = { es: { solo: {}, pair: {}, trio: {} }, pp: { solo: {}, pair: {}, trio: {} } };
  const weights = [1, 0.5, 0.25];
  let dressedLatest = null, wsum = 0, bestScore = -1;
  for (let i = 0; i < games.length; i++) {
    const rows = await gameShifts(games[i].id);
    if (!rows.length) continue;
    const d = analyzeGame(rows, team, weights[i], acc);
    if (d) { wsum += weights[i]; if (!dressedLatest || (games[i].score ?? 0) > bestScore) { dressedLatest = new Set(d); bestScore = games[i].score ?? 0; } }
  }
  if (!dressedLatest) return;
  // Before regular-season games exist, top up with established regulars
  // (15+ min TOI last season) who sat out the selected preseason games.
  const regCount = games.filter((g) => g.type === 2).length;
  const flagged = new Set();
  if (regCount < 1) {
    for (const [id, r] of Object.entries(roster)) {
      const pid = Number(id);
      if (r.team !== team || goalieIds.has(pid) || dressedLatest.has(pid)) continue;
      if ((prevToi[pid] ?? 0) >= 15 * 60) { dressedLatest.add(pid); flagged.add(pid); }
    }
  }
  dressedByTeam[team] = dressedLatest;
  rosterAdds[team] = flagged;
  const L = buildLines(team, acc, dressedLatest, wsum || 1, regCount < 1);
  L.source = games.map((g) => ({ id: g.id, date: g.date, type: g.type === 1 ? "PRE" : "REG" }));
  L.added = [...flagged];
  lines[team] = L;
  const sh = {};
  for (const [k, v] of Object.entries(acc.es.pair)) sh[k] = Math.round(v / wsum);
  for (const [k, v] of Object.entries(acc.es.trio)) sh[k] = Math.round(v / wsum);
  pairShared[team] = sh;
});
console.log("lines built", Object.keys(lines).length);

// ---------------------------------------------------------------- 5b. Daily Faceoff projected lines + starting goalies
const slugify = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\./g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const normName = (x) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const abbrToSlug = {}, slugToAbbr = {};
for (const t of standings.standings) { const sl = slugify(t.teamName.default); abbrToSlug[t.teamAbbrev.default] = sl; slugToAbbr[sl] = t.teamAbbrev.default; }
async function fetchDFO(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36" } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    return m ? JSON.parse(m[1])?.props?.pageProps ?? null : null;
  } catch { return null; }
}
function matchPlayer(team, name) {
  const n = normName(name);
  const ids = Object.entries(roster).filter(([, r]) => r.team === team);
  let hit = ids.find(([, r]) => normName(r.name) === n);
  if (!hit) { const last = normName(name.split(" ").slice(-1)[0]); const c = ids.filter(([, r]) => normName(r.name.split(" ").slice(-1)[0]) === last); if (c.length === 1) hit = c[0]; }
  return hit ? Number(hit[0]) : null;
}
const dfoInfo = {}; // team -> {updatedAt, source, pos:{pid:'L'|'C'|'R'|'LD'|'RD'}, injured:[{name,status}]}
const POSMAP = { lw: "L", c: "C", rw: "R", ld: "LD", rd: "RD" };
await pool([...slateTeams], 4, async (team) => {
  const pp = await fetchDFO(`https://www.dailyfaceoff.com/teams/${abbrToSlug[team]}/line-combinations`);
  const c = pp?.combinations;
  if (!c?.players?.length) return;
  const grp = {}; const posOf = {}; const injured = []; let unmatched = 0;
  for (const x of c.players) {
    if (x.categoryIdentifier === "oi" || x.groupIdentifier === "ir") { injured.push({ name: x.name, status: x.injuryStatus ?? "out" }); continue; }
    const pid = matchPlayer(team, x.name);
    if (!pid) { unmatched++; continue; }
    (grp[x.groupIdentifier] ??= []).push({ pid, pos: x.positionIdentifier });
    if (POSMAP[x.positionIdentifier]) posOf[pid] = POSMAP[x.positionIdentifier];
  }
  const ord = (arr, o) => [...(arr ?? [])].sort((a, b) => o.indexOf(a.pos) - o.indexOf(b.pos)).map((x) => x.pid);
  const F = ["f1", "f2", "f3", "f4"].map((k) => ord(grp[k], ["lw", "c", "rw"])).filter((ids) => ids.length);
  const D = ["d1", "d2", "d3"].map((k) => ord(grp[k], ["ld", "rd"])).filter((ids) => ids.length);
  const PP = ["pp1", "pp2"].map((k) => (grp[k] ?? []).map((x) => x.pid)).filter((ids) => ids.length >= 4);
  if (F.length < 3 || D.length < 2) return;
  const sh = pairShared[team] ?? {};
  const key = (ids) => [...ids].sort((a, b) => a - b).join("-");
  const old = lines[team];
  lines[team] = {
    F: F.map((ids) => ({ ids, esSecPerGame: sh[key(ids)] ?? 0 })),
    D: D.map((ids) => ({ ids, esSecPerGame: sh[key(ids)] ?? 0 })),
    PP: PP.map((ids) => ({ ids, ppSecPerGame: null })),
    source: old?.source ?? [], added: [], dfo: { updatedAt: c.updatedAt, source: c.sourceName, unmatched },
  };
  dressedByTeam[team] = new Set([...F.flat(), ...D.flat()]);
  rosterAdds[team] = new Set();
  const g1 = (grp.g ?? []).find((x) => x.pos === "g1");
  dfoInfo[team] = { updatedAt: c.updatedAt, source: c.sourceName, pos: posOf, injured, g1: g1?.pid ?? null };
});
console.log("DFO lines", Object.keys(dfoInfo).length, "/", slateTeams.size);
const goalieOverride = {}; // date -> team -> {id,name,status}
for (const date of slateDates) {
  const pp = await fetchDFO(`https://www.dailyfaceoff.com/starting-goalies/${date}`);
  for (const g of pp?.data ?? []) {
    for (const side of ["home", "away"]) {
      const team = slugToAbbr[g[`${side}TeamSlug`]]; const name = g[`${side}GoalieName`];
      if (!team || !name) continue;
      const id = matchPlayer(team, name);
      (goalieOverride[date] ??= {})[team] = { id, name, status: g[`${side}NewsStrengthName`] ?? "Unconfirmed" };
    }
  }
}
console.log("DFO goalies", JSON.stringify(Object.fromEntries(Object.entries(goalieOverride).map(([d, x]) => [d, Object.keys(x).length]))));

// Season build products (rankings, live context, learned multipliers)
const seasonTeams = readJSON("hockey-teams.json", null);
const backtest = readJSON("hockey-backtest.json", null);
const LIVE = seasonTeams?.live ?? null;
const MULT = backtest?.mult ?? null, PLATT = backtest?.platt ?? null, STACK_LIFT = backtest?.stackLift ?? {};
const logit = (p) => Math.log(p / (1 - p)), sigm = (z) => 1 / (1 + Math.exp(-z));
const platt = (m, p) => (PLATT?.[m] ? sigm(PLATT[m][0] + PLATT[m][1] * logit(clamp(p, 0.002, 0.998))) : p);

// ---------------------------------------------------------------- 6. NHL Edge (cached)
const edgeCache = readJSON("hockey-edge-cache.json", {});
async function edgeFor(pid) {
  const c = edgeCache[pid];
  if (c && c.fetched === today) return c;
  const d = await fetchJSON(`${WEB}/edge/skater-detail/${pid}/${PREV}/2`);
  const hi = (d?.sogSummary ?? []).find((x) => x.locationCode === "high");
  const all = (d?.sogSummary ?? []).find((x) => x.locationCode === "all");
  const out = {
    fetched: today,
    shotSpeed: d?.topShotSpeed?.imperial ?? null, shotSpeedPct: d?.topShotSpeed?.percentile ?? null,
    skateSpeed: d?.skatingSpeed?.speedMax?.imperial ?? null, skateSpeedPct: d?.skatingSpeed?.speedMax?.percentile ?? null,
    hdShots: hi?.shots ?? null, hdShotsPct: hi?.shotsPercentile ?? null, hdGoals: hi?.goals ?? null,
    shots: all?.shots ?? null, shPct: all?.shootingPctg ?? null,
    ozPct: d?.zoneTimeDetails?.offensiveZonePctg ?? null, ozPctile: d?.zoneTimeDetails?.offensiveZonePercentile ?? null,
    gp: d?.player?.gamesPlayed ?? null,
  };
  edgeCache[pid] = out;
  return out;
}

// ---------------------------------------------------------------- 7. model
function goalieSvOf(id) {
  const all = (goalieLogs[id] ?? []).slice(0, 40);
  const sa = all.reduce((a, x) => a + x.sa, 0), sv = all.reduce((a, x) => a + x.sv, 0);
  return { svPct: sa ? r3(sv / sa) : null, gp: all.length };
}
function likelyGoalie(team, date) {
  const o = goalieOverride[date]?.[team];
  if (o?.id) return { id: o.id, name: roster[o.id]?.name ?? o.name, status: o.status, ...goalieSvOf(o.id) };
  const dg = dfoInfo[team]?.g1;
  if (dg) return { id: dg, name: roster[dg]?.name, status: "Projected", ...goalieSvOf(dg) };
  const ids = Object.keys(goalieLogs).filter((id) => roster[id]?.team === team);
  let best = null;
  for (const id of ids) {
    const recent = goalieLogs[id].filter((x) => x.team === team).slice(0, 10);
    const starts = recent.reduce((a, x) => a + (x.gs ?? 0), 0);
    const all = goalieLogs[id].slice(0, 40);
    const sa = all.reduce((a, x) => a + x.sa, 0), sv = all.reduce((a, x) => a + x.sv, 0);
    const score = starts * 10 + all.length;
    if (!best || score > best.score) best = { id: Number(id), name: roster[id].name, score, svPct: sa ? r3(sv / sa) : null, gp: all.length, status: "Model guess" };
  }
  return best;
}
const addDaysY = (ymd, n) => addDays(ymd, n);
function roleOf(pid, team) {
  const r = dfoInfo[team]?.pos?.[pid] ?? seasonTeams?.roles?.[pid] ?? roster[pid]?.pos;
  return r === "D" ? "D" : r;
}
const posGroup = (r) => (r === "LD" || r === "RD" ? "D" : r);
function playedYesterday(team, date) {
  const y = addDaysY(date, -1);
  if (LIVE?.lastPlayed?.[team] === y) return true;
  return (gamesByDate[y] ?? []).some((g) => g.away === team || g.home === team);
}
// Pass 1: context-adjusted base lambdas
function baseModel(pid, team, oppTeam, home, date) {
  const rows = (logsByPlayer.get(pid) ?? []);
  const isD = roster[pid]?.pos === "D";
  const b = baseLambdas(rows, isD, { isCur: (r) => r.s === CUR, K: 5 });
  const L = LIVE?.league, o = LIVE?.teams?.[oppTeam], own = LIVE?.teams?.[team];
  const oc = o ?? teamCtx[oppTeam]?.blend ?? lg, lgc = L ?? lg;
  const og = likelyGoalie(oppTeam, date);
  const svOpp = og?.svPct && og.gp >= 10 ? 0.6 * og.svPct + 0.4 * oc.svPct : oc.svPct;
  const ctx = { oppGA: Math.pow(oc.gapg / lgc.gapg, 0.85), oppSA: oc.sapg / lgc.sapg, oppSV: (1 - svOpp) / (1 - lgc.svPct), home };
  const lam = applyContext(b, ctx);
  const role = posGroup(roleOf(pid, team));
  const fx = {
    oppGA: ctx.oppGA, oppPos: o?.posA?.[role] && L?.posA?.[role] ? o.posA[role] / L.posA[role] : null,
    ppEnv: o?.ppgA != null && L?.ppgA ? o.ppgA / Math.max(0.05, L.ppgA) : null, goalie: ctx.oppSV,
    b2b: playedYesterday(team, date), oppB2b: playedYesterday(oppTeam, date), home,
    toiR: b.toiR, sogR: b.sogR, hotR: b.hotR, mates: null,
    pace: own && o && L ? (own.gfpg + o.gapg) / (2 * L.gapg) : null,
  };
  return { b, ctx, lam, fx, og, svOpp, oc, role };
}
// Pass 2: add slot / PP / linemates -> learned multipliers -> calibrated probabilities
function playerModel(base, lineInfo, matesLam) {
  const { lam, ctx, fx, og, svOpp, oc } = base;
  fx.slot = lineInfo?.unit === "F" && lineInfo.line ? `L${lineInfo.line}` : lineInfo?.unit === "D" && lineInfo.line ? `D${lineInfo.line}` : "";
  fx.pu = lineInfo?.pp ?? 0;
  fx.mates = matesLam;
  const bk = bucketsOf(fx);
  const mP = multFor(MULT, "pts", bk), mG = multFor(MULT, "g", bk), mS = multFor(MULT, "sog", bk);
  const lamT = { pts: lam.pts * mP, g: lam.g * mG, sog: lam.sog * mS };
  const pr = probsOf(lamT);
  const p1 = platt("p1", pr.p1), p2 = platt("p2", pr.p2), g1 = platt("g1", pr.g1), s3 = platt("s3", pr.s3);
  const val = { oppGA: fx.oppGA, oppPos: fx.oppPos, ppEnv: fx.pu ? fx.ppEnv : null, goalie: fx.goalie, toi: fx.toiR, mates: fx.mates, sogTrend: fx.sogR, hot: fx.hotR, pace: fx.pace };
  const fxOut = FACTOR_KEYS.map((k) => [k, bk[k], r3(val[k] ?? null), MULT?.pts?.[k]?.[bk[k]] ?? 1, MULT?.g?.[k]?.[bk[k]] ?? 1]);
  const why = [];
  if (lineInfo?.pp === 1) why.push("PP1");
  if (lineInfo?.line === 1) why.push(lineInfo.unit === "D" ? "Top pair" : "Top line");
  if (ctx.oppGA > 1.07) why.push(`Opp allows ${r1(oc.gapg)} GA/gm`);
  if (fx.oppPos != null && fx.oppPos > 1.08) why.push(`Opp soft vs ${base.role === "D" ? "D" : base.role}`);
  if (ctx.oppSV > 1.08) why.push(`Opp SV% ${svOpp.toFixed(3)}`);
  if (fx.oppB2b && !fx.b2b) why.push("Opp on B2B");
  if (fx.b2b) why.push("On B2B");
  if (fx.mates != null && fx.mates > 0.7) why.push("Elite linemates");
  if (fx.hotR != null && fx.hotR < 0.6) why.push("Slump: due (backtest)");
  return {
    lam: { pts: r3(lamT.pts), g: r3(lamT.g), sog: r3(lamT.sog) }, base: { pts: r3(lam.pts), g: r3(lam.g), sog: r3(lam.sog) },
    p1: r3(p1), p2: r3(p2), g1: r3(g1), s3: r3(s3), mult: { pts: r3(mP), g: r3(mG), sog: r3(mS) },
    factors: { oppGA: r3(ctx.oppGA), oppSA: r3(ctx.oppSA), oppSV: r3(ctx.oppSV), home: ctx.home ? 1.03 : 0.97, toi: r3(base.b.toiF) },
    fx: fxOut, goalie: og ? { id: og.id, name: og.name, sv: og.svPct, status: og.status } : null,
    why,
  };
}

// ---------------------------------------------------------------- 8. build slate
const players = {};  // pid -> board row
const stacks = [];   // ranked stacks
const edgePids = [];
for (const [date, games] of Object.entries(gamesByDate)) {
  for (const g of games) {
    for (const side of ["away", "home"]) {
      const team = g[side], opp = side === "away" ? g.home : g.away;
      const L = lines[team];
      const dressed = dressedByTeam[team];
      if (!L || !dressed) continue;
      const lineOf = {};
      L.F.forEach((l, i) => l.ids.forEach((p) => (lineOf[p] = { ...lineOf[p], line: i + 1, unit: "F" })));
      L.D.forEach((l, i) => l.ids.forEach((p) => (lineOf[p] = { ...lineOf[p], line: i + 1, unit: "D" })));
      L.PP.forEach((u, i) => u.ids.forEach((p) => (lineOf[p] = { ...lineOf[p], pp: i + 1 })));
      const bases = {};
      for (const pid of dressed) if (!goalieIds.has(pid) && roster[pid]?.team === team) bases[pid] = baseModel(pid, team, opp, side === "home", date);
      const matesOf = (pid) => {
        const info = lineOf[pid]; if (!info?.line) return null;
        const arr = (info.unit === "F" ? L.F : L.D)[info.line - 1]?.ids ?? [];
        const v = arr.filter((q) => q !== pid && bases[q]).map((q) => bases[q].lam.pts);
        return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
      };
      for (const pid of dressed) {
        if (goalieIds.has(pid) || roster[pid]?.team !== team) continue;
        const rows = logsByPlayer.get(pid) ?? [];
        const info = lineOf[pid] ?? {};
        const key = `${date}:${pid}`;
        players[key] = {
          pid, date, gid: g.id, name: roster[pid].name, team, opp, home: side === "home" ? 1 : 0,
          pos: roster[pid].pos, num: roster[pid].num, unit: info.unit ?? (roster[pid].pos === "D" ? "D" : "F"),
          line: info.line ?? null, pp: info.pp ?? null,
          noShift: rosterAdds[team]?.has(pid) ? 1 : 0,
          w: {
            prev: windowAgg(rows.filter((r) => r.s === PREV)),
            cur: windowAgg(rows.filter((r) => r.s === CUR)),
            l20: windowAgg(rows.slice(0, 20)), l10: windowAgg(rows.slice(0, 10)), l5: windowAgg(rows.slice(0, 5)),
          },
          log: rows.slice(0, 10).map((r) => [r.d, r.opp, r.g, r.a, r.pts, r.sog, r1(r.toi / 60), r1(r.pptoi / 60)]),
          role: roleOf(pid, team),
          m: playerModel(bases[pid], info, matesOf(pid)),
        };
        edgePids.push(pid);
      }
      // --- stacks for this team
      const members = new Set();
      L.F.slice(0, 2).forEach((l) => l.ids.forEach((p) => members.add(p)));
      (L.PP[0]?.ids ?? []).forEach((p) => members.add(p));
      const mem = [...members].filter((p) => players[`${date}:${p}`]);
      const combos = [];
      for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) {
        combos.push([mem[i], mem[j]]);
        for (let k = j + 1; k < mem.length; k++) combos.push([mem[i], mem[j], mem[k]]);
      }
      for (const ids of combos) {
        const P = ids.map((p) => players[`${date}:${p}`]);
        // Kind: same F line, PP1, or mixed.
        const sameLine = P.every((x) => x.unit === "F" && x.line != null && x.line === P[0].line);
        const allPP1 = P.every((x) => x.pp === 1);
        if (!sameLine && !allPP1) continue;
        const kind = sameLine ? `L${P[0].line}${allPP1 ? "+PP1" : ""}` : "PP1";
        // Games together: same gameId for all, same team.
        const logs = ids.map((p) => new Map((logsByPlayer.get(p) ?? []).filter((r) => r.team === team).map((r) => [r.gid, r])));
        const common = [...logs[0].keys()].filter((gid) => logs.every((m) => m.has(gid)))
          .map((gid) => ({ gid, d: logs[0].get(gid).d, rs: logs.map((m) => m.get(gid)) }))
          .sort((a, b) => (a.d < b.d ? 1 : -1));
        const variants = [ids.map(() => 1)];
        // Star 2+ variant for pairs when one member has a strong 2+ profile.
        if (ids.length === 2) P.forEach((x, i) => { if (x.m.p2 >= 0.3) variants.push(ids.map((_, j) => (j === i ? 2 : 1))); });
        for (const legs of variants) {
          const hit = (c) => c.rs.every((r, i) => r.pts >= legs[i]);
          const indivEmp = (i) => { const n = common.length || 1; return common.filter((c) => c.rs[i].pts >= legs[i]).length / n; };
          const n = common.length;
          const jointHits = common.filter(hit).length;
          const l20 = common.slice(0, 20), l10 = common.slice(0, 10);
          const indepEmp = legs.reduce((a, _, i) => a * indivEmp(i), 1) || 1e-6;
          const Kp = 12;
          const kindKey = `${kind.replace(/^L\d/, "L1")} ${ids.length === 2 ? "pair" : "trio"}`;
          const prior = STACK_LIFT[kindKey]?.lift ?? 1.2;
          const lift = clamp(((jointHits + Kp * indepEmp * prior) / (n + Kp)) / indepEmp, 0.7, 2.6);
          const modelIndiv = P.map((x, i) => (legs[i] === 2 ? x.m.p2 : x.m.p1));
          const model = clamp(modelIndiv.reduce((a, b) => a * b, 1) * lift, 0, 0.95);
          const sk = ids.length === 3 ? [...ids].sort((a, b) => a - b).join("-") : pairKey(ids[0], ids[1]);
          stacks.push({
            date, gid: g.id, team, opp, kind,
            legs: ids.map((p, i) => ({ pid: p, name: roster[p].name, pos: roster[p].pos, need: legs[i], p: modelIndiv[i] })),
            n, jointAll: n ? r3(jointHits / n) : null,
            joint20: l20.length ? r3(l20.filter(hit).length / l20.length) : null, n20: l20.length,
            joint10: l10.length ? r3(l10.filter(hit).length / l10.length) : null, n10: l10.length,
            lift: r3(lift), prior: r3(prior), model: r3(model), indep: r3(modelIndiv.reduce((a, b) => a * b, 1)),
            esShareSec: pairShared[team]?.[sk] ?? null,
          });
        }
      }
    }
  }
}
await pool([...new Set(edgePids)], 10, async (pid) => {
  const e = await edgeFor(pid);
  for (const k of Object.keys(players)) if (players[k].pid === pid) players[k].edge = e;
});
fs.writeFileSync("hockey-edge-cache.json", JSON.stringify(edgeCache));
stacks.sort((a, b) => b.model - a.model);
// Keep top 6 per team per date (by model) to bound size.
const perTeam = {};
const stacksTop = stacks.filter((s) => { const k = `${s.date}:${s.team}`; perTeam[k] = (perTeam[k] ?? 0) + 1; return perTeam[k] <= 8; });

// ---- edge flags stored with each snapshot (so the lookback grades what the board showed pre-game)
function edgeFlagsFactory() {
  const GF = readJSON("hockey-goalies.json", null);
  const TT = seasonTeams?.teams ?? {};
  const gps = Object.values(TT).map((x) => x.cur?.gp ?? 0);
  const w = Object.values(TT).some((x) => x.blend) ? "blend" : gps.length && Math.min(...gps) >= 10 ? "cur" : "prev";
  const n = Object.keys(TT).length || 32;
  const rk = {};
  for (const rg of ["C", "L", "R", "D"]) {
    const arr = Object.entries(TT).map(([t, x]) => [t, x[w]?.a?.role?.[rg]?.[0]]).filter(([, v]) => v != null && isFinite(v)).sort((a, b) => b[1] - a[1]);
    arr.forEach(([t], i) => ((rk[t] ??= {})[rg] = i + 1));
  }
  const hotB = new Set(["high", "vhigh"]);
  return (p, date) => {
    const rg = p.role === "LD" || p.role === "RD" ? "D" : p.role ?? (p.unit === "D" ? "D" : p.pos);
    const posRank = rk[p.opp]?.[rg] ?? null;
    const posGreen = posRank != null && 1 - (posRank - 1) / Math.max(1, n - 1) >= 0.7 ? 1 : 0;
    let gid = null; try { gid = likelyGoalie(p.opp, date)?.id ?? null; } catch {}
    const g = gid && GF ? GF.goalies[gid] : null;
    const svEdge = g && g.sv != null ? GF.league.sv - g.sv : 0;
    const gGreen = g && (-g.gsax60 >= 0.15 || svEdge >= 0.012) ? 1 : 0;
    const fx = p.m?.fx ?? [];
    const heat = fx.some((f) => (f[0] === "hot" || f[0] === "sogTrend") && hotB.has(f[1])) ? 1 : 0;
    return { role: p.role ?? null, posRank, gId: gid, gsax60: g ? g.gsax60 : null, posGreen, gGreen, heat, fx: fx.map((f) => [f[0], f[1]]) };
  };
}
// ---------------------------------------------------------------- 9. picks snapshot + grading
const picks = readJSON("hockey-picks.json", { version: 1, days: {} });
const allGames = Object.values(gamesByDate).flat();
const started = (g) => !["FUT", "PRE"].includes(g.state);
const edgeFlags = edgeFlagsFactory();
// grades (same engine as the site): [OFF, MU, DEF, DMU, MU team-only, DMU team-only] scores 0-100
const gradeOf = (() => {
  try {
    const T = seasonTeams, G = readJSON("hockey-goalies.json", null), ST = readJSON("hockey-special.json", null), M = readJSON("hockey-matchups.json", null);
    if (!T) return () => null;
    const teamsG = {};
    for (const t of slateTeams) { const gd = Object.fromEntries(slateDates.map((d) => [d, likelyGoalie(t, d)])); teamsG[t] = { goalieByDate: gd, goalie: gd[today] ?? null }; }
    const data = { teams: teamsG, lines, players: Object.values(players) };
    const ctx = buildGradeCtx(T, G, ST, M), ctxT = { ...ctx, teamOnly: true };
    return (p) => {
      try {
        const a = gradePlayer(p, data, ctx), b = gradePlayer(p, data, ctxT);
        return [a.off?.score ?? null, a.mu?.score ?? null, a.def?.score ?? null, a.dmu?.score ?? null, b.mu?.score ?? null, b.dmu?.score ?? null];
      } catch { return null; }
    };
  } catch (e) { console.log("grades unavailable", e.message); return () => null; }
})();
for (const g of allGames) {
  const day = (picks.days[g.date] ??= { games: {} });
  const gp = day.games[g.id];
  if (gp?.locked) continue;
  if (started(g) && gp) { gp.locked = true; gp.lockedAt = new Date().toISOString(); continue; }
  if (started(g) && !gp) continue; // never snapshot after puck drop
  const rows = Object.values(players).filter((p) => p.gid === g.id);
  day.games[g.id] = {
    away: g.away, home: g.home, startUTC: g.startUTC, snapAt: new Date().toISOString(), locked: false,
    players: rows.map((p) => [p.pid, p.name, p.team, p.pos, p.line, p.pp, p.m.p1, p.m.p2, p.m.g1, p.m.s3, { ...edgeFlags(p, g.date), gr: gradeOf(p) }]),
    stacks: stacksTop.filter((s) => s.gid === g.id).slice(0, 8)
      .map((s) => ({ kind: s.kind, team: s.team, legs: s.legs.map((l) => [l.pid, l.need]), model: s.model })),
  };
}
// Grade any ungraded game whose date <= today.
const toGrade = [];
for (const [date, day] of Object.entries(picks.days)) {
  for (const [gid, gp] of Object.entries(day.games)) if (!gp.graded && date <= today) toGrade.push([date, gid, gp]);
}
await pool(toGrade, 6, async ([date, gid, gp]) => {
  const box = await fetchJSON(`${WEB}/gamecenter/${gid}/boxscore`);
  if (!box || !["OFF", "FINAL"].includes(box.gameState)) return;
  const res = {};
  for (const side of ["awayTeam", "homeTeam"]) {
    for (const grp of ["forwards", "defense"]) {
      for (const p of box.playerByGameStats?.[side]?.[grp] ?? []) {
        res[p.playerId] = [p.goals ?? 0, p.assists ?? 0, p.points ?? 0, p.sog ?? 0, mmss(p.toi)];
      }
    }
  }
  gp.result = res; // pid -> [g,a,pts,sog,toiSec]; missing pid = did not play (void)
  gp.final = { away: box.awayTeam?.score, home: box.homeTeam?.score };
  gp.graded = true; gp.locked = true;
});
fs.writeFileSync("hockey-picks.json", JSON.stringify(picks));

// ---------------------------------------------------------------- 10. write hockey.json
const teamOut = {};
for (const t of slateTeams) {
  const gd = Object.fromEntries(slateDates.map((d) => [d, likelyGoalie(t, d)]));
  teamOut[t] = { ...teamCtx[t], blend: undefined, goalie: gd[today] ?? gd[slateDates[1]], goalieByDate: gd, dfo: dfoInfo[t] ? { updatedAt: dfoInfo[t].updatedAt, source: dfoInfo[t].source, injured: dfoInfo[t].injured } : null };
}
const out = {
  refreshedAt: new Date().toISOString(), today, dates: slateDates, seasons: { prev: PREV, cur: CUR },
  league: { gapg: r3(lg.gapg), sapg: r1(lg.sapg), svPct: r3(lg.svPct) },
  games: gamesByDate, teams: teamOut, lines, players: Object.values(players), stacks: stacksTop,
};
fs.writeFileSync("hockey.json", JSON.stringify(out));
console.log("wrote hockey.json", (fs.statSync("hockey.json").size / 1024).toFixed(0), "KB; players", out.players.length, "stacks", stacksTop.length,
  "; picks", (fs.statSync("hockey-picks.json").size / 1024).toFixed(0), "KB");
