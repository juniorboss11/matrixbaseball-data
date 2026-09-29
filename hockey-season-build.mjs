// MatrixHockey season build: team rankings (by position + line slot), line units,
// shot maps, walk-forward backtest, factor lab + learned multipliers.
// Reads hockey-season-cache.json -> writes hockey-teams.json, hockey-shots.json, hockey-backtest.json
import fs from "node:fs";
import {
  FACTOR_KEYS, bucketsOf, multFor, factorMeta, decayW, baseLambdas, applyContext, probs, clamp, poisGE,
} from "./hockey-factors.mjs";

const WEB = "https://api-web.nhle.com/v1";
const PREV = "20252026", CUR = "20262027";
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
async function fetchJSON(url) { for (let i = 0; i < 4; i++) { try { const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 MatrixHockey" } }); if (r.ok) return await r.json(); } catch {} await new Promise((res) => setTimeout(res, 1000 * (i + 1))); } return null; }

const cache = JSON.parse(fs.readFileSync("hockey-season-cache.json", "utf8"));
const games = Object.entries(cache.games).map(([id, g]) => ({ id: +id, ...g })).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.id - b.id));
console.log("games", games.length);

// Current rosters (names + current team)
const standings = await fetchJSON(`${WEB}/standings/now`);
const TEAMS = [...new Set((standings?.standings ?? []).map((t) => t.teamAbbrev.default))].sort();
const roster = {};
await Promise.all(TEAMS.map(async (t) => {
  const r = await fetchJSON(`${WEB}/roster/${t}/current`);
  for (const grp of ["forwards", "defensemen", "goalies"]) for (const p of r?.[grp] ?? [])
    roster[p.id] = { name: `${p.firstName.default} ${p.lastName.default}`, team: t, pos: p.positionCode, shoots: p.shootsCatches };
}));

if (TEAMS.length < 30 || Object.keys(roster).length < 600) throw new Error(`roster/standings fetch incomplete: ${TEAMS.length} teams, ${Object.keys(roster).length} players`);
// ---------------------------------------------------------------- roles (C/L/R/D)
// Season-level lateral side from shot y (attacking +x: left side = +y).
const ySum = {}, yN = {};
for (const g of games) for (const e of g.ev) if (e[2] != null && e[2] > 25 && e[1]) { ySum[e[1]] = (ySum[e[1]] ?? 0) + e[3]; yN[e[1]] = (yN[e[1]] ?? 0) + 1; }
const sideScore = (pid) => (yN[pid] >= 8 ? ySum[pid] / yN[pid] : roster[pid]?.shoots === "L" ? 1 : roster[pid]?.shoots === "R" ? -1 : 0);
function gameRoles(g) {
  const role = {};
  for (const sd of [0, 1]) {
    const bySlot = {};
    for (const [pid, x] of Object.entries(g.p)) if (x[0] === sd && x[8]) (bySlot[x[8]] ??= []).push(+pid);
    for (const [slot, ids] of Object.entries(bySlot)) {
      if (slot.startsWith("D")) {
        const s = [...ids].sort((a, b) => sideScore(b) - sideScore(a));
        s.forEach((p, i) => (role[p] = i === 0 ? "LD" : "RD"));
        continue;
      }
      const fo = (p) => g.p[p][10] ?? 0;
      let c = [...ids].sort((a, b) => fo(b) - fo(a))[0];
      if (fo(c) < 3) c = ids.find((p) => g.p[p][1] === "C") ?? c;
      const w = ids.filter((p) => p !== c);
      role[c] = "C";
      if (w.length === 2) {
        const [a, b] = w; const la = g.p[a][1], lb = g.p[b][1];
        if (la === "L" && lb !== "L") { role[a] = "L"; role[b] = "R"; }
        else if (la === "R" && lb !== "R") { role[a] = "R"; role[b] = "L"; }
        else if (lb === "L" && la !== "L") { role[b] = "L"; role[a] = "R"; }
        else if (lb === "R" && la !== "R") { role[b] = "R"; role[a] = "L"; }
        else if (sideScore(a) >= sideScore(b)) { role[a] = "L"; role[b] = "R"; } else { role[a] = "R"; role[b] = "L"; }
      } else w.forEach((p) => (role[p] = g.p[p][1] === "C" ? (sideScore(p) >= 0 ? "L" : "R") : g.p[p][1]));
    }
    for (const [pid, x] of Object.entries(g.p)) if (x[0] === sd && !role[pid]) role[pid] = x[1] === "D" ? (sideScore(+pid) >= 0 ? "LD" : "RD") : x[1] === "G" ? "G" : x[1];
  }
  return role;
}
const posGroup = (r) => (r === "LD" || r === "RD" ? "D" : r);

// ---------------------------------------------------------------- per team-game records
const SLOTS = ["L1", "L2", "L3", "L4", "D1", "D2", "D3", "PP1", "PP2"];
const ROLES = ["C", "L", "R", "D"];
const tg = {}; // team -> [{d, s, gid, opp, home, f:{...}, a:{...}}]
const roleCount = {}; // pid -> {C: n, L: n, ...}
for (const g of games) {
  const role = gameRoles(g);
  g.role = role;
  for (const [pid, r] of Object.entries(role)) { const rc = (roleCount[pid] ??= {}); rc[r] = (rc[r] ?? 0) + 1; rc._last = r; }
  const blank = () => ({ g: 0, pts: 0, sog: 0, ppg: 0, pen: 0, role: Object.fromEntries(ROLES.map((r) => [r, [0, 0, 0]])), slot: Object.fromEntries(SLOTS.map((s) => [s, [0, 0, 0]])) });
  const side = [blank(), blank()]; // offense produced by side
  for (const e of g.ev) {
    const [own, shooter, , , goal, str, a1, a2] = e;
    const S = side[own];
    const bucket = (pid) => {
      const x = g.p[pid]; if (!x) return null;
      if (str === "p") return x[9] ? `PP${x[9]}` : null;
      if (str === "e") return x[8] || null;
      return null;
    };
    const credit = (pid, gi) => {
      const x = g.p[pid]; if (!x) return;
      const rg = posGroup(role[pid] ?? x[1]);
      if (S.role[rg]) { S.role[rg][0]++; if (gi) S.role[rg][1]++; }
      const b = bucket(pid); if (b && S.slot[b]) { S.slot[b][0]++; if (gi) S.slot[b][1]++; }
    };
    if (shooter && g.p[shooter]) {
      const rg = posGroup(role[shooter] ?? g.p[shooter][1]);
      if (S.role[rg]) S.role[rg][2]++;
      const b = bucket(shooter); if (b && S.slot[b]) S.slot[b][2]++;
      S.sog++;
    }
    if (goal) {
      S.g++; if (str === "p") S.ppg++;
      if (shooter) credit(shooter, true);
      for (const a of [a1, a2]) if (a) credit(a, false);
      S.pts += (shooter ? 1 : 0) + (a1 ? 1 : 0) + (a2 ? 1 : 0);
    }
  }
  side[0].pen = g.pen[0]; side[1].pen = g.pen[1];
  const teams = [g.a, g.h];
  for (const sd of [0, 1]) {
    (tg[teams[sd]] ??= []).push({ d: g.d, s: g.s, gid: g.id, opp: teams[1 - sd], home: sd, f: side[sd], a: side[1 - sd] });
  }
}

// ---------------------------------------------------------------- team windows + rankings
function packWin(rows) {
  if (!rows.length) return null;
  const n = rows.length;
  const agg = (k) => {
    const o = { g: 0, pts: 0, sog: 0, ppg: 0, pen: 0, role: {}, slot: {} };
    for (const r of rows) {
      const x = r[k];
      o.g += x.g; o.pts += x.pts; o.sog += x.sog; o.ppg += x.ppg; o.pen += x.pen;
      for (const q of ROLES) { const t = (o.role[q] ??= [0, 0, 0]); x.role[q].forEach((v, i) => (t[i] += v)); }
      for (const q of SLOTS) { const t = (o.slot[q] ??= [0, 0, 0]); x.slot[q].forEach((v, i) => (t[i] += v)); }
    }
    return {
      g: r3(o.g / n), pts: r3(o.pts / n), sog: r2(o.sog / n), ppg: r3(o.ppg / n), pen: r2(o.pen / n),
      role: Object.fromEntries(ROLES.map((q) => [q, o.role[q].map((v) => r3(v / n))])),
      slot: Object.fromEntries(SLOTS.map((q) => [q, o.slot[q].map((v) => r3(v / n))])),
    };
  };
  const f = agg("f"), a = agg("a");
  // PK%: 1 - PP goals allowed / opp PP chances (opp chances ~ our penalties)
  const penTaken = rows.reduce((s, r) => s + r.f.pen, 0), ppgA = rows.reduce((s, r) => s + r.a.ppg, 0);
  const penDrawn = rows.reduce((s, r) => s + r.a.pen, 0), ppgF = rows.reduce((s, r) => s + r.f.ppg, 0);
  return { gp: n, f, a, pk: penTaken ? r3(1 - ppgA / penTaken) : null, pp: penDrawn ? r3(ppgF / penDrawn) : null };
}
const teamsOut = {};
for (const t of TEAMS) {
  const rows = [...(tg[t] ?? [])].sort((a, b) => (a.d < b.d ? 1 : -1)); // newest first
  teamsOut[t] = {
    prev: packWin(rows.filter((r) => r.s === PREV)), cur: packWin(rows.filter((r) => r.s === CUR)),
    l10: packWin(rows.slice(0, 10)), l20: packWin(rows.slice(0, 20)),
  };
}

// ---------------------------------------------------------------- line units (last 40 team games)
const unitsOut = {};
for (const t of TEAMS) {
  const rows = [...(tg[t] ?? [])].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 40);
  const gids = new Set(rows.map((r) => r.gid));
  const acc = {};
  for (const gid of gids) {
    const g = cache.games[gid]; const sd = g.h === t ? 1 : 0;
    for (const [s, key, sec, gf, ga, sf, sa] of g.u) {
      if (s !== sd) continue;
      const u = (acc[key] ??= { sec: 0, gf: 0, ga: 0, sf: 0, sa: 0, gp: 0, pts: {}, last: g.d });
      u.sec += sec; u.gf += gf; u.ga += ga; u.sf += sf; u.sa += sa; u.gp++; if (g.d > u.last) u.last = g.d;
    }
  }
  const list = Object.entries(acc).map(([key, u]) => {
    const ids = key.slice(1).split("-").map(Number);
    return { kind: key[0], ids, ...u };
  }).filter((u) => u.ids.every((p) => roster[p]?.team === t) && u.sec >= 300);
  const per60 = (v, sec) => r2((v / sec) * 3600);
  const fmt = (u) => ({
    kind: u.kind, ids: u.ids, gp: u.gp, min: r2(u.sec / 60), minPg: r2(u.sec / 60 / u.gp), last: u.last,
    gf: u.gf, ga: u.ga, sf: u.sf, sa: u.sa,
    gf60: per60(u.gf, u.sec), ga60: per60(u.ga, u.sec), sf60: per60(u.sf, u.sec), sa60: per60(u.sa, u.sec),
  });
  unitsOut[t] = {
    F: list.filter((u) => u.kind === "F").sort((a, b) => b.sec - a.sec).slice(0, 10).map(fmt),
    D: list.filter((u) => u.kind === "D").sort((a, b) => b.sec - a.sec).slice(0, 6).map(fmt),
  };
}

// ---------------------------------------------------------------- shot grids
const X0 = 25, CS = 5, NX = 15, NY = 17;
const cell = (x, y) => { if (x == null || x < X0 || x >= 100) return -1; const xi = Math.floor((x - X0) / CS), yi = clamp(Math.floor((y + 42.5) / CS), 0, NY - 1); return xi * NY + yi; };
const shotTeams = {};
for (const t of TEAMS) {
  const rows = [...(tg[t] ?? [])].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 60);
  const o = { gp: rows.length, f: Array(NX * NY).fill(0), fg: Array(NX * NY).fill(0), a: Array(NX * NY).fill(0), ag: Array(NX * NY).fill(0) };
  for (const r of rows) {
    const g = cache.games[r.gid]; const sd = g.h === t ? 1 : 0;
    for (const e of g.ev) {
      if (e[5] === "n") continue;
      const c = cell(e[2], e[3]); if (c < 0) continue;
      if (e[0] === sd) { o.f[c]++; if (e[4]) o.fg[c]++; } else { o.a[c]++; if (e[4]) o.ag[c]++; }
    }
  }
  shotTeams[t] = o;
}
const pShots = {}; // pid -> {gp, cells:{c:[s,g]}}
const pGames = {};
for (const g of [...games].reverse()) {
  for (const pid of Object.keys(g.p)) { pGames[pid] = (pGames[pid] ?? 0) + 1; }
  for (const e of g.ev) {
    const pid = e[1]; if (!pid || (pGames[pid] ?? 0) > 82 || e[5] === "n") continue;
    const c = cell(e[2], e[3]); if (c < 0) continue;
    const o = (pShots[pid] ??= {}); const v = (o[c] ??= [0, 0]); v[0]++; if (e[4]) v[1]++;
  }
}
const shotPlayers = {};
for (const [pid, o] of Object.entries(pShots)) {
  if (!roster[pid]) continue;
  const tot = Object.values(o).reduce((a, v) => a + v[0], 0);
  if (tot < 15) continue;
  shotPlayers[pid] = [Math.min(82, pGames[pid] ?? 0), Object.entries(o).map(([c, v]) => [+c, v[0], v[1]])];
}

// ---------------------------------------------------------------- walk-forward backtest
const hist = {};  // pid -> newest-last [{pts,g,sog,toi,d}]
const thist = {}; // team -> newest-last [{ga,gf,sa,sf,pen,penDrawn,ppgA,roleA:{C,L,R,D}, d}]
const ghist = {}; // goalie -> newest-last [sa, ga]
const lastPlayed = {}; // team -> date
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
function teamBlend(t) {
  const rows = (thist[t] ?? []).slice(-120).reverse();
  if (!rows.length) return null;
  let W = 0; const s = { ga: 0, gf: 0, sa: 0, sf: 0, pen: 0, ppgA: 0, C: 0, L: 0, R: 0, D: 0 };
  rows.forEach((r, i) => {
    const w = decayW(i * 0.6); W += w;
    s.ga += w * r.ga; s.gf += w * r.gf; s.sa += w * r.sa; s.sf += w * r.sf; s.pen += w * r.pen; s.ppgA += w * r.ppgA;
    for (const q of ROLES) s[q] += w * r.roleA[q];
  });
  for (const k of Object.keys(s)) s[k] /= W;
  return { gapg: s.ga, gfpg: s.gf, sapg: s.sa, sfpg: s.sf, pen: s.pen, ppgA: s.ppgA, svPct: 1 - s.ga / Math.max(1, s.sa), posA: { C: s.C, L: s.L, R: s.R, D: s.D }, n: rows.length };
}
function leagueOf(blends) {
  const b = Object.values(blends).filter(Boolean);
  const m = (f) => b.reduce((a, x) => a + f(x), 0) / Math.max(1, b.length);
  return { gapg: m((x) => x.gapg), sapg: m((x) => x.sapg), svPct: m((x) => x.svPct), ppgA: m((x) => x.ppgA), posA: Object.fromEntries(ROLES.map((q) => [q, m((x) => x.posA[q])])) };
}
function goalieSv(gid) {
  const h = (ghist[gid] ?? []).slice(-40);
  const sa = h.reduce((a, x) => a + x[0], 0), ga = h.reduce((a, x) => a + x[1], 0);
  return h.length >= 10 && sa ? { sv: 1 - ga / sa, gp: h.length } : null;
}

const EVAL_FROM = "2025-11-01", SPLIT = "2026-02-01";
const bt = []; // rows
const stackRows = [];
const byDate = {};
for (const g of games) (byDate[g.d] ??= []).push(g);
for (const d of Object.keys(byDate).sort()) {
  const blends = Object.fromEntries(TEAMS.map((t) => [t, teamBlend(t)]));
  const lg = leagueOf(blends);
  const evalOn = d >= EVAL_FROM;
  for (const g of byDate[d]) {
    if (!evalOn || !g.shifts) continue;
    const teams = [g.a, g.h];
    // starter per side = goalie with most shots faced
    const starter = [null, null];
    for (const [gid, [defSide, sa]] of Object.entries(g.gl)) if (!starter[defSide] || sa > starter[defSide][1]) starter[defSide] = [+gid, sa];
    const lamBy = {};
    const rowsG = [];
    for (const [pidS, x] of Object.entries(g.p)) {
      if (x[1] === "G" || x[5] < 120) continue;
      const pid = +pidS, sd = x[0], team = teams[sd], opp = teams[1 - sd];
      const H = (hist[pid] ?? []).slice(-120).reverse();
      const isD = x[1] === "D";
      const b = baseLambdas(H, isD);
      const o = blends[opp] ?? lg;
      const gs = starter[1 - sd] ? goalieSv(starter[1 - sd][0]) : null;
      const svOpp = gs ? 0.6 * gs.sv + 0.4 * o.svPct : o.svPct;
      const ctx = { oppGA: Math.pow(o.gapg / lg.gapg, 0.85), oppSA: o.sapg / lg.sapg, oppSV: (1 - svOpp) / (1 - lg.svPct), home: sd === 1 };
      const lam = applyContext(b, ctx);
      const role = posGroup(g.role[pid] ?? x[1]);
      const own = blends[team] ?? lg;
      const fx = {
        slot: x[8], pu: x[9], oppGA: ctx.oppGA, oppPos: o.posA && lg.posA[role] ? o.posA[role] / lg.posA[role] : null,
        ppEnv: o.ppgA / Math.max(0.05, lg.ppgA), goalie: ctx.oppSV,
        b2b: lastPlayed[team] === addDays(d, -1), oppB2b: lastPlayed[opp] === addDays(d, -1), home: sd === 1,
        toiR: b.toiR, sogR: b.sogR, hotR: b.hotR, mates: null,
        pace: (own.gfpg + o.gapg) / (2 * lg.gapg),
      };
      lamBy[pid] = { lam, x, fx, sd, role, n: b.n };
    }
    // linemate quality
    for (const [pid, r] of Object.entries(lamBy)) {
      const slot = r.x[8]; if (!slot) continue;
      const mates = Object.entries(lamBy).filter(([q, o]) => q !== pid && o.sd === r.sd && o.x[8] === slot).map(([, o]) => o.lam.pts);
      if (mates.length) r.fx.mates = mates.reduce((a, b) => a + b, 0) / mates.length;
    }
    for (const [pid, r] of Object.entries(lamBy)) {
      const x = r.x;
      const bk = bucketsOf(r.fx);
      bt.push({ d, gid: g.id, pid: +pid, team: teams[r.sd], lam: r.lam, bk, y: { pts: x[2] + x[3], g: x[2], sog: x[4] }, slot: x[8], pu: x[9], n: r.n });
      rowsG.push(bt[bt.length - 1]);
    }
    // stacks (L1 + PP1 members)
    for (const sd of [0, 1]) {
      const mem = rowsG.filter((r) => r.team === teams[sd] && (r.slot === "L1" || r.pu === 1));
      for (let i = 0; i < mem.length; i++) for (let j = i + 1; j < mem.length; j++) {
        const combos = [[mem[i], mem[j]]];
        for (let k = j + 1; k < mem.length; k++) combos.push([mem[i], mem[j], mem[k]]);
        for (const c of combos) {
          const sameL1 = c.every((r) => r.slot === "L1"), allPP = c.every((r) => r.pu === 1);
          if (!sameL1 && !allPP) continue;
          const kind = `${sameL1 ? (allPP ? "L1+PP1" : "L1") : "PP1"} ${c.length === 2 ? "pair" : "trio"}`;
          stackRows.push({ d, kind, ids: c.map((r) => r.pid), rows: c });
        }
      }
    }
  }
  // ---- update state with this date's games
  for (const g of byDate[d]) {
    const teams = [g.a, g.h];
    for (const [pidS, x] of Object.entries(g.p)) {
      if (x[1] === "G") continue;
      (hist[pidS] ??= []).push({ pts: x[2] + x[3], g: x[2], sog: x[4], toi: x[5], d });
    }
    const sog = [0, 0], gl = [0, 0], ppg = [0, 0], roleF = [{ C: 0, L: 0, R: 0, D: 0 }, { C: 0, L: 0, R: 0, D: 0 }];
    for (const e of g.ev) {
      sog[e[0]]++; if (e[4]) { gl[e[0]]++; if (e[5] === "p") ppg[e[0]]++;
        for (const pid of [e[1], e[6], e[7]]) if (pid && g.p[pid]) { const rg = posGroup(g.role[pid] ?? g.p[pid][1]); if (roleF[e[0]][rg] != null) roleF[e[0]][rg]++; } }
    }
    for (const sd of [0, 1]) {
      (thist[teams[sd]] ??= []).push({ d, ga: gl[1 - sd], gf: gl[sd], sa: sog[1 - sd], sf: sog[sd], pen: g.pen[sd], ppgA: ppg[1 - sd], roleA: roleF[1 - sd] });
      lastPlayed[teams[sd]] = d;
    }
    for (const [gid, [, sa, ga]] of Object.entries(g.gl)) if (sa >= 10) (ghist[gid] ??= []).push([sa, ga]);
  }
}
console.log("backtest rows", bt.length, "stack rows", stackRows.length);

// ---------------------------------------------------------------- learn multipliers (raking / Poisson GLM on buckets)
const TARGETS = ["pts", "g", "sog"];
function fit(rows) {
  const mult = {};
  for (const t of TARGETS) {
    const M = Object.fromEntries(FACTOR_KEYS.map((k) => [k, {}]));
    const Kshr = t === "g" ? 60 : t === "pts" ? 80 : 150;
    for (let it = 0; it < 10; it++) {
      for (const k of FACTOR_KEYS) {
        const num = {}, den = {};
        for (const r of rows) {
          let m = 1; for (const k2 of FACTOR_KEYS) m *= M[k2][r.bk[k2]] ?? 1;
          const b = r.bk[k]; num[b] = (num[b] ?? 0) + r.y[t]; den[b] = (den[b] ?? 0) + r.lam[t] * m;
        }
        for (const b of Object.keys(num)) {
          const ratio = (num[b] + Kshr) / (den[b] + Kshr);
          M[k][b] = clamp((M[k][b] ?? 1) * ratio, 0.7, 1.45);
        }
      }
    }
    for (const k of FACTOR_KEYS) for (const b of Object.keys(M[k])) M[k][b] = r3(M[k][b]);
    mult[t] = M;
  }
  return mult;
}
const rawTuned = (r, mult) => probs({ pts: r.lam.pts * multFor(mult, "pts", r.bk), g: r.lam.g * multFor(mult, "g", r.bk), sog: r.lam.sog * multFor(mult, "sog", r.bk) });
const logit = (p) => Math.log(p / (1 - p)), sigm = (z) => 1 / (1 + Math.exp(-z));
// Platt scaling per market: y ~ sigmoid(a + b*logit(p))
function platt(rows, mult) {
  const out = {};
  for (const [m, hit] of Object.entries({ p1: (y) => y.pts >= 1, p2: (y) => y.pts >= 2, g1: (y) => y.g >= 1, s3: (y) => y.sog >= 3 })) {
    const X = rows.map((r) => logit(clamp(rawTuned(r, mult)[m], 0.002, 0.998))), Y = rows.map((r) => (hit(r.y) ? 1 : 0));
    let a = 0, b = 1;
    for (let it = 0; it < 25; it++) {
      let ga = 0, gb = 0, haa = 0, hab = 0, hbb = 0;
      for (let i = 0; i < X.length; i++) { const p = sigm(a + b * X[i]), e = p - Y[i], w = p * (1 - p); ga += e; gb += e * X[i]; haa += w; hab += w * X[i]; hbb += w * X[i] * X[i]; }
      const det = haa * hbb - hab * hab; if (!det) break;
      a -= (hbb * ga - hab * gb) / det; b -= (haa * gb - hab * ga) / det;
    }
    out[m] = [r3(a), r3(b)];
  }
  return out;
}
const applyPlatt = (p, cal) => Object.fromEntries(Object.entries(p).map(([m, v]) => [m, cal?.[m] ? sigm(cal[m][0] + cal[m][1] * logit(clamp(v, 0.002, 0.998))) : v]));
let CAL_T = null;
const tuned = (r, mult, cal = CAL_T) => applyPlatt(rawTuned(r, mult), cal);
const base = (r) => probs(r.lam);
const MK = { p1: (y) => y.pts >= 1, p2: (y) => y.pts >= 2, g1: (y) => y.g >= 1, s3: (y) => y.sog >= 3 };
function score(rows, pf) {
  const out = {};
  for (const [m, hit] of Object.entries(MK)) {
    let brier = 0, ll = 0;
    for (const r of rows) { const p = clamp(pf(r)[m], 0.001, 0.999), y = hit(r.y) ? 1 : 0; brier += (p - y) ** 2; ll += -(y * Math.log(p) + (1 - y) * Math.log(1 - p)); }
    out[m] = { brier: r3(brier / rows.length), logloss: r3(ll / rows.length) };
  }
  return out;
}
const train = bt.filter((r) => r.d < SPLIT), test = bt.filter((r) => r.d >= SPLIT);
const multTrain = fit(train);
const calTrain = platt(train, multTrain);
const holdout = { trainN: train.length, testN: test.length, split: SPLIT, base: score(test, base), tuned: score(test, (r) => tuned(r, multTrain, calTrain)) };
const mult = fit(bt);
CAL_T = platt(bt, mult);
console.log("platt", JSON.stringify(CAL_T));
console.log("holdout", JSON.stringify(holdout));
for (const r of bt) { r.pb = base(r); r.pt = tuned(r, mult); }

// ---------------------------------------------------------------- reports
function calib(pf, m, edges) {
  const out = edges.slice(0, -1).map((lo, i) => ({ lo, hi: edges[i + 1], n: 0, hit: 0, exp: 0 }));
  for (const r of bt) { const p = pf(r)[m]; const b = out.find((c) => p >= c.lo && p < c.hi); if (!b) continue; b.n++; b.exp += p; if (MK[m](r.y)) b.hit++; }
  return out.map((c) => ({ lo: c.lo, hi: c.hi, n: c.n, exp: r3(c.n ? c.exp / c.n : null), act: r3(c.n ? c.hit / c.n : null) }));
}
const EDGES = { p1: [0, 0.3, 0.4, 0.5, 0.6, 0.7, 1.01], p2: [0, 0.1, 0.15, 0.25, 0.35, 0.45, 1.01], g1: [0, 0.1, 0.15, 0.25, 0.35, 0.45, 1.01], s3: [0, 0.2, 0.3, 0.45, 0.6, 0.75, 1.01] };
const calibration = {};
for (const m of Object.keys(MK)) calibration[m] = { base: calib((r) => r.pb, m, EDGES[m]), tuned: calib((r) => r.pt, m, EDGES[m]) };
// Top-N per night
const nights = {};
for (const r of bt) (nights[r.d] ??= []).push(r);
function topN(pf, m, N) {
  let n = 0, hit = 0, exp = 0; const monthly = {};
  for (const [d, rows] of Object.entries(nights)) {
    const t = [...rows].sort((a, b) => pf(b)[m] - pf(a)[m]).slice(0, N);
    const mo = d.slice(0, 7); const M = (monthly[mo] ??= { n: 0, hit: 0, exp: 0 });
    for (const r of t) { n++; M.n++; const p = pf(r)[m]; exp += p; M.exp += p; if (MK[m](r.y)) { hit++; M.hit++; } }
  }
  return { n, hit, exp: r3(exp / n), rate: r3(hit / n), monthly: Object.fromEntries(Object.entries(monthly).map(([k, v]) => [k, [v.n, v.hit, r3(v.exp / v.n)]])) };
}
const top = {};
for (const m of Object.keys(MK)) top[m] = { base: topN((r) => r.pb, m, 10), tuned: topN((r) => r.pt, m, 10), top5: topN((r) => r.pt, m, 5) };
// Factor lab (base model residuals: where the old model was wrong)
const lab = {};
for (const k of FACTOR_KEYS) {
  const B = {};
  for (const r of bt) {
    const b = r.bk[k]; const o = (B[b] ??= { n: 0, p1: 0, p1e: 0, g1: 0, g1e: 0, pts: 0, ptsE: 0, g: 0, gE: 0, s3: 0, s3e: 0 });
    o.n++; o.p1 += MK.p1(r.y) ? 1 : 0; o.p1e += r.pb.p1; o.g1 += MK.g1(r.y) ? 1 : 0; o.g1e += r.pb.g1; o.s3 += MK.s3(r.y) ? 1 : 0; o.s3e += r.pb.s3;
    o.pts += r.y.pts; o.ptsE += r.lam.pts; o.g += r.y.g; o.gE += r.lam.g;
  }
  lab[k] = Object.fromEntries(Object.entries(B).map(([b, o]) => [b, {
    n: o.n, p1: r3(o.p1 / o.n), p1e: r3(o.p1e / o.n), g1: r3(o.g1 / o.n), g1e: r3(o.g1e / o.n), s3: r3(o.s3 / o.n), s3e: r3(o.s3e / o.n),
    ptsPg: r3(o.pts / o.n), gPg: r3(o.g / o.n),
    mPts: mult.pts[k]?.[b] ?? 1, mG: mult.g[k]?.[b] ?? 1, mSog: mult.sog[k]?.[b] ?? 1,
  }]));
}
// Stack lift by kind (tuned probabilities)
const stackKinds = {};
for (const s of stackRows) {
  const indep = s.rows.reduce((a, r) => a * r.pt.p1, 1);
  const hit = s.rows.every((r) => r.y.pts >= 1);
  const o = (stackKinds[s.kind] ??= { n: 0, hit: 0, indep: 0 });
  o.n++; o.indep += indep; if (hit) o.hit++;
}
const stackLift = {};
for (const [k, o] of Object.entries(stackKinds)) stackLift[k] = { n: o.n, rate: r3(o.hit / o.n), indep: r3(o.indep / o.n), lift: r3(o.hit / o.indep) };

// ---------------------------------------------------------------- line vs line matchups (5v5)
// slot of a unit key inside a game (L1..L4 / D1..D3) from that game's slot field
const unitSlot = (g, key) => {
  const ids = key.slice(1).split("-"); const sl = ids.map((p) => g.p[p]?.[8] ?? "");
  return sl.every((x) => x && x === sl[0]) ? sl[0] : "";
};
const tiersOut = {}; // T -> unitKey -> {L1:[sec,gf,ga,sf,sa],..., D1..}
const h2hAcc = {};   // "A|B" (A<B) -> {games:Set, pairs:{kA|kB:[sec,gfA,gfB,sfA,sfB]}}
const recentGids = {};
const pTiers = {}; // pid -> slot -> [sec,gf,ga,sf,sa]
const pH2h = {};   // "lo|hi" -> "pLo|pHi" -> [sec, gfLo, gfHi, sfLo, sfHi]
for (const t of TEAMS) recentGids[t] = new Set([...(tg[t] ?? [])].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 40).map((r) => r.gid));
for (const g of games) {
  if (!g.m) continue;
  const H = g.h, A = g.a;
  const [lo, hi] = A < H ? [A, H] : [H, A];
  const hk = `${lo}|${hi}`; const hh = (h2hAcc[hk] ??= { games: new Set(), pairs: {} }); hh.games.add(g.id);
  for (const [kH, kA, sec, hgf, agf, hsf, asf] of g.m) {
    // tiers (only recent 40 for each team)
    const sH = unitSlot(g, kA), sA = unitSlot(g, kH);
    const addP = (key, team, slot, a) => { if (!slot) return; for (const pid of key.slice(1).split("-")) { if (roster[pid]?.team !== team) continue; const o = ((pTiers[pid] ??= {})[slot] ??= [0, 0, 0, 0, 0]); for (let i = 0; i < 5; i++) o[i] += a[i]; } };
    if (recentGids[H]?.has(g.id)) addP(kH, H, sH, [sec, hgf, agf, hsf, asf]);
    if (recentGids[A]?.has(g.id)) addP(kA, A, sA, [sec, agf, hgf, asf, hsf]);
    // player-level head to head (both players on current rosters)
    for (const ph of kH.slice(1).split("-")) for (const pa of kA.slice(1).split("-")) {
      if (roster[ph]?.team !== H || roster[pa]?.team !== A) continue;
      const [p1, p2, a] = lo === H ? [ph, pa, [sec, hgf, agf, hsf, asf]] : [pa, ph, [sec, agf, hgf, asf, hsf]];
      const o = ((pH2h[hk] ??= {})[`${p1}|${p2}`] ??= [0, 0, 0, 0, 0]); for (let i = 0; i < 5; i++) o[i] += a[i];
    }
    if (recentGids[H]?.has(g.id) && sH) { const o = ((tiersOut[H] ??= {})[kH] ??= {}); const v = (o[sH] ??= [0, 0, 0, 0, 0]); v[0] += sec; v[1] += hgf; v[2] += agf; v[3] += hsf; v[4] += asf; }
    if (recentGids[A]?.has(g.id) && sA) { const o = ((tiersOut[A] ??= {})[kA] ??= {}); const v = (o[sA] ??= [0, 0, 0, 0, 0]); v[0] += sec; v[1] += agf; v[2] += hgf; v[3] += asf; v[4] += hsf; }
    // head to head, oriented lo team first
    const [k1, k2, g1, g2, s1, s2] = lo === H ? [kH, kA, hgf, agf, hsf, asf] : [kA, kH, agf, hgf, asf, hsf];
    const v = (hh.pairs[`${k1}|${k2}`] ??= [0, 0, 0, 0, 0]); v[0] += sec; v[1] += g1; v[2] += g2; v[3] += s1; v[4] += s2;
  }
}
const onTeam = (key, t) => key.slice(1).split("-").every((p) => roster[p]?.team === t);
const tiers = {};
for (const t of TEAMS) {
  const keep = new Set([...(unitsOut[t]?.F ?? []), ...(unitsOut[t]?.D ?? [])].map((u) => u.kind + u.ids.join("-")));
  tiers[t] = Object.fromEntries(Object.entries(tiersOut[t] ?? {}).filter(([k]) => keep.has(k)));
}
const h2h = {};
for (const [k, v] of Object.entries(h2hAcc)) {
  const [lo, hi] = k.split("|");
  const pairs = Object.entries(v.pairs).filter(([pk, x]) => { const [a, b] = pk.split("|"); return x[0] >= 60 && onTeam(a, lo) && onTeam(b, hi); })
    .map(([pk, x]) => [...pk.split("|"), ...x]);
  if (pairs.length) h2h[k] = { games: v.games.size, pairs };
}

// ---------------------------------------------------------------- goalies
const netDist = (x, y) => Math.hypot(89 - x, y);
const zoneOf = (x, y) => {
  if (x == null || y == null) return "unk";
  if (x < 25) return "long";
  const d = netDist(x, y);
  if (d <= 15) return "inner";
  if (d <= 35 && Math.abs(y) <= 15) return "slot";
  if (x < 55) return "point";
  return "wing";
};
const ZONES = ["inner", "slot", "wing", "point", "long"];
const STYPES = { 1: "wrist", 2: "snap", 3: "slap", 4: "backhand", 5: "tip", 6: "deflect", 7: "wrap", 8: "other" };
// league goal rates by (zone, flag) for expected goals
const lgz = {};
const zkey = (e) => `${zoneOf(e[2], e[3])}|${(e[11] ?? 0) & 3}|${e[5]}`;
for (const g of games) for (const e of g.ev) { if (e[5] === "n") continue; const k = zkey(e); const v = (lgz[k] ??= [0, 0]); v[0]++; if (e[4]) v[1]++; }
const xg = (e) => { const v = lgz[zkey(e)]; return v && v[0] >= 30 ? v[1] / v[0] : 0.09; };
const blankG = () => ({ gp: 0, sa: 0, ga: 0, xga: 0, str: { e: [0, 0], p: [0, 0], s: [0, 0] }, zone: Object.fromEntries(ZONES.map((z) => [z, [0, 0]])), type: {}, reb: [0, 0], rush: [0, 0], rebAllowed: 0, saves: 0, cells: {}, starts: [] });
const gAcc = {};
const cellG = cell;
for (const g of games) {
  const starters = {};
  for (const e of g.ev) {
    const gid = e[9]; if (!gid || e[5] === "n") continue;
    const o = (gAcc[gid] ??= blankG());
    if (!starters[gid]) { starters[gid] = { d: g.d, sa: 0, ga: 0, xga: 0, opp: e[0] === 1 ? g.h : g.a }; }
    const st = starters[gid];
    o.sa++; st.sa++; if (e[4]) { o.ga++; st.ga++; }
    const x = xg(e); o.xga += x; st.xga += x;
    const sv = o.str[e[5]]; if (sv) { sv[0]++; if (e[4]) sv[1]++; }
    const z = o.zone[zoneOf(e[2], e[3])]; if (z) { z[0]++; if (e[4]) z[1]++; }
    const tn = STYPES[e[10]] ?? "other"; const tv = (o.type[tn] ??= [0, 0]); tv[0]++; if (e[4]) tv[1]++;
    if (e[11] & 1) { o.reb[0]++; if (e[4]) o.reb[1]++; }
    if (e[11] & 2) { o.rush[0]++; if (e[4]) o.rush[1]++; }
    const c = cellG(e[2], e[3]); if (c >= 0) { const cv = (o.cells[c] ??= [0, 0]); cv[0]++; if (e[4]) cv[1]++; }
  }
  // rebounds allowed: a save followed by an opponent rebound shot on the same goalie
  for (let i = 1; i < g.ev.length; i++) { const e = g.ev[i]; if ((e[11] & 1) && e[9] && gAcc[e[9]]) gAcc[e[9]].rebAllowed++; }
  for (const [gid, st] of Object.entries(starters)) { const o = gAcc[gid]; o.gp++; o.saves += st.sa - st.ga; o.starts.push([st.d, st.opp, st.sa, st.ga, r2(st.xga)]); }
}
const lgG = { sa: 0, ga: 0, zone: Object.fromEntries(ZONES.map((z) => [z, [0, 0]])), reb: [0, 0], rush: [0, 0], str: { e: [0, 0], p: [0, 0], s: [0, 0] }, type: {} };
for (const o of Object.values(gAcc)) {
  lgG.sa += o.sa; lgG.ga += o.ga;
  for (const z of ZONES) { lgG.zone[z][0] += o.zone[z][0]; lgG.zone[z][1] += o.zone[z][1]; }
  for (const k of ["e", "p", "s"]) { lgG.str[k][0] += o.str[k][0]; lgG.str[k][1] += o.str[k][1]; }
  lgG.reb[0] += o.reb[0]; lgG.reb[1] += o.reb[1]; lgG.rush[0] += o.rush[0]; lgG.rush[1] += o.rush[1];
  for (const [k, v] of Object.entries(o.type)) { const t = (lgG.type[k] ??= [0, 0]); t[0] += v[0]; t[1] += v[1]; }
}
const svp = (v) => (v[0] ? r3(1 - v[1] / v[0]) : null);
const goaliesOut = {};
for (const [gid, o] of Object.entries(gAcc)) {
  if (roster[gid]?.pos !== "G" || o.sa < 100) continue;
  goaliesOut[gid] = {
    name: roster[gid].name, team: roster[gid].team, gp: o.gp, sa: o.sa, ga: o.ga, sv: svp([o.sa, o.ga]), gsax: r2(o.xga - o.ga), gsax60: r3((o.xga - o.ga) / Math.max(1, o.gp)),
    str: Object.fromEntries(Object.entries(o.str).map(([k, v]) => [k, [v[0], svp(v)]])),
    zone: Object.fromEntries(ZONES.map((z) => [z, [o.zone[z][0], svp(o.zone[z])]])),
    type: Object.fromEntries(Object.entries(o.type).filter(([, v]) => v[0] >= 15).map(([k, v]) => [k, [v[0], svp(v)]])),
    reb: [o.reb[0], svp(o.reb)], rush: [o.rush[0], svp(o.rush)], rebRate: r3(o.rebAllowed / Math.max(1, o.saves)),
    cells: Object.entries(o.cells).map(([c, v]) => [+c, v[0], v[1]]),
    last10: o.starts.slice(-10).reverse(),
  };
}
// team attack profile (what kind of shots each team generates) for goalie matchup
const teamAtk = {};
for (const t of TEAMS) {
  const o = { sf: 0, zone: Object.fromEntries(ZONES.map((z) => [z, 0])), reb: 0, rush: 0, type: {}, gf: 0, xgf: 0 };
  for (const gid of recentGids[t] ?? []) {
    const g = cache.games[gid]; const sd = g.h === t ? 1 : 0;
    for (const e of g.ev) {
      if (e[0] !== sd || e[5] === "n") continue;
      o.sf++; o.zone[zoneOf(e[2], e[3])] = (o.zone[zoneOf(e[2], e[3])] ?? 0) + 1; if (e[11] & 1) o.reb++; if (e[11] & 2) o.rush++;
      const tn = STYPES[e[10]] ?? "other"; o.type[tn] = (o.type[tn] ?? 0) + 1; if (e[4]) o.gf++; o.xgf += xg(e);
    }
  }
  const n = Math.max(1, o.sf);
  teamAtk[t] = { gp: recentGids[t]?.size ?? 0, sf: o.sf, zone: Object.fromEntries(ZONES.map((z) => [z, r3(o.zone[z] / n)])), reb: r3(o.reb / n), rush: r3(o.rush / n), type: Object.fromEntries(Object.entries(o.type).map(([k, v]) => [k, r3(v / n)])), shPct: r3(o.gf / n), xgPerShot: r3(o.xgf / n) };
}
const lgN = Math.max(1, lgG.sa);
const goalieLeague = {
  sv: svp([lgG.sa, lgG.ga]), zone: Object.fromEntries(ZONES.map((z) => [z, [r3(lgG.zone[z][0] / lgN), svp(lgG.zone[z])]])),
  str: Object.fromEntries(Object.entries(lgG.str).map(([k, v]) => [k, svp(v)])), reb: [r3(lgG.reb[0] / lgN), svp(lgG.reb)], rush: [r3(lgG.rush[0] / lgN), svp(lgG.rush)],
  type: Object.fromEntries(Object.entries(lgG.type).map(([k, v]) => [k, [r3(v[0] / lgN), svp(v)]])),
};
const pH2hOut = {};
for (const [k, v] of Object.entries(pH2h)) { const e = Object.entries(v).filter(([, x]) => x[0] >= 150).map(([pk, x]) => [...pk.split("|").map(Number), ...x]); if (e.length) pH2hOut[k] = e; }
fs.writeFileSync("hockey-matchups.json", JSON.stringify({ builtAt: new Date().toISOString(), tiers, players: pTiers }));
fs.writeFileSync("hockey-h2h.json", JSON.stringify({ builtAt: new Date().toISOString(), pairs: pH2hOut }));
fs.writeFileSync("hockey-goalies.json", JSON.stringify({ builtAt: new Date().toISOString(), grid: { x0: X0, size: CS, nx: NX, ny: NY }, zones: ZONES, league: goalieLeague, goalies: goaliesOut, teamAtk }));
for (const f of ["hockey-matchups.json", "hockey-h2h.json", "hockey-goalies.json"]) console.log(f, (fs.statSync(f).size / 1024).toFixed(0), "KB");

// ---------------------------------------------------------------- live context (state after all games)
const blendsNow = Object.fromEntries(TEAMS.map((t) => [t, teamBlend(t)]));
const lgNow = leagueOf(blendsNow);
const live = {
  league: { gapg: r3(lgNow.gapg), sapg: r2(lgNow.sapg), svPct: r3(lgNow.svPct), ppgA: r3(lgNow.ppgA), posA: Object.fromEntries(ROLES.map((q) => [q, r3(lgNow.posA[q])])) },
  teams: Object.fromEntries(TEAMS.map((t) => { const b = blendsNow[t]; return [t, b && { gapg: r3(b.gapg), gfpg: r3(b.gfpg), sapg: r2(b.sapg), pen: r2(b.pen), ppgA: r3(b.ppgA), svPct: r3(b.svPct), posA: Object.fromEntries(ROLES.map((q) => [q, r3(b.posA[q])])) }]; })),
  lastPlayed,
};
const roles = {};
for (const [pid, rc] of Object.entries(roleCount)) {
  if (!roster[pid] || roster[pid].pos === "G") continue;
  const recent = rc._last; const best = Object.entries(rc).filter(([k]) => k !== "_last").sort((a, b) => b[1] - a[1])[0]?.[0];
  roles[pid] = best ?? recent;
}

fs.writeFileSync("hockey-teams.json", JSON.stringify({
  builtAt: new Date().toISOString(), games: games.length, lastGame: games[games.length - 1]?.d, seasons: { prev: PREV, cur: CUR },
  teams: teamsOut, units: unitsOut, live, roles,
  names: Object.fromEntries(Object.entries(roster).filter(([, r]) => r.pos !== "G").map(([id, r]) => [id, [r.name, r.team, r.pos]])),
}));
fs.writeFileSync("hockey-shots.json", JSON.stringify({ grid: { x0: X0, size: CS, nx: NX, ny: NY }, teams: shotTeams, players: shotPlayers }));
fs.writeFileSync("hockey-backtest.json", JSON.stringify({
  builtAt: new Date().toISOString(), season: PREV, evalFrom: EVAL_FROM, rows: bt.length, nights: Object.keys(nights).length,
  holdout, calibration, top, lab, stackLift, mult, platt: CAL_T, factors: factorMeta(),
}));
for (const f of ["hockey-teams.json", "hockey-shots.json", "hockey-backtest.json"]) console.log(f, (fs.statSync(f).size / 1024).toFixed(0), "KB");
