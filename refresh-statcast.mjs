#!/usr/bin/env node
// MatrixBaseball — Statcast + slate refresh pipeline (standalone GitHub Actions version)
// Pulls real player stats AND real game schedule + lineups for T-1..T+1 window.
// Writes slates.json to the repo root for serving via raw.githubusercontent.com.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.GITHUB_WORKSPACE ? process.env.GITHUB_WORKSPACE : path.resolve(__dirname, "..");
const SLATES_OUT = path.resolve(REPO_ROOT, "slates.json");
const SEASON = 2026;
const SCHEDULE_DAYS_BACK = 1;
const SCHEDULE_DAYS_FWD = 1;

const log = (...a) => console.log("[statcast]", ...a);

async function fetchJSON(url, label) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "MatrixBaseball/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    log(`fetch failed [${label}]: ${e.message}`);
    return null;
  }
}

async function fetchText(url, label) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 MatrixBaseball/1.0" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    log(`fetch failed [${label}]: ${e.message}`);
    return null;
  }
}

function parseCsv(text) {
  const t = text.replace(/^\uFEFF/, "");
  const lines = t.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const split = (line) => {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (c === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((line) => {
    const cells = split(line);
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = cells[i] ?? "";
    return obj;
  });
  return { headers, rows };
}

async function fetchSavantHitters(season) {
  const out = new Map();
  const expUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=batter&year=${season}&min=1&csv=true`;
  const statUrl = `https://baseballsavant.mlb.com/leaderboard/statcast?type=batter&year=${season}&min=1&csv=true`;
  const bbUrl = `https://baseballsavant.mlb.com/leaderboard/batted-ball?year=${season}&min=1&type=batter&csv=true`;
  const [expTxt, statTxt, bbTxt] = await Promise.all([
    fetchText(expUrl, "savant hit exp"),
    fetchText(statUrl, "savant hit stat"),
    fetchText(bbUrl, "savant hit batted-ball"),
  ]);
  if (expTxt) {
    const { rows } = parseCsv(expTxt);
    for (const r of rows) {
      const id = parseInt(r.player_id, 10);
      if (!id) continue;
      out.set(id, {
        xwoba: parseFloat(r.est_woba) || null,
        xba:   parseFloat(r.est_ba)   || null,
        xslg:  parseFloat(r.est_slg)  || null,
      });
    }
  }
  if (statTxt) {
    const { rows } = parseCsv(statTxt);
    for (const r of rows) {
      const id = parseInt(r.player_id, 10);
      if (!id) continue;
      const cur = out.get(id) || {};
      cur.barrelPct  = parseFloat(r.brl_percent)  || null;
      cur.hardHitPct = parseFloat(r.ev95percent)  || null;
      cur.avgEv      = parseFloat(r.avg_hit_speed)|| null;
      cur.maxEv      = parseFloat(r.max_hit_speed)|| null;
      out.set(id, cur);
    }
  }
  if (bbTxt) {
    const { rows } = parseCsv(bbTxt);
    for (const r of rows) {
      const id = parseInt(r.id, 10);
      if (!id) continue;
      const cur = out.get(id) || {};
      const pullAir = parseFloat(r.pull_air_rate);
      const pull    = parseFloat(r.pull_rate);
      const air     = parseFloat(r.air_rate);
      cur.pullAirPct = Number.isFinite(pullAir) ? +(pullAir * 100).toFixed(1) : null;
      cur.pullPct    = Number.isFinite(pull)    ? +(pull * 100).toFixed(1)    : null;
      cur.airPct     = Number.isFinite(air)     ? +(air * 100).toFixed(1)     : null;
      out.set(id, cur);
    }
  }
  return out;
}

async function fetchSavantPitchers(season) {
  const out = new Map();
  const expUrl = `https://baseballsavant.mlb.com/leaderboard/expected_statistics?type=pitcher&year=${season}&min=1&csv=true`;
  const statUrl = `https://baseballsavant.mlb.com/leaderboard/statcast?type=pitcher&year=${season}&min=1&csv=true`;
  const [expTxt, statTxt] = await Promise.all([fetchText(expUrl, "savant pit exp"), fetchText(statUrl, "savant pit stat")]);
  if (expTxt) {
    const { rows } = parseCsv(expTxt);
    for (const r of rows) {
      const id = parseInt(r.player_id, 10);
      if (!id) continue;
      out.set(id, {
        xwobaAllowed: parseFloat(r.est_woba) || null,
        xbaAllowed:   parseFloat(r.est_ba)   || null,
        xslgAllowed:  parseFloat(r.est_slg)  || null,
        xera:         parseFloat(r.xera)     || null,
      });
    }
  }
  if (statTxt) {
    const { rows } = parseCsv(statTxt);
    for (const r of rows) {
      const id = parseInt(r.player_id, 10);
      if (!id) continue;
      const cur = out.get(id) || {};
      cur.barrelPctAllowed  = parseFloat(r.brl_percent)  || null;
      cur.hardHitPctAllowed = parseFloat(r.ev95percent)  || null;
      out.set(id, cur);
    }
  }
  return out;
}

const PARK_HR_FACTORS = {
  "Coors Field": 117, "Great American Ball Park": 113, "Yankee Stadium": 112,
  "Citizens Bank Park": 109, "Wrigley Field": 107, "Globe Life Field": 106,
  "Fenway Park": 105, "Chase Field": 105, "American Family Field": 104,
  "Citi Field": 103, "Rogers Centre": 103, "Camden Yards": 102,
  "Oriole Park at Camden Yards": 102, "Target Field": 101,
  "Truist Park": 101, "Angel Stadium": 100, "loanDepot park": 100,
  "Busch Stadium": 100, "Minute Maid Park": 100, "Daikin Park": 100,
  "Nationals Park": 99, "Dodger Stadium": 98, "Progressive Field": 97,
  "PNC Park": 96, "Petco Park": 95, "Kauffman Stadium": 94,
  "T-Mobile Park": 92, "Tropicana Field": 95, "Las Vegas Ballpark": 102,
  "Oracle Park": 88, "Comerica Park": 90, "Steinbrenner Field": 100,
  "Sutter Health Park": 105, "George M. Steinbrenner Field": 100,
};
function parkHrFactor(venue) {
  if (!venue) return 100;
  return PARK_HR_FACTORS[venue] ?? 100;
}

let teamAbbrCache = null;
async function getTeamAbbr() {
  if (teamAbbrCache) return teamAbbrCache;
  const j = await fetchJSON("https://statsapi.mlb.com/api/v1/teams?sportId=1", "teams");
  const map = {};
  for (const t of j?.teams ?? []) map[t.id] = t.abbreviation;
  teamAbbrCache = map;
  return map;
}

const playerMetaCache = new Map();
async function getPlayerMeta(personId) {
  if (playerMetaCache.has(personId)) return playerMetaCache.get(personId);
  const j = await fetchJSON(`https://statsapi.mlb.com/api/v1/people/${personId}`, `person ${personId}`);
  const p = j?.people?.[0];
  const meta = p ? {
    bats: p.batSide?.code ?? "R",
    throws: p.pitchHand?.code ?? "R",
    position: p.primaryPosition?.abbreviation ?? "?",
  } : { bats: "R", throws: "R", position: "?" };
  playerMetaCache.set(personId, meta);
  return meta;
}

async function fetchHitterSeason(mlbId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=season&season=${SEASON}&group=hitting`;
  const j = await fetchJSON(url, `h${mlbId} season`);
  const s = j?.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    avg: parseFloat(s.avg ?? "0"), obp: parseFloat(s.obp ?? "0"), slg: parseFloat(s.slg ?? "0"),
    ops: parseFloat(s.ops ?? "0"), hr: s.homeRuns ?? 0, ab: s.atBats ?? 0, hits: s.hits ?? 0,
    rbi: s.rbi ?? 0, sb: s.stolenBases ?? 0, k: s.strikeOuts ?? 0, bb: s.baseOnBalls ?? 0,
  };
}
async function fetchHitterRecent(mlbId, days) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=lastXGames&limit=${days}&season=${SEASON}&group=hitting`;
  const j = await fetchJSON(url, `h${mlbId} L${days}`);
  const s = j?.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    xwoba: Math.min(0.5, (parseFloat(s.ops ?? "0") || 0) * 0.42 + 0.18),
    barrelPct: Math.max(2, Math.min(22, (parseFloat(s.slg ?? "0") - 0.350) * 30 + 8)),
    hardHitPct: Math.max(20, Math.min(60, (parseFloat(s.slg ?? "0") - 0.350) * 50 + 35)),
    ops: parseFloat(s.ops ?? "0"),
  };
}

async function fetchPitcherSeason(mlbId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=season&season=${SEASON}&group=pitching`;
  const j = await fetchJSON(url, `p${mlbId} season`);
  const s = j?.stats?.[0]?.splits?.[0]?.stat;
  if (!s) return null;
  return {
    era: parseFloat(s.era ?? "0"), whip: parseFloat(s.whip ?? "0"),
    k9: parseFloat(s.strikeoutsPer9Inn ?? "0"), hr9: parseFloat(s.homeRunsPer9 ?? "0"),
    ip: parseFloat(s.inningsPitched ?? "0"), w: s.wins ?? 0, l: s.losses ?? 0,
  };
}

async function fetchHitterGameLog(mlbId, lastN = 7) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=gameLog&season=${SEASON}&group=hitting`;
  const j = await fetchJSON(url, `h${mlbId} gameLog`);
  const splits = j?.stats?.[0]?.splits ?? [];
  const tail = splits.slice(-lastN);
  return tail.map((s) => {
    const st = s.stat ?? {};
    return {
      date: s.date ?? null,
      ab: st.atBats ?? 0,
      h: st.hits ?? 0,
      hr: st.homeRuns ?? 0,
      bb: st.baseOnBalls ?? 0,
      k: st.strikeOuts ?? 0,
      tb: st.totalBases ?? 0,
      ops: parseFloat(st.ops ?? "0") || 0,
    };
  });
}

async function fetchPlatoonSplits(mlbId, group) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=statSplits&season=${SEASON}&group=${group}&sitCodes=vl,vr`;
  const j = await fetchJSON(url, `${group[0]}${mlbId} splits`);
  const splits = j?.stats?.[0]?.splits ?? [];
  const out = { vl: null, vr: null };
  for (const sp of splits) {
    const s = sp.stat ?? {};
    const code = sp.split?.code;
    if (code !== "vl" && code !== "vr") continue;
    out[code] = {
      avg: parseFloat(s.avg ?? "0"),
      obp: parseFloat(s.obp ?? "0"),
      slg: parseFloat(s.slg ?? "0"),
      ops: parseFloat(s.ops ?? "0"),
      pa: s.plateAppearances ?? 0,
      ab: s.atBats ?? 0,
    };
  }
  return (out.vl || out.vr) ? out : null;
}

async function fetchBvp(batterId, pitcherId) {
  if (!batterId || !pitcherId) return null;
  const url = `https://statsapi.mlb.com/api/v1/people/${batterId}/stats?stats=vsPlayer&group=hitting&opposingPlayerId=${pitcherId}&sportId=1`;
  const j = await fetchJSON(url, `bvp ${batterId}v${pitcherId}`);
  const splits = j?.stats?.[0]?.splits ?? [];
  if (!splits.length) return null;
  let ab = 0, h = 0, hr = 0, k = 0, bb = 0, tb = 0, pa = 0;
  for (const sp of splits) {
    const s = sp.stat ?? {};
    ab += s.atBats ?? 0;
    h  += s.hits ?? 0;
    hr += s.homeRuns ?? 0;
    k  += s.strikeOuts ?? 0;
    bb += s.baseOnBalls ?? 0;
    tb += s.totalBases ?? 0;
    pa += s.plateAppearances ?? 0;
  }
  if (ab === 0 && pa === 0) return null;
  const avg = ab > 0 ? h / ab : 0;
  const slg = ab > 0 ? tb / ab : 0;
  const obp = pa > 0 ? (h + bb) / pa : 0;
  return {
    ab, hits: h, hr, k, bb, tb, pa,
    avg: +avg.toFixed(3),
    slg: +slg.toFixed(3),
    obp: +obp.toFixed(3),
    ops: +(obp + slg).toFixed(3),
  };
}

async function fetchScheduleForDate(dateStr) {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${dateStr}&hydrate=probablePitcher,lineups,venue`;
  const j = await fetchJSON(url, `schedule ${dateStr}`);
  return j?.dates?.[0]?.games ?? [];
}

async function fetchProjectedLineup(teamId, beforeDate) {
  const start = new Date(beforeDate);
  start.setDate(start.getDate() - 7);
  const startStr = start.toISOString().slice(0, 10);
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&teamId=${teamId}&startDate=${startStr}&endDate=${beforeDate}&hydrate=lineups`;
  const j = await fetchJSON(url, `proj lineup ${teamId}`);
  const games = [];
  for (const block of j?.dates ?? []) {
    for (const g of block.games ?? []) games.push(g);
  }
  games.sort((a, b) => (b.gameDate ?? "").localeCompare(a.gameDate ?? ""));
  for (const g of games) {
    const isHome = g.teams.home.team.id === teamId;
    const lineup = isHome ? g.lineups?.homePlayers : g.lineups?.awayPlayers;
    if (lineup && lineup.length >= 8) return { lineup, sourceDate: g.gameDate?.slice(0,10), status: g.status?.detailedState };
  }
  return null;
}

async function buildSlate(dateStr, abbrMap, playerCollector) {
  const games = await fetchScheduleForDate(dateStr);
  log(`  ${dateStr}: ${games.length} games`);
  const slate = [];

  for (const g of games) {
    const awayTeamId = g.teams.away.team.id;
    const homeTeamId = g.teams.home.team.id;
    const awayAbbr = abbrMap[awayTeamId] ?? "???";
    const homeAbbr = abbrMap[homeTeamId] ?? "???";
    const venue = g.venue?.name ?? "Unknown Park";
    const startUtc = g.gameDate;
    const startET = startUtc ? new Date(startUtc).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit", hour12: true }) : "TBD";
    const ap = g.teams.away.probablePitcher;
    const hp = g.teams.home.probablePitcher;
    const luConfirmed = !!(g.lineups?.awayPlayers?.length >= 8 && g.lineups?.homePlayers?.length >= 8);

    let awayLineup = g.lineups?.awayPlayers ?? null;
    let homeLineup = g.lineups?.homePlayers ?? null;
    let awayLineupSource = "confirmed";
    let homeLineupSource = "confirmed";

    if (!awayLineup || awayLineup.length < 8) {
      const proj = await fetchProjectedLineup(awayTeamId, dateStr);
      awayLineup = proj?.lineup ?? null;
      awayLineupSource = proj ? `projected (last ${proj.sourceDate})` : "unavailable";
    }
    if (!homeLineup || homeLineup.length < 8) {
      const proj = await fetchProjectedLineup(homeTeamId, dateStr);
      homeLineup = proj?.lineup ?? null;
      homeLineupSource = proj ? `projected (last ${proj.sourceDate})` : "unavailable";
    }

    if (ap?.id) playerCollector.pitchers.add(ap.id);
    if (hp?.id) playerCollector.pitchers.add(hp.id);
    for (const p of awayLineup ?? []) playerCollector.hitters.add(p.id);
    for (const p of homeLineup ?? []) playerCollector.hitters.add(p.id);

    slate.push({
      id: `g${g.gamePk}`,
      gamePk: g.gamePk,
      status: g.status?.detailedState ?? "Scheduled",
      awayTeam: awayAbbr,
      homeTeam: homeAbbr,
      awayTeamId,
      homeTeamId,
      awayTeamName: g.teams.away.team.name,
      homeTeamName: g.teams.home.team.name,
      park: venue,
      parkHrFactor: parkHrFactor(venue),
      startUtc,
      startET,
      awayPitcher: ap ? { id: ap.id, name: ap.fullName } : null,
      homePitcher: hp ? { id: hp.id, name: hp.fullName } : null,
      lineupsConfirmed: luConfirmed,
      awayLineup: (awayLineup ?? []).map((p, i) => ({
        id: p.id, name: p.fullName, order: i + 1,
        position: p.primaryPosition?.abbreviation ?? "?",
      })),
      homeLineup: (homeLineup ?? []).map((p, i) => ({
        id: p.id, name: p.fullName, order: i + 1,
        position: p.primaryPosition?.abbreviation ?? "?",
      })),
      awayLineupSource,
      homeLineupSource,
    });
  }
  return slate;
}

function dateRange() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = -SCHEDULE_DAYS_BACK; i <= SCHEDULE_DAYS_FWD; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function main() {
  log(`refresh started · season ${SEASON} · ${new Date().toISOString()}`);
  const abbrMap = await getTeamAbbr();
  log(`loaded ${Object.keys(abbrMap).length} team abbreviations`);

  const dates = dateRange();
  log(`fetching slates for: ${dates.join(", ")}`);

  const playerCollector = { hitters: new Set(), pitchers: new Set() };
  const slatesByDate = {};
  for (const d of dates) {
    slatesByDate[d] = await buildSlate(d, abbrMap, playerCollector);
  }
  log(`collected ${playerCollector.hitters.size} unique hitters, ${playerCollector.pitchers.size} unique pitchers`);

  const hitterMlbIds = [...playerCollector.hitters];
  const pitcherMlbIds = [...playerCollector.pitchers];

  log(`fetching Baseball Savant leaderboards`);
  const [savantHitters, savantPitchers] = await Promise.all([
    fetchSavantHitters(SEASON),
    fetchSavantPitchers(SEASON),
  ]);
  log(`  Savant hitters: ${savantHitters.size} · Savant pitchers: ${savantPitchers.size}`);

  const hitterStats = {};
  let hCount = 0;
  for (const id of hitterMlbIds) {
    const [season, l7, l15, l30, meta, splits, recent7] = await Promise.all([
      fetchHitterSeason(id),
      fetchHitterRecent(id, 7),
      fetchHitterRecent(id, 15),
      fetchHitterRecent(id, 30),
      getPlayerMeta(id),
      fetchPlatoonSplits(id, "hitting"),
      fetchHitterGameLog(id, 7),
    ]);
    const sv = savantHitters.get(id);
    if (sv) {
      if (l30 && sv.xwoba != null)     l30.xwoba = sv.xwoba;
      if (l30 && sv.barrelPct != null) l30.barrelPct = sv.barrelPct;
      if (l30 && sv.hardHitPct != null)l30.hardHitPct = sv.hardHitPct;
    }
    hitterStats[id] = { season, l7, l15, l30, ...meta, splits, recent7, savant: sv ?? null };
    hCount++;
    if (hCount % 20 === 0) log(`  hitters: ${hCount}/${hitterMlbIds.length}`);
  }
  log(`hitters complete: ${hCount}/${hitterMlbIds.length}`);

  const pitcherStats = {};
  let pCount = 0;
  for (const id of pitcherMlbIds) {
    const [season, meta, splits] = await Promise.all([
      fetchPitcherSeason(id),
      getPlayerMeta(id),
      fetchPlatoonSplits(id, "pitching"),
    ]);
    const sv = savantPitchers.get(id);
    pitcherStats[id] = { season, ...meta, splits, savant: sv ?? null };
    pCount++;
    if (pCount % 10 === 0) log(`  pitchers: ${pCount}/${pitcherMlbIds.length}`);
  }
  log(`pitchers complete: ${pCount}/${pitcherMlbIds.length}`);

  log(`fetching BVP history for slate pairings...`);
  const bvpMap = {};
  const today_ = new Date().toISOString().slice(0, 10);
  const relevantDates = Object.keys(slatesByDate).filter((d) => d >= today_);
  const bvpPairs = new Set();
  for (const d of relevantDates) {
    for (const g of slatesByDate[d]) {
      const opps = [
        { lineup: g.awayLineup, pid: g.homePitcher?.id },
        { lineup: g.homeLineup, pid: g.awayPitcher?.id },
      ];
      for (const { lineup, pid } of opps) {
        if (!pid) continue;
        for (const p of lineup) bvpPairs.add(`${p.id}:${pid}`);
      }
    }
  }
  let bvpCount = 0;
  const bvpList = [...bvpPairs];
  for (let i = 0; i < bvpList.length; i += 10) {
    const batch = bvpList.slice(i, i + 10);
    await Promise.all(batch.map(async (key) => {
      const [bId, pId] = key.split(":").map(Number);
      const bvp = await fetchBvp(bId, pId);
      if (bvp) bvpMap[`${bId}v${pId}`] = bvp;
      bvpCount++;
    }));
    if (i % 100 === 0 && i > 0) log(`  BVP: ${bvpCount}/${bvpList.length}`);
  }
  log(`BVP complete: ${Object.keys(bvpMap).length}/${bvpList.length} pairs with history`);

  const today = new Date().toISOString().slice(0, 10);

  const slatesPayload = {
    refreshedAt: new Date().toISOString(),
    season: SEASON,
    source: "MLB Stats API + Baseball Savant",
    today,
    dates,
    slates: slatesByDate,
    hitterStats,
    pitcherStats,
    bvp: bvpMap,
  };

  const slatesJson = JSON.stringify(slatesPayload, null, 2);
  await fs.writeFile(SLATES_OUT, slatesJson);
  log(`wrote ${SLATES_OUT} (${(slatesJson.length / 1024).toFixed(0)} KB)`);
  log(`refresh complete · ${dates.length} slate days · today=${today}`);
}

main().catch((e) => {
  console.error("[statcast] fatal:", e);
  process.exit(1);
});
