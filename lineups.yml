#!/usr/bin/env node
// MatrixBaseball — lightweight lineups refresh (every 10 min).
// Pulls ONLY schedule + lineups + probable pitchers for T-1..T+1 from MLB StatsAPI.
// Writes lineups.json to the repo root. No Savant, no per-player stats, no BVP.
// Designed to finish in <30s so we can run it aggressively.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.GITHUB_WORKSPACE ? process.env.GITHUB_WORKSPACE : path.resolve(__dirname, "..");
const LINEUPS_OUT = path.resolve(REPO_ROOT, "lineups.json");
const SCHEDULE_DAYS_BACK = 1;
const SCHEDULE_DAYS_FWD = 1;

const log = (...a) => console.log("[lineups]", ...a);

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

async function buildSlate(dateStr, abbrMap) {
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
  log(`lineups refresh started · ${new Date().toISOString()}`);
  const abbrMap = await getTeamAbbr();
  log(`loaded ${Object.keys(abbrMap).length} team abbreviations`);

  const dates = dateRange();
  log(`fetching lineups for: ${dates.join(", ")}`);

  const slatesByDate = {};
  for (const d of dates) {
    slatesByDate[d] = await buildSlate(d, abbrMap);
  }

  const today = new Date().toISOString().slice(0, 10);

  const payload = {
    refreshedAt: new Date().toISOString(),
    today,
    dates,
    slates: slatesByDate,
  };

  const out = JSON.stringify(payload, null, 2);
  await fs.writeFile(LINEUPS_OUT, out);
  log(`wrote ${LINEUPS_OUT} (${(out.length / 1024).toFixed(0)} KB)`);
  log(`lineups refresh complete · ${dates.length} days · today=${today}`);
}

main().catch((e) => {
  console.error("[lineups] fatal:", e);
  process.exit(1);
});
