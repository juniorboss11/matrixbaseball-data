// Shared factor buckets for MatrixHockey (used by backtest + live model).
const cut = (v, edges, labels) => {
  if (v == null || !isFinite(v)) return "na";
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
};
const R5 = ["vlow", "low", "avg", "high", "vhigh"];

export const FACTORS = {
  slot: { label: "Line slot", desc: "Where he plays at even strength", f: (x) => x.slot || "X",
    order: ["L1", "L2", "L3", "L4", "D1", "D2", "D3", "X"],
    names: { L1: "Line 1", L2: "Line 2", L3: "Line 3", L4: "Line 4", D1: "D pair 1", D2: "D pair 2", D3: "D pair 3", X: "Unslotted" } },
  pp: { label: "Power play unit", desc: "PP1 vs PP2 vs no PP", f: (x) => (x.pu ? `PP${x.pu}` : "none"),
    order: ["PP1", "PP2", "none"], names: { PP1: "PP1", PP2: "PP2", none: "No PP" } },
  oppGA: { label: "Opponent goals allowed", desc: "Opp GA/gm vs league", f: (x) => cut(x.oppGA, [0.9, 0.97, 1.03, 1.1], R5),
    order: R5, names: { vlow: "Stingy (<0.90x)", low: "Tight (0.90-0.97x)", avg: "Average", high: "Leaky (1.03-1.10x)", vhigh: "Very leaky (>1.10x)" } },
  oppPos: { label: "Opp points allowed to his position", desc: "Pts the opponent gives up per game to C / LW / RW / D vs league", f: (x) => cut(x.oppPos, [0.88, 0.96, 1.04, 1.12], R5),
    order: R5, names: { vlow: "Shuts position down (<0.88x)", low: "Tough (0.88-0.96x)", avg: "Average", high: "Soft (1.04-1.12x)", vhigh: "Very soft (>1.12x)" } },
  ppEnv: { label: "Power-play matchup", desc: "For PP players: opponent PP goals allowed per game vs league", f: (x) => (x.pu ? cut(x.ppEnv, [0.85, 1.0, 1.15], ["tough", "avg-", "avg+", "soft"]) : "na"),
    order: ["tough", "avg-", "avg+", "soft", "na"], names: { tough: "Elite PK / disciplined", "avg-": "Slightly tough", "avg+": "Slightly soft", soft: "Leaky PK / takes penalties", na: "Not on PP" } },
  goalie: { label: "Opposing goalie", desc: "Starter's save % (blended with team) vs league", f: (x) => cut(x.goalie, [0.9, 0.97, 1.03, 1.1], R5),
    order: R5, names: { vlow: "Elite (<0.90x goals)", low: "Good", avg: "Average", high: "Weak", vhigh: "Very weak (>1.10x)" } },
  b2b: { label: "Back-to-back", desc: "Rest situation for his team / the opponent", f: (x) => (x.b2b && x.oppB2b ? "both" : x.b2b ? "self" : x.oppB2b ? "opp" : "none"),
    order: ["opp", "none", "self", "both"], names: { opp: "Opponent on B2B", none: "Both rested", self: "His team on B2B", both: "Both on B2B" } },
  home: { label: "Home / road", desc: "", f: (x) => (x.home ? "home" : "road"), order: ["home", "road"], names: { home: "Home", road: "Road" } },
  toi: { label: "Ice-time trend", desc: "Last 5 games TOI vs his norm", f: (x) => cut(x.toiR, [0.92, 0.98, 1.02, 1.08], R5),
    order: R5, names: { vlow: "Way down (<0.92x)", low: "Down", avg: "Steady", high: "Up", vhigh: "Way up (>1.08x)" } },
  mates: { label: "Linemate quality", desc: "Avg expected points of his linemates", f: (x) => cut(x.mates, [0.35, 0.5, 0.7, 0.9], R5),
    order: R5, names: { vlow: "Weak (<0.35)", low: "Below avg", avg: "Solid", high: "Strong", vhigh: "Elite (>0.90)" } },
  sogTrend: { label: "Shot trend", desc: "Last 5 games SOG vs his norm", f: (x) => cut(x.sogR, [0.75, 0.95, 1.1, 1.3], R5),
    order: R5, names: { vlow: "Cold (<0.75x)", low: "Cooling", avg: "Normal", high: "Heating up", vhigh: "Hot (>1.30x)" } },
  hot: { label: "Point streak form", desc: "Last 5 games points vs his norm", f: (x) => cut(x.hotR, [0.6, 0.9, 1.15, 1.5], R5),
    order: R5, names: { vlow: "Slumping", low: "Quiet", avg: "Normal", high: "Warm", vhigh: "Hot (>1.5x)" } },
  pace: { label: "Game environment", desc: "His team's goals for + opponent goals against vs league", f: (x) => cut(x.pace, [0.92, 0.98, 1.02, 1.08], R5),
    order: R5, names: { vlow: "Low-event", low: "Below avg", avg: "Average", high: "Above avg", vhigh: "High-event" } },
};
export const FACTOR_KEYS = Object.keys(FACTORS);
export const bucketsOf = (x) => Object.fromEntries(FACTOR_KEYS.map((k) => [k, FACTORS[k].f(x)]));
export function multFor(mult, target, buckets) {
  let m = 1;
  const M = mult?.[target];
  if (!M) return 1;
  for (const k of FACTOR_KEYS) m *= M[k]?.[buckets[k]] ?? 1;
  return Math.max(0.6, Math.min(1.6, m));
}
export const factorMeta = () => Object.fromEntries(FACTOR_KEYS.map((k) => [k, { label: FACTORS[k].label, desc: FACTORS[k].desc, order: FACTORS[k].order, names: FACTORS[k].names }]));

// Shared model math
export const HALF_LIFE = 25;
export const decayW = (i) => Math.pow(0.5, i / HALF_LIFE);
export function decayedMean(rowsNewestFirst, f, prior, k, wts = null) {
  let num = prior * k, den = k;
  rowsNewestFirst.forEach((r, i) => { const w = wts ? wts[i] : decayW(i); num += w * f(r); den += w; });
  return num / den;
}
// Season ramp: current-season games get a guaranteed share of the weight = n / (n + K),
// where n = current-season games played. Last season (plus any prior) fills the rest.
// K = 5 for teams and skaters: 17% current after 1 GP, 50% at 5, 67% at 10, 80% at 20, 91% at 50.
export const seasonShare = (n, K) => (n > 0 ? n / (n + K) : 0);
export function seasonWeights(rows, decay, isCur, K, priorK = 0) {
  const w = rows.map((_, i) => decay(i));
  const nC = rows.filter(isCur).length;
  if (!nC || !K) return w;
  let Wc = 0, Wp = priorK;
  rows.forEach((r, i) => (isCur(r) ? (Wc += w[i]) : (Wp += w[i])));
  if (Wp <= 0 || Wc <= 0) return w;
  const share = seasonShare(nC, K);
  const a = Math.max(1, (share / (1 - share)) * (Wp / Wc));
  return rows.map((r, i) => (isCur(r) ? w[i] * a : w[i]));
}
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const poisGE = (lam, k) => {
  let p = 0, t = Math.exp(-lam);
  for (let i = 0; i < k; i++) { p += t; t = (t * lam) / (i + 1); }
  return clamp(1 - p, 0, 1);
};
export const posPrior = { F: { pts: 0.45, g: 0.17, sog: 1.8 }, D: { pts: 0.3, g: 0.05, sog: 1.4 } };
// Base player lambdas from his log (newest first). Returns base lambdas + trend ratios.
export function baseLambdas(rows, isD, opts = {}) {
  const pr = posPrior[isD ? "D" : "F"];
  const K = 8;
  const wts = opts.isCur ? seasonWeights(rows, decayW, opts.isCur, opts.K ?? 5, K) : null;
  const lamPts = decayedMean(rows, (r) => r.pts, pr.pts, K, wts);
  const lamG = decayedMean(rows, (r) => r.g, pr.g, K, wts);
  const muSog = decayedMean(rows, (r) => r.sog, pr.sog, K, wts);
  const toiDec = decayedMean(rows, (r) => r.toi, isD ? 1200 : 900, 4, wts);
  const l5 = rows.slice(0, 5);
  const avg = (f) => (l5.length ? l5.reduce((a, r) => a + f(r), 0) / l5.length : null);
  const toiL5 = avg((r) => r.toi) ?? toiDec;
  const toiR = toiL5 / Math.max(1, toiDec);
  const toiF = Math.pow(clamp(toiR, 0.8, 1.2), 0.7);
  const sogR = l5.length >= 3 ? avg((r) => r.sog) / Math.max(0.3, muSog) : null;
  const hotR = l5.length >= 3 ? avg((r) => r.pts) / Math.max(0.1, lamPts) : null;
  return { lamPts, lamG, muSog, toiF, toiR: l5.length >= 3 ? toiR : null, sogR, hotR, n: rows.length };
}
// Opp adjustment (same as original live model)
export function applyContext(b, ctx) {
  const { oppGA, oppSA, oppSV, home } = ctx;
  const homeF = home ? 1.03 : 0.97;
  const pts = b.lamPts * oppGA * homeF * b.toiF;
  const g = b.lamG * Math.pow(oppSA, 0.4) * Math.pow(oppSV, 0.6) * homeF * b.toiF;
  const sog = b.muSog * Math.pow(oppSA, 0.7) * b.toiF;
  return { pts, g, sog };
}
export const probs = (lam) => ({ p1: poisGE(lam.pts, 1), p2: poisGE(lam.pts, 2), g1: poisGE(lam.g, 1), s3: poisGE(lam.sog, 3) });
