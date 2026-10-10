// client/src/lib/hockeyGradesCore.ts
var seasonShare = (n) => n > 0 ? n / (n + 5) : 0;
var roleGroup = (r) => r === "LD" || r === "RD" ? "D" : r ?? "C";
function rankMap(vals, highFirst = true) {
  const arr = Object.entries(vals).filter(([, v]) => v != null && isFinite(v));
  arr.sort((a, b) => highFirst ? b[1] - a[1] : a[1] - b[1]);
  return Object.fromEntries(arr.map(([t], i) => [t, i + 1]));
}
var rankScore = (rank, n = 32) => rank == null ? null : 1 - (rank - 1) / Math.max(1, n - 1);
var autoWin = (t) => {
  if (Object.values(t?.teams ?? {}).some((x) => x.blend)) return "blend";
  const gp = Object.values(t?.teams ?? {}).map((x) => x.cur?.gp ?? 0);
  return gp.length && Math.min(...gp) >= 10 ? "cur" : "prev";
};
var gradeLetter = (s) => s == null ? "\u2014" : s >= 90 ? "A+" : s >= 80 ? "A" : s >= 72 ? "B+" : s >= 64 ? "B" : s >= 56 ? "C+" : s >= 48 ? "C" : s >= 38 ? "D" : "F";
var gradeChip = (s) => s == null ? "bg-muted text-muted-foreground" : s >= 80 ? "bg-emerald-500/80 text-white" : s >= 64 ? "bg-emerald-500/30 text-emerald-900 dark:text-emerald-200" : s >= 48 ? "bg-amber-500/25 text-amber-900 dark:text-amber-200" : s >= 38 ? "bg-rose-500/25 text-rose-900 dark:text-rose-200" : "bg-rose-500/75 text-white";
var clamp01 = (x) => Math.max(0, Math.min(1, x));
var lin = (v, lo, hi) => v == null || !isFinite(v) ? null : Math.round(100 * clamp01((v - lo) / (hi - lo)));
var linc = (v, lo, hi) => v == null || !isFinite(v) ? null : Math.round(100 * Math.sqrt(clamp01((v - lo) / (hi - lo))));
var combine = (parts) => {
  const ps = parts.filter(Boolean);
  const W = ps.reduce((s, p) => s + p.weight, 0);
  if (!W) return null;
  const score = Math.round(ps.reduce((s, p) => s + p.score * p.weight, 0) / W);
  return { score, letter: gradeLetter(score), parts: ps, n: ps.length };
};
var f2 = (x, d = 2) => x == null || !isFinite(x) ? "\u2014" : x.toFixed(d);
function blendRates(p) {
  const a = p.w.prev, b = p.w.cur;
  const rate = (w, k) => w && w.gp > 0 ? w[k] / w.gp : null;
  const pick = (k) => {
    const x = rate(a, k), y = rate(b, k);
    if (x == null && y == null) return rate(p.w.l20, k);
    if (x == null) return y;
    if (y == null) return x;
    const s = seasonShare(b.gp);
    return (1 - s) * x + s * y;
  };
  const mix = (k) => {
    const x = a?.[k] ?? null, y = b?.[k] ?? null;
    if (x == null && y == null) return p.w.l20?.[k] ?? null;
    if (x == null) return y;
    if (y == null) return x;
    const s = seasonShare(b.gp);
    return (1 - s) * x + s * y;
  };
  return { pts: pick("pts"), g: pick("g"), sog: pick("sog"), toi: mix("toi"), pptoi: mix("pptoi"), gp: (a?.gp ?? 0) + (b?.gp ?? 0) };
}
function offensiveGrade(p) {
  const r = blendRates(p);
  const D = p.unit === "D";
  const edgeArr = [p.edge?.hdShotsPct, p.edge?.shotSpeedPct].filter((x) => x != null);
  const edge = edgeArr.length ? edgeArr.reduce((s, x) => s + x, 0) / edgeArr.length : null;
  const ppScore = r.pptoi != null ? linc(r.pptoi, 0, 3.5) : p.pp === 1 ? 85 : p.pp === 2 ? 45 : 5;
  const part = (label, score, weight, detail) => score == null ? null : { label, score, weight, detail };
  return combine([
    part("Points per game", linc(r.pts, D ? 0.1 : 0.25, D ? 0.95 : 1.3), 32, `${f2(r.pts)} / gm`),
    part("Goals per game", linc(r.g, D ? 0.02 : 0.08, D ? 0.28 : 0.6), 18, `${f2(r.g)} / gm`),
    part("Shots per game", linc(r.sog, D ? 0.7 : 1.2, D ? 3.5 : 4.5), 18, `${f2(r.sog, 1)} / gm`),
    part("Ice time", linc(r.toi, D ? 15 : 11, D ? 26 : 22), 10, `${f2(r.toi, 1)} min`),
    part("Power play role", ppScore, 12, r.pptoi != null ? `${f2(r.pptoi, 1)} PP min${p.pp ? ` \xB7 PP${p.pp}` : ""}` : p.pp ? `PP${p.pp}` : "no PP time"),
    part("NHL Edge shooting", edge == null ? null : Math.round(edge * 100), 10, edge == null ? "" : `${Math.round(edge * 100)}th pct (high-danger shots, shot speed)`)
  ]);
}
function matchupGrade(p, data, ctx) {
  const part = (label, score, weight, detail) => score == null ? null : { label, score, weight, detail };
  const rg = roleGroup(p.role ?? (p.unit === "D" ? "D" : p.pos));
  const pr = ctx.roleRank[p.opp]?.[rg];
  const slotKey = p.line ? `${p.unit === "D" ? "D" : "L"}${p.line}` : null;
  const sr = slotKey ? ctx.slotRank[p.opp]?.[slotKey] : void 0;
  const ppr = p.pp ? ctx.slotRank[p.opp]?.[`PP${p.pp}`] : void 0;
  const t = data.teams[p.opp];
  const s = t?.goalieByDate?.[p.date] ?? t?.goalie;
  const g = s && ctx.G ? ctx.G.goalies[s.id] : void 0;
  const live = ctx.T?.live.teams[p.opp];
  const oppGa = live?.gapg ?? null;
  const oppPk = ctx.ST?.teams[p.opp];
  const n = ctx.nTeams;
  const rs = (x) => x ? Math.round(100 * (rankScore(x.rank, n) ?? 0)) : null;
  const F = p.unit === "F";
  const ex = F && !ctx.teamOnly ? pairExposure(p, data, ctx.M) : null;
  const top = ex ? [...ex.pairs].sort((a, b) => b.share - a.share)[0] : null;
  const mix = ex ? ex.pairs.map((x) => `D${x.k} ${Math.round(x.share * 100)}%`).join(" \xB7 ") : "";
  return combine([
    part(`Opponent vs ${rg === "D" ? "D" : rg === "C" ? "centres" : rg === "L" ? "left wings" : "right wings"}`, rs(pr), ex ? 22 : 28, pr ? `${pr.v.toFixed(2)} pts/gm allowed \xB7 #${pr.rank} of ${n}` : ""),
    part(`Opponent vs ${slotKey ?? "line"}`, rs(sr), ex ? 8 : 12, sr ? `${sr.v.toFixed(2)} pts/gm allowed \xB7 #${sr.rank}` : ""),
    ex ? part("Pairs he'll face", lin(ex.ga60, 2.1, 3.1), 20, `${mix} \xB7 ${ex.ga60.toFixed(2)} GA/60 on ice${top ? ` \xB7 most vs D${top.k} ${top.names.join("-")}` : ""}${ex.trackedMin < 60 ? " \xB7 little tracked time, using his line's norm" : ` \xB7 ${ex.trackedMin} tracked min`}`) : null,
    ex ? part("Shots those pairs allow", lin(ex.sa60, 25.3, 30.8), 8, `${ex.sa60.toFixed(1)} SA/60 on ice at 5v5`) : null,
    part("Opposing goalie", g ? lin(-g.gsax60, -0.5, 0.5) : null, ex ? 20 : 22, g ? `${g.name}: ${g.gsax60 >= 0 ? "+" : ""}${g.gsax60.toFixed(2)} goals saved vs expected / gm${s?.status ? ` (${s.status})` : ""}` : ""),
    part("Opponent goals allowed", lin(oppGa, 2.5, 3.6), ex ? 8 : 13, oppGa != null ? `${oppGa.toFixed(2)} GA / gm (blend)` : ""),
    p.pp ? part("Their penalty kill", oppPk ? lin(oppPk.pkGa60, 4.5, 10) : rs(ppr), ex ? 8 : 10, oppPk ? `${oppPk.pkGa60.toFixed(1)} PK goals allowed / 60 \xB7 PK ${oppPk.pkPct != null ? (oppPk.pkPct * 100).toFixed(0) + "%" : "\u2014"}` : ppr ? `#${ppr.rank} vs PP${p.pp}` : "") : null,
    part("Model context", lin(p.m.mult?.pts, 0.85, 1.15), ex ? 12 : 15, p.m.mult ? `\xD7${p.m.mult.pts.toFixed(2)} pts from learned factors` : "")
  ]);
}
function onIce(M, pid) {
  const t = M?.players[pid];
  if (!t) return null;
  const s = [0, 0, 0, 0, 0];
  for (const v of Object.values(t)) for (let i = 0; i < 5; i++) s[i] += v[i];
  return s[0] > 0 ? s : null;
}
var LINE_PRIOR = { 1: [0.42, 0.34, 0.24], 2: [0.36, 0.36, 0.28], 3: [0.3, 0.36, 0.34], 4: [0.26, 0.36, 0.38] };
function pairExposure(p, data, M) {
  const L = data.lines[p.opp];
  if (!L?.D?.length) return null;
  const t = M?.players[p.pid] ?? {};
  const sec = ["D1", "D2", "D3"].map((k) => t[k]?.[0] ?? 0);
  const tot = sec.reduce((a, b) => a + b, 0);
  const pri = LINE_PRIOR[p.line ?? 2] ?? LINE_PRIOR[2];
  const K = 3600;
  const share = sec.map((x, i) => (x + pri[i] * K) / (tot + K));
  const opp = new Map(data.players.filter((x) => x.date === p.date && x.team === p.opp).map((x) => [x.pid, x]));
  const pairs = L.D.slice(0, 3).map((l, i) => {
    let ga = 0, sa = 0, h = 0;
    for (const id of l.ids) {
      const o = onIce(M, id);
      if (o) {
        ga += o[2];
        sa += o[4];
        h += o[0] / 3600;
      }
    }
    return { k: i + 1, names: l.ids.map((id) => opp.get(id)?.name.split(" ").slice(-1)[0] ?? "?"), ga60: (ga + 2.6 * 6) / (h + 6), sa60: (sa + 28 * 6) / (h + 6), share: share[i] ?? 0 };
  });
  const W = pairs.reduce((a, x) => a + x.share, 0) || 1;
  return {
    pairs,
    trackedMin: Math.round(tot / 60),
    ga60: pairs.reduce((a, x) => a + x.share * x.ga60, 0) / W,
    sa60: pairs.reduce((a, x) => a + x.share * x.sa60, 0) / W
  };
}
function defensiveGrade(p, ctx) {
  const part = (label, score, weight, detail) => score == null ? null : { label, score, weight, detail };
  const oi = onIce(ctx.M, p.pid);
  const h = oi ? oi[0] / 3600 : 0;
  const ga60 = oi && h > 0.5 ? oi[2] / h : null, sa60 = oi && h > 0.5 ? oi[4] / h : null;
  const share = oi && oi[3] + oi[4] > 20 ? oi[3] / (oi[3] + oi[4]) : null;
  const st = ctx.ST?.players[p.pid];
  const r = blendRates(p);
  return combine([
    part("5v5 goals against / 60", lin(ga60, 3.4, 1.6), 30, ga60 != null ? `${ga60.toFixed(2)} on ice (${h.toFixed(0)} h)` : ""),
    part("5v5 shots against / 60", lin(sa60, 36, 24), 18, sa60 != null ? `${sa60.toFixed(1)} on ice` : ""),
    part("Shot share on ice", share == null ? null : lin(share, 0.42, 0.58), 12, share != null ? `${(share * 100).toFixed(0)}% of 5v5 shots` : ""),
    part("Penalty-kill usage", st ? linc(st.pkMin, 0, 3.5) : null, 12, st ? `${st.pkMin.toFixed(1)} PK min / gm` : ""),
    part("PK goals against / 60", st?.pkGa60 != null ? lin(st.pkGa60, 10, 4) : null, 10, st?.pkGa60 != null ? `${st.pkGa60.toFixed(1)} while killing` : ""),
    part("Ice time", lin(r.toi, p.unit === "D" ? 15 : 11, p.unit === "D" ? 25 : 21), 18, `${f2(r.toi, 1)} min`)
  ]);
}
var PAIR_PRIOR = { 1: [0.4, 0.3, 0.18, 0.12], 2: [0.3, 0.3, 0.22, 0.18], 3: [0.2, 0.27, 0.28, 0.25] };
function lineExposure(p, data, M) {
  const L = data.lines[p.opp];
  if (!L?.F?.length) return null;
  const t = M?.players[p.pid] ?? {};
  const sec = ["L1", "L2", "L3", "L4"].map((k) => t[k]?.[0] ?? 0);
  const tot = sec.reduce((a, b) => a + b, 0);
  const pri = PAIR_PRIOR[p.line ?? 2] ?? PAIR_PRIOR[2];
  const K = 3600;
  const share = sec.map((x, i) => (x + pri[i] * K) / (tot + K));
  const opp = new Map(data.players.filter((x) => x.date === p.date && x.team === p.opp).map((x) => [x.pid, x]));
  const lines = L.F.slice(0, 4).map((l, i) => {
    const ps = l.ids.map((id) => opp.get(id)).filter(Boolean);
    const pts = l.ids.reduce((acc, id) => acc + (opp.get(id) ? blendRates(opp.get(id)).pts ?? 0.3 : 0.3), 0);
    let gf = 0, h = 0;
    for (const id of l.ids) {
      const o = onIce(M, id);
      if (o) {
        gf += o[1];
        h += o[0] / 3600;
      }
    }
    const gf60 = (gf + 2.6 * 9) / (h + 9);
    return { k: i + 1, names: ps.map((x) => x.name.split(" ").slice(-1)[0]), pts, gf60, share: share[i] ?? 0 };
  });
  const W = lines.reduce((a, l) => a + l.share, 0) || 1;
  return {
    lines,
    trackedMin: Math.round(tot / 60),
    pts: lines.reduce((a, l) => a + l.share * l.pts, 0) / W,
    gf60: lines.reduce((a, l) => a + l.share * l.gf60, 0) / W
  };
}
function defensiveMatchupGrade(p, data, ctx) {
  const part = (label, score, weight, detail) => score == null ? null : { label, score, weight, detail };
  const o = ctx.offRank[p.opp];
  const n = ctx.nTeams;
  const inv = (x) => x ? Math.round(100 * (1 - (rankScore(x.rank, n) ?? 0))) : null;
  const oppPp = ctx.ST?.teams[p.opp];
  const t = data.teams[p.team];
  const s = t?.goalieByDate?.[p.date] ?? t?.goalie;
  const g = s && ctx.G ? ctx.G.goalies[s.id] : void 0;
  const st = ctx.ST?.players[p.pid];
  const ex = ctx.teamOnly ? null : lineExposure(p, data, ctx.M);
  const top = ex ? [...ex.lines].sort((a, b) => b.share - a.share)[0] : null;
  const mix = ex ? ex.lines.map((l) => `L${l.k} ${Math.round(l.share * 100)}%`).join(" \xB7 ") : "";
  return combine([
    ex ? part("Lines he'll face", lin(ex.pts, 2.4, 1.1), 30, `${mix} \xB7 faces ${ex.pts.toFixed(2)} line pts/gm${top ? ` \xB7 most vs L${top.k} ${top.names.join("-")}` : ""}`) : part("Opponent goals for", inv(o?.gf), 30, o?.gf ? `${o.gf.v.toFixed(2)} GF / gm \xB7 #${o.gf.rank} of ${n}` : ""),
    ex ? part("Those lines at 5v5", lin(ex.gf60, 3.5, 2), 20, `${ex.gf60.toFixed(2)} GF/60 on ice (shrunk to league early)${ex.trackedMin < 60 ? " \xB7 little tracked time, using his pair's norm" : ` \xB7 ${ex.trackedMin} tracked min`}`) : null,
    part("Opponent goals for", inv(o?.gf), ex ? 12 : 22, o?.gf ? `${o.gf.v.toFixed(2)} GF / gm \xB7 #${o.gf.rank} of ${n}` : ""),
    st && st.pkMin >= 0.5 ? part("Their power play", oppPp ? lin(oppPp.ppGf60, 9, 4) : null, 13, oppPp ? `${oppPp.ppGf60.toFixed(1)} PP goals / 60 \xB7 PP ${oppPp.ppPct != null ? (oppPp.ppPct * 100).toFixed(0) + "%" : "\u2014"}` : "") : null,
    part("Own goalie", g ? lin(g.gsax60, -0.5, 0.5) : null, 20, g ? `${g.name}: ${g.gsax60 >= 0 ? "+" : ""}${g.gsax60.toFixed(2)} goals saved vs expected / gm` : "")
  ]);
}
function buildGradeCtx(T, G, ST, M) {
  const roleRank = {}, slotRank = {}, offRank = {};
  let nTeams = 32;
  if (T) {
    const w = autoWin(T);
    nTeams = Object.keys(T.teams).length;
    for (const rg of ["C", "L", "R", "D"]) {
      const vals = Object.fromEntries(Object.entries(T.teams).map(([t, x]) => [t, x[w]?.a.role[rg][0] ?? null]));
      const rk = rankMap(vals);
      for (const [t, v] of Object.entries(vals)) if (v != null) (roleRank[t] ??= {})[rg] = { v, rank: rk[t] };
    }
    for (const sl of ["L1", "L2", "L3", "L4", "D1", "D2", "D3", "PP1", "PP2"]) {
      const vals = Object.fromEntries(Object.entries(T.teams).map(([t, x]) => [t, x[w]?.a.slot[sl][0] ?? null]));
      const rk = rankMap(vals);
      for (const [t, v] of Object.entries(vals)) if (v != null) (slotRank[t] ??= {})[sl] = { v, rank: rk[t] };
    }
    const gf = Object.fromEntries(Object.entries(T.teams).map(([t, x]) => [t, x[w]?.f.g ?? null]));
    const l1 = Object.fromEntries(Object.entries(T.teams).map(([t, x]) => [t, x[w]?.f.slot.L1[0] ?? null]));
    const sf = Object.fromEntries(Object.entries(T.teams).map(([t, x]) => [t, x[w]?.f.sog ?? null]));
    const rG = rankMap(gf), rL = rankMap(l1), rS = rankMap(sf);
    for (const t of Object.keys(T.teams)) offRank[t] = {
      gf: gf[t] != null ? { v: gf[t], rank: rG[t] } : null,
      l1: l1[t] != null ? { v: l1[t], rank: rL[t] } : null,
      sf: sf[t] != null ? { v: sf[t], rank: rS[t] } : null
    };
  }
  return { T, G, ST, M, roleRank, slotRank, offRank, nTeams };
}
function gradePlayer(p, data, ctx) {
  return {
    off: offensiveGrade(p),
    mu: matchupGrade(p, data, ctx),
    def: p.unit === "D" ? defensiveGrade(p, ctx) : null,
    dmu: p.unit === "D" ? defensiveMatchupGrade(p, data, ctx) : null
  };
}
export {
  blendRates,
  buildGradeCtx,
  defensiveGrade,
  defensiveMatchupGrade,
  gradeChip,
  gradeLetter,
  gradePlayer,
  lineExposure,
  matchupGrade,
  offensiveGrade,
  pairExposure
};
