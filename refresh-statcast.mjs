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
// Ship 3 completed days of slates so EdgeLookback and PostgameLab can trend
// intelligence over the last 3 game days instead of just yesterday.
const SCHEDULE_DAYS_BACK = 3;
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

// Pitch-arsenal leaderboard: per-pitch stats for pitchers OR batters.
// For pitchers: usage% + BA/SLG/wOBA/Whiff%/xwOBA allowed per pitch type.
// For batters: each hitter's BA/SLG/wOBA/Whiff% vs each pitch type they've seen.
// Returns Map<playerId, Array<{pitchType, pitchName, usage, pa, ba, slg, woba, whiffPct, kPct, xba, xslg, xwoba, hardHitPct}>>
async function fetchPitchArsenal(season, type /* "pitcher" | "batter" */) {
  const out = new Map();
  const url = `https://baseballsavant.mlb.com/leaderboard/pitch-arsenal-stats?type=${type}&pitchType=&year=${season}&team=&min=10&csv=true`;
  const txt = await fetchText(url, `savant ${type} arsenal`);
  if (!txt) return out;
  const { rows } = parseCsv(txt);
  for (const r of rows) {
    const id = parseInt(r.player_id, 10);
    if (!id) continue;
    const entry = {
      pitchType: r.pitch_type || null,
      pitchName: r.pitch_name || null,
      usage: parseFloat(r.pitch_usage) || 0,
      pa: parseInt(r.pa, 10) || 0,
      ba: parseFloat(r.ba) || 0,
      slg: parseFloat(r.slg) || 0,
      woba: parseFloat(r.woba) || 0,
      whiffPct: parseFloat(r.whiff_percent) || 0,
      kPct: parseFloat(r.k_percent) || 0,
      xba: parseFloat(r.est_ba) || 0,
      xslg: parseFloat(r.est_slg) || 0,
      xwoba: parseFloat(r.est_woba) || 0,
      hardHitPct: parseFloat(r.hard_hit_percent) || 0,
    };
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(entry);
  }
  // Sort each player's pitch list by usage (desc) so the #1 pitch is first.
  for (const arr of out.values()) arr.sort((a, b) => b.usage - a.usage);
  return out;
}

// Pitcher game log -> windowed splits (L10, L5, L3, Last).
// Pulls last 15 starts and aggregates AVG/OBP/SLG/OPS allowed for each window.
async function fetchPitcherWindowedSplits(mlbId) {
  const url = `https://statsapi.mlb.com/api/v1/people/${mlbId}/stats?stats=gameLog&group=pitching&season=${SEASON}`;
  const data = await fetchJSON(url, `pitcher-gamelog ${mlbId}`);
  const games = data?.stats?.[0]?.splits ?? [];
  if (!games.length) return null;
  // game log is oldest -> newest in StatsAPI; reverse to newest first.
  const recent = [...games].reverse().slice(0, 15);
  const aggregate = (arr) => {
    if (!arr.length) return null;
    let ab = 0, h = 0, bb = 0, hbp = 0, sf = 0, tb = 0, bf = 0;
    for (const g of arr) {
      const s = g.stat || {};
      ab += parseInt(s.atBats, 10) || 0;
      h  += parseInt(s.hits, 10) || 0;
      bb += parseInt(s.baseOnBalls, 10) || 0;
      hbp+= parseInt(s.hitByPitch, 10) || 0;
      sf += parseInt(s.sacFlies, 10) || 0;
      // total bases = singles + 2*doubles + 3*triples + 4*HR; derived from h and extra-base hits
      const dbl = parseInt(s.doubles, 10) || 0;
      const tpl = parseInt(s.triples, 10) || 0;
      const hr  = parseInt(s.homeRuns, 10) || 0;
      const singles = (parseInt(s.hits, 10) || 0) - dbl - tpl - hr;
      tb += singles + 2*dbl + 3*tpl + 4*hr;
      bf += parseInt(s.battersFaced, 10) || 0;
    }
    const avg = ab > 0 ? h / ab : 0;
    const pa = ab + bb + hbp + sf;
    const obp = pa > 0 ? (h + bb + hbp) / pa : 0;
    const slg = ab > 0 ? tb / ab : 0;
    return {
      gp: arr.length,
      pa, ab, h, bb, bf,
      avg: +avg.toFixed(3),
      obp: +obp.toFixed(3),
      slg: +slg.toFixed(3),
      ops: +(obp + slg).toFixed(3),
    };
  };
  return {
    l10: aggregate(recent.slice(0, 10)),
    l5:  aggregate(recent.slice(0, 5)),
    l3:  aggregate(recent.slice(0, 3)),
    last: aggregate(recent.slice(0, 1)),
    lastDate: recent[0]?.date ?? null,
  };
}

// Per-PA exit velocity history for hitters. We fetch a game's play-by-play
// feed once and extract every batter's hit-data (EV / LA / pitch type / result).
// Returns Map<batterId, Array<PA>>.
async function fetchGamePerPaEv(gamePk) {
  const url = `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`;
  const data = await fetchJSON(url, `feed-live ${gamePk}`);
  const plays = data?.liveData?.plays?.allPlays ?? [];
  const gameDate = data?.gameData?.datetime?.officialDate ?? null;
  const out = new Map(); // batterId -> [{date, ev, la, dist, pitchType, velo, result}]
  for (const p of plays) {
    const m = p.matchup || {};
    const r = p.result || {};
    const batterId = m.batter?.id;
    if (!batterId) continue;
    const events = p.playEvents || [];
    // Find the LAST event of the PA with hitData (the contact event).
    const contactEvt = [...events].reverse().find((e) => e.hitData);
    const lastEvt = events[events.length - 1] || {};
    const hitData = contactEvt?.hitData;
    const pitchData = contactEvt?.pitchData || lastEvt?.pitchData || {};
    const details = contactEvt?.details || lastEvt?.details || {};
    const entry = {
      date: gameDate,
      gamePk,
      result: r.event || null,
      eventType: r.eventType || null,
      ev: hitData?.launchSpeed ?? null,
      la: hitData?.launchAngle ?? null,
      dist: hitData?.totalDistance ?? null,
      pitchType: details?.type?.code ?? null,
      pitchName: details?.type?.description ?? null,
      velo: pitchData?.startSpeed ?? null,
      isHit: !!r.event && ["Single","Double","Triple","Home Run"].includes(r.event),
      isHr: r.event === "Home Run",
    };
    if (!out.has(batterId)) out.set(batterId, []);
    out.get(batterId).push(entry);
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
      gamePk: s.game?.gamePk ?? null,
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
  const [savantHitters, savantPitchers, batterArsenal, pitcherArsenal] = await Promise.all([
    fetchSavantHitters(SEASON),
    fetchSavantPitchers(SEASON),
    fetchPitchArsenal(SEASON, "batter"),
    fetchPitchArsenal(SEASON, "pitcher"),
  ]);
  log(`  Savant hitters: ${savantHitters.size} · Savant pitchers: ${savantPitchers.size}`);
  log(`  Batter arsenal: ${batterArsenal.size} · Pitcher arsenal: ${pitcherArsenal.size}`);

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
      fetchHitterGameLog(id, 15),
    ]);
    const sv = savantHitters.get(id);
    if (sv) {
      if (l30 && sv.xwoba != null)     l30.xwoba = sv.xwoba;
      if (l30 && sv.barrelPct != null) l30.barrelPct = sv.barrelPct;
      if (l30 && sv.hardHitPct != null)l30.hardHitPct = sv.hardHitPct;
    }
    const arsenal = batterArsenal.get(id) ?? null;
    hitterStats[id] = { season, l7, l15, l30, ...meta, splits, recent7, savant: sv ?? null, pitchArsenal: arsenal };
    hCount++;
    if (hCount % 20 === 0) log(`  hitters: ${hCount}/${hitterMlbIds.length}`);
  }
  log(`hitters complete: ${hCount}/${hitterMlbIds.length}`);

  const pitcherStats = {};
  let pCount = 0;
  for (const id of pitcherMlbIds) {
    const [season, meta, splits, windowed] = await Promise.all([
      fetchPitcherSeason(id),
      getPlayerMeta(id),
      fetchPlatoonSplits(id, "pitching"),
      fetchPitcherWindowedSplits(id),
    ]);
    const sv = savantPitchers.get(id);
    const arsenal = pitcherArsenal.get(id) ?? null;
    pitcherStats[id] = { season, ...meta, splits, savant: sv ?? null, pitchArsenal: arsenal, windowed };
    pCount++;
    if (pCount % 10 === 0) log(`  pitchers: ${pCount}/${pitcherMlbIds.length}`);
  }
  log(`pitchers complete: ${pCount}/${pitcherMlbIds.length}`);

  // Per-PA exit velocity history. Fetch each game once and bucket by batter.
  // We pull the last ~5 days of completed games for every hitter in upcoming slates.
  log(`fetching per-PA exit velocity history...`);
  const perPaEv = {}; // batterId -> [PA entries, newest first]
  // Build set of recent gamePks to fetch: walk each hitter's recent7 (now 15) game log.
  const gamePksToFetch = new Set();
  const hitterRecentGames = new Map(); // batterId -> Set<gamePk>
  for (const [bId, h] of Object.entries(hitterStats)) {
    const games = h?.recent7 || [];
    // Widened to last 10 games so per-PA history has enough depth to compute
    // per-pitch-type BA/SLG/hr/avgEv on a L10-PA sample (matches PropFinder’s core workflow).
    const recent10 = games.slice(0, 10);
    const set = new Set();
    for (const g of recent10) {
      const gp = g?.gamePk;
      if (gp) {
        gamePksToFetch.add(gp);
        set.add(gp);
      }
    }
    hitterRecentGames.set(parseInt(bId, 10), set);
  }
  log(`  ${gamePksToFetch.size} unique game feeds to fetch for EV history`);
  let gpCount = 0;
  const gamePkList = [...gamePksToFetch];
  // Fetch in batches of 8 in parallel to keep StatsAPI happy.
  for (let i = 0; i < gamePkList.length; i += 8) {
    const batch = gamePkList.slice(i, i + 8);
    const results = await Promise.all(batch.map((gp) => fetchGamePerPaEv(gp).catch(() => new Map())));
    for (const gameMap of results) {
      for (const [bId, arr] of gameMap.entries()) {
        if (!perPaEv[bId]) perPaEv[bId] = [];
        perPaEv[bId].push(...arr);
      }
    }
    gpCount += batch.length;
    if (gpCount % 16 === 0 || gpCount === gamePkList.length) {
      log(`  EV feeds: ${gpCount}/${gamePkList.length}`);
    }
  }
  // Sort each batter's PA list newest-first by date+gamePk.
  for (const arr of Object.values(perPaEv)) {
    arr.sort((a, b) => {
      const dc = (b.date || "").localeCompare(a.date || "");
      if (dc !== 0) return dc;
      return (b.gamePk || 0) - (a.gamePk || 0);
    });
  }
  // Attach to hitterStats and trim to last 15 PA per batter (enough for a chart).
  // Use short field names to keep payload small on mobile.
  for (const [bIdStr, h] of Object.entries(hitterStats)) {
    const bId = parseInt(bIdStr, 10);
    const list = perPaEv[bId] || [];
    // Keep the last 40 PA — enough per-pitch depth (10-15 PA on primary pitch,
    // 3-8 on secondaries) to power the pitch-mix L10 table in PlayerDetail.
    h.perPaEv = list.slice(0, 40).map((e) => ({
      d: e.date,
      r: e.result,
      ev: e.ev,
      la: e.la,
      pt: e.pitchType,
      v: e.velo,
      hr: e.isHr ? 1 : 0,
      hit: e.isHit ? 1 : 0,
    }));
  }
  log(`per-PA EV complete: ${Object.keys(perPaEv).length} batters with history`);

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

  // Minified output (no indent) — saves ~40% on file size for mobile data costs.
  const slatesJson = JSON.stringify(slatesPayload);
  await fs.writeFile(SLATES_OUT, slatesJson);
  log(`wrote ${SLATES_OUT} (${(slatesJson.length / 1024).toFixed(0)} KB)`);
  log(`refresh complete · ${dates.length} slate days · today=${today}`);
}

main().catch((e) => {
  console.error("[statcast] fatal:", e);
  process.exit(1);
});
