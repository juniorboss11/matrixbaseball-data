// Per-hand pitcher arsenal via Statcast search.
// Savant's leaderboard pitch-arsenal-stats endpoint silently ignores hand= param,
// so we iterate: (10 pitch types) x (2 batter hands) = 20 requests total.
// Each request returns all pitchers who threw that pitch to that hand this season.

// Statcast pitch codes we care about. FF/SI/SL/SW/CH/CU/FC/KC/ST/FS covers >99%.
const PITCH_CODES = ["FF", "SI", "SL", "SW", "CH", "CU", "FC", "KC", "ST", "FS"];

const CSV_UA = "Mozilla/5.0 (compatible; MatrixBaseballBot/1.0)";

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQ = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { out.push(cur); cur = ""; }
      else if (ch === '"') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

function num(s) {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function fetchOneSlice(season, pitchCode, hand) {
  const url = `https://baseballsavant.mlb.com/statcast_search/csv?all=true&hfSea=${season}%7C&player_type=pitcher&batter_stands=${hand}&hfPT=${pitchCode}%7C&min_pitches=0&min_results=0&min_pas=0&group_by=name`;
  const res = await fetch(url, { headers: { "User-Agent": CSV_UA } });
  if (!res.ok) throw new Error(`Savant per-hand ${pitchCode} ${hand} HTTP ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (lines.length < 2) return [];
  // First row is header. Strip BOM.
  const header = parseCsvLine(lines[0].replace(/^\uFEFF/, ""));
  const idx = {
    pitches: header.indexOf("pitches"),
    playerId: header.indexOf("player_id"),
    totalPitches: header.indexOf("total_pitches"),
    pitchPercent: header.indexOf("pitch_percent"),
    ba: header.indexOf("ba"),
    slg: header.indexOf("slg"),
    woba: header.indexOf("woba"),
    xwoba: header.indexOf("xwoba"),
    whiffs: header.indexOf("whiffs"),
    swings: header.indexOf("swings"),
    pa: header.indexOf("pa"),
    hardHit: header.indexOf("hardhit_percent"),
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const playerId = num(cols[idx.playerId]);
    if (!playerId) continue;
    const swings = num(cols[idx.swings]);
    const whiffs = num(cols[idx.whiffs]);
    const whiffPct = (swings && swings > 0 && whiffs != null) ? +(whiffs * 100 / swings).toFixed(1) : null;
    rows.push({
      playerId,
      pitchType: pitchCode,
      usage: num(cols[idx.pitchPercent]),          // % of that pitcher's pitches
      pa: num(cols[idx.pa]),
      ba: num(cols[idx.ba]),
      slg: num(cols[idx.slg]),
      woba: num(cols[idx.woba]),
      xwoba: num(cols[idx.xwoba]),
      whiffPct,
      hardHitPct: num(cols[idx.hardHit]),
    });
  }
  return rows;
}

/**
 * Fetch per-hand arsenal for every pitcher who threw one of the tracked pitches this season.
 * Returns { L: Map<mlbId, Entry[]>, R: Map<mlbId, Entry[]> }.
 * ~20 HTTP calls total.
 */
export async function fetchPerHandArsenal(season, { log = () => {} } = {}) {
  const L = new Map();
  const R = new Map();
  const push = (map, row) => {
    const arr = map.get(row.playerId) ?? [];
    arr.push(row);
    map.set(row.playerId, arr);
  };
  // Run in parallel — Savant tolerates ~20 concurrent CSVs fine
  const jobs = [];
  for (const pt of PITCH_CODES) {
    for (const hand of ["L", "R"]) {
      jobs.push(fetchOneSlice(season, pt, hand).then(rows => ({ pt, hand, rows })));
    }
  }
  const results = await Promise.all(jobs);
  for (const { pt, hand, rows } of results) {
    const map = hand === "L" ? L : R;
    for (const row of rows) push(map, row);
    log(`  per-hand ${pt} vs${hand}: ${rows.length} pitchers`);
  }
  // Sort each pitcher's entries by usage desc so downstream code can trust ordering
  for (const map of [L, R]) {
    for (const [, arr] of map) arr.sort((a, b) => (b.usage ?? 0) - (a.usage ?? 0));
  }
  return { L, R };
}
