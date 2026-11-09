// client/src/lib/hockeyGradesCore.ts
var seasonShare = (n) => n > 0 ? n / (n + 5) : 0;
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

// client/src/lib/hockeyFormCore.ts
var FORM_WINS = [
  { k: "g1", n: 1, label: "Last" },
  { k: "l3", n: 3, label: "L3" },
  { k: "l7", n: 7, label: "L7" },
  { k: "l14", n: 14, label: "L14" }
];
var seasonShare2 = (n) => n > 0 ? n / (n + 5) : 0;
var clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
var roleGroup = (r) => r === "LD" || r === "RD" ? "D" : r ?? "C";
var ROLE_IDX = { C: 0, L: 1, R: 2, D: 3 };
var SLOTS = ["L1", "L2", "L3", "L4", "D1", "D2", "D3", "PP1", "PP2"];
function sides(TL, gid, team) {
  const g = TL.games[gid];
  if (!g) return null;
  if (g.a === team) return { own: g.sd[0], opp: g.sd[1] };
  if (g.h === team) return { own: g.sd[1], opp: g.sd[0] };
  return null;
}
function rankOf(vals) {
  const arr = Object.entries(vals).filter(([, v]) => isFinite(v)).sort((a, b) => b[1] - a[1]);
  const out = {};
  arr.forEach(([t, v], i) => out[t] = i > 0 && Math.abs(v - arr[i - 1][1]) < 1e-9 ? out[arr[i - 1][0]] : i + 1);
  return out;
}
function buildFormCtx(TL) {
  const win = {}, rank = {};
  if (!TL) return { win, rank, nTeams: 32 };
  const teams = Object.keys(TL.teams);
  for (const { n } of FORM_WINS) {
    const W = {};
    for (const t of teams) {
      const ids = TL.teams[t].slice(0, n);
      const acc = { gp: 0, role: [0, 0, 0, 0], slot: SLOTS.map(() => 0), ga: 0, ppgA: 0, pen: 0, gf: 0, sf: 0, sa: 0, l1F: 0, ppgF: 0, penDrawn: 0, esD: [0, 1, 2].map(() => [0, 0, 0, 0, 0]) };
      for (const id of ids) {
        const s = sides(TL, id, t);
        if (!s) continue;
        acc.gp++;
        s.opp.role.forEach((x, i) => acc.role[i] += x[0]);
        s.opp.slot.forEach((x, i) => acc.slot[i] += x[0]);
        acc.ga += s.opp.gf;
        acc.ppgA += s.opp.ppg;
        acc.pen += s.own.pen;
        acc.gf += s.own.gf;
        acc.sf += s.own.sf;
        acc.sa += s.opp.sf;
        acc.l1F += s.own.slot[0]?.[0] ?? 0;
        acc.ppgF += s.own.ppg;
        acc.penDrawn += s.opp.pen;
        for (let k = 0; k < 3; k++) {
          const e = s.own.es[4 + k];
          if (e) for (let j = 0; j < 5; j++) acc.esD[k][j] += e[j];
        }
      }
      if (acc.gp) W[t] = acc;
    }
    win[n] = W;
    const per = (f) => Object.fromEntries(Object.entries(W).map(([t, w]) => [t, f(w) / w.gp]));
    const R = {};
    ["C", "L", "R", "D"].forEach((rg) => R[`role${rg}`] = rankOf(per((w) => w.role[ROLE_IDX[rg]])));
    SLOTS.forEach((sl, i) => R[`slot${sl}`] = rankOf(per((w) => w.slot[i])));
    R.ga = rankOf(per((w) => w.ga));
    R.gf = rankOf(per((w) => w.gf));
    R.sf = rankOf(per((w) => w.sf));
    R.l1F = rankOf(per((w) => w.l1F));
    R.pp = rankOf(Object.fromEntries(Object.entries(W).filter(([, w]) => w.penDrawn > 0).map(([t, w]) => [t, w.ppgF / w.penDrawn])));
    R.sa = rankOf(per((w) => w.sa));
    R.pk = rankOf(Object.fromEntries(Object.entries(W).filter(([, w]) => w.pen > 0).map(([t, w]) => [t, w.ppgA / w.pen])));
    rank[n] = R;
  }
  return { TL, win, rank, nTeams: teams.length || 32 };
}
var ratioTilt = (v, s, floor) => v == null || s == null ? null : clamp((v - s) / Math.max(s, floor) / 0.5);
function offenseRows(p) {
  const r = blendRates(p);
  const log = p.log ?? [];
  const wins = FORM_WINS.map(({ n }) => log.slice(0, n));
  const hit = (w, f) => w.length ? w.filter(f).length / w.length : null;
  const avg = (w, i) => w.length ? w.reduce((s, x) => s + x[i], 0) / w.length : null;
  const a = p.w.prev, b = p.w.cur;
  const sHit = (k) => {
    const x = a?.[k] ?? null, y = b?.[k] ?? null;
    if (x == null && y == null) return p.w.l20?.[k] ?? null;
    if (x == null) return y;
    if (y == null) return x;
    const s = seasonShare2(b.gp);
    return (1 - s) * x + s * y;
  };
  const row = (key, label, season, fmt, val, tilt) => ({
    key,
    label,
    season,
    fmt,
    cells: wins.map((w) => {
      const v = val(w);
      return { v, n: w.length, tilt: tilt(v) };
    })
  });
  return [
    row("pts", "Points / gm", r.pts, "rate2", (w) => avg(w, 4), (v) => ratioTilt(v, r.pts, 0.25)),
    row("g", "Goals / gm", r.g, "rate2", (w) => avg(w, 2), (v) => ratioTilt(v, r.g, 0.12)),
    row("sog", "Shots / gm", r.sog, "rate1", (w) => avg(w, 5), (v) => ratioTilt(v, r.sog, 1)),
    row("toi", "Ice time", r.toi, "min", (w) => avg(w, 6), (v) => v == null || r.toi == null ? null : clamp((v - r.toi) / 3)),
    row("pptoi", "PP minutes", r.pptoi, "min", (w) => avg(w, 7), (v) => v == null || r.pptoi == null ? null : clamp((v - r.pptoi) / 1.5)),
    row("p1", "1+ point games", sHit("p1"), "pct", (w) => hit(w, (x) => x[4] >= 1), (v) => v == null || sHit("p1") == null ? null : clamp((v - sHit("p1")) / 0.3)),
    row("g1", "Goal games", sHit("g1"), "pct", (w) => hit(w, (x) => x[2] >= 1), (v) => v == null || sHit("g1") == null ? null : clamp((v - sHit("g1")) / 0.25)),
    row("s3", "3+ shot games", sHit("s3"), "pct", (w) => hit(w, (x) => x[5] >= 3), (v) => v == null || sHit("s3") == null ? null : clamp((v - sHit("s3")) / 0.3))
  ];
}
function matchupRows(p, data, ctx, F) {
  const rows = [];
  if (!F.TL) return rows;
  const opp = p.opp;
  const rg = roleGroup(p.role ?? (p.unit === "D" ? "D" : p.pos));
  const nm = rg === "D" ? "D" : rg === "C" ? "centres" : rg === "L" ? "left wings" : "right wings";
  const cellsFor = (val, rankKey, season, tiltF) => FORM_WINS.map(({ n }) => {
    const w = F.win[n]?.[opp];
    if (!w) return { v: null, n: 0, tilt: null };
    const v = val(w);
    return { v, n: w.gp, rank: F.rank[n]?.[rankKey]?.[opp] ?? null, tilt: tiltF(v) };
  });
  const pr = ctx.roleRank[opp]?.[rg];
  rows.push({
    key: "role",
    label: `Opp vs ${nm}`,
    season: pr?.v ?? null,
    seasonRank: pr?.rank ?? null,
    fmt: "rate2",
    cells: cellsFor((w) => w.role[ROLE_IDX[rg]] / w.gp, `role${rg}`, pr?.v ?? null, (v) => ratioTilt(v, pr?.v ?? null, 0.2)),
    note: "pts allowed / gm"
  });
  const slotKey = p.line ? `${p.unit === "D" ? "D" : "L"}${p.line}` : null;
  if (slotKey) {
    const sr = ctx.slotRank[opp]?.[slotKey];
    const si = SLOTS.indexOf(slotKey);
    rows.push({
      key: "slot",
      label: `Opp vs ${slotKey}`,
      season: sr?.v ?? null,
      seasonRank: sr?.rank ?? null,
      fmt: "rate2",
      cells: cellsFor((w) => w.slot[si] / w.gp, `slot${slotKey}`, sr?.v ?? null, (v) => ratioTilt(v, sr?.v ?? null, 0.2)),
      note: "pts allowed / gm"
    });
  }
  if (p.pp) {
    const sl = `PP${p.pp}`, sr = ctx.slotRank[opp]?.[sl], si = SLOTS.indexOf(sl);
    rows.push({
      key: "pp",
      label: `Opp vs ${sl}`,
      season: sr?.v ?? null,
      seasonRank: sr?.rank ?? null,
      fmt: "rate2",
      cells: cellsFor((w) => w.slot[si] / w.gp, `slot${sl}`, sr?.v ?? null, (v) => ratioTilt(v, sr?.v ?? null, 0.2)),
      note: "pts allowed / gm"
    });
    const st = ctx.ST?.teams[opp];
    const sPk = st?.pkPct ?? null;
    rows.push({
      key: "pk",
      label: "Their PK %",
      season: sPk,
      fmt: "pct",
      cells: cellsFor((w) => w.pen ? 1 - w.ppgA / w.pen : null, "pk", sPk, (v) => v == null || sPk == null ? null : clamp((sPk - v) / 0.1)),
      note: "1 - PP goals allowed per penalty taken"
    });
  }
  const live = ctx.T?.live.teams[opp];
  const sGa = live?.gapg ?? null;
  rows.push({
    key: "ga",
    label: "Opp goals allowed",
    season: sGa,
    fmt: "rate2",
    cells: cellsFor((w) => w.ga / w.gp, "ga", sGa, (v) => ratioTilt(v, sGa, 2.5)),
    note: "/ gm"
  });
  const gr = goalieRow(opp, p.date, data, ctx, F, "opp");
  if (gr) rows.push(gr);
  return rows;
}
function goalieRow(team, date, data, ctx, F, side) {
  const t = data.teams[team];
  const s = t?.goalieByDate?.[date] ?? t?.goalie;
  if (!s || !F.TL) return null;
  const starts = [];
  for (const id of F.TL.teams[team] ?? []) {
    const sd = sides(F.TL, id, team);
    const x = sd?.own.gl.find((q) => q[0] === s.id);
    if (x && x[1] >= 10) starts.push([x[1], x[2]]);
  }
  const sSv = ctx.G?.goalies[s.id]?.sv ?? s.svPct ?? null;
  const sign = side === "opp" ? 1 : -1;
  return {
    key: "gsv",
    label: `${s.name.split(" ").slice(-1)[0]} save %`,
    season: sSv,
    fmt: "sv",
    cells: FORM_WINS.map(({ n }) => {
      const w = starts.slice(0, n);
      if (!w.length) return { v: null, n: 0, tilt: null };
      const sa = w.reduce((a, q) => a + q[0], 0), ga = w.reduce((a, q) => a + q[1], 0);
      const v = sa ? 1 - ga / sa : null;
      return { v, n: w.length, tilt: v == null || sSv == null ? null : clamp(sign * (sSv - v) / 0.03) };
    }),
    note: `${s.status ?? "projected"} starter, his starts`
  };
}
function defenseRows(p, ctx, F) {
  if (!F.TL || p.unit !== "D") return [];
  const team = p.team, k = Math.min(3, Math.max(1, p.line ?? 2)) - 1, slot = `D${k + 1}`;
  const oi = (() => {
    const t = ctx.M?.players[p.pid];
    if (!t) return null;
    const s = [0, 0, 0, 0, 0];
    for (const v of Object.values(t)) for (let i = 0; i < 5; i++) s[i] += v[i];
    return s[0] > 1800 ? s : null;
  })();
  const sGa60 = oi ? oi[2] / (oi[0] / 3600) : null, sSa60 = oi ? oi[4] / (oi[0] / 3600) : null, sShare = oi && oi[3] + oi[4] > 0 ? oi[3] / (oi[3] + oi[4]) : null;
  const cell = (val, tilt, rankKey) => FORM_WINS.map(({ n }) => {
    const w = F.win[n]?.[team];
    if (!w) return { v: null, n: 0, tilt: null };
    const v = val(w);
    return { v, n: w.gp, rank: rankKey ? F.rank[n]?.[rankKey]?.[team] ?? null : void 0, tilt: tilt(v) };
  });
  const es = (w) => w.esD[k];
  const per60 = (w, j) => {
    const e = es(w);
    return e[0] > 600 ? e[j] / (e[0] / 3600) : null;
  };
  const inv = (v, s, scale) => v == null || s == null ? null : clamp((s - v) / scale);
  const live = ctx.T?.live.teams[team];
  const sGa = live?.gapg ?? null;
  const sPk = ctx.ST?.teams[team]?.pkPct ?? null;
  const r = blendRates(p);
  const log = p.log ?? [];
  return [
    {
      key: "pga",
      label: `${slot} pair 5v5 GA/60`,
      season: sGa60,
      fmt: "rate2",
      note: "his pair slot on ice (whoever played " + slot + " that night); season = his own on-ice",
      cells: cell((w) => per60(w, 2), (v) => inv(v, sGa60, 1.2))
    },
    {
      key: "psa",
      label: `${slot} pair 5v5 SA/60`,
      season: sSa60,
      fmt: "rate1",
      note: "shots against on ice at 5v5",
      cells: cell((w) => per60(w, 4), (v) => inv(v, sSa60, 8))
    },
    {
      key: "psh",
      label: `${slot} pair shot share`,
      season: sShare,
      fmt: "pct",
      note: "share of 5v5 shots on ice",
      cells: cell((w) => {
        const e = es(w);
        return e[3] + e[4] > 0 ? e[3] / (e[3] + e[4]) : null;
      }, (v) => v == null || sShare == null ? null : clamp((v - sShare) / 0.08))
    },
    {
      key: "tga",
      label: `${team} goals against`,
      season: sGa,
      seasonRank: null,
      fmt: "rate2",
      note: "/ gm (#1 = allows most)",
      cells: cell((w) => w.ga / w.gp, (v) => inv(v, sGa, 1.2), "ga")
    },
    {
      key: "tsa",
      label: `${team} shots against`,
      season: live?.sapg ?? null,
      fmt: "rate1",
      note: "/ gm (#1 = allows most)",
      cells: cell((w) => w.sa / w.gp, (v) => inv(v, live?.sapg ?? null, 5), "sa")
    },
    {
      key: "tpk",
      label: `${team} PK %`,
      season: sPk,
      fmt: "pct",
      note: "1 - PP goals allowed per penalty taken (#1 = leakiest)",
      cells: cell((w) => w.pen ? 1 - w.ppgA / w.pen : null, (v) => v == null || sPk == null ? null : clamp((v - sPk) / 0.1), "pk")
    },
    {
      key: "toi",
      label: "His ice time",
      season: r.toi,
      fmt: "min",
      cells: FORM_WINS.map(({ n }) => {
        const w = log.slice(0, n);
        const v = w.length ? w.reduce((a, x) => a + x[6], 0) / w.length : null;
        return { v, n: w.length, tilt: v == null || r.toi == null ? null : clamp((v - r.toi) / 3) };
      })
    }
  ];
}
function defMatchupRows(p, data, ctx, F) {
  if (!F.TL || p.unit !== "D") return [];
  const opp = p.opp, o = ctx.offRank[opp];
  const cell = (val, rankKey, tilt) => FORM_WINS.map(({ n }) => {
    const w = F.win[n]?.[opp];
    if (!w) return { v: null, n: 0, tilt: null };
    const v = val(w);
    return { v, n: w.gp, rank: F.rank[n]?.[rankKey]?.[opp] ?? null, tilt: tilt(v) };
  });
  const inv = (v, s, floor) => v == null || s == null ? null : clamp(-(v - s) / Math.max(s, floor) / 0.5);
  const sPp = ctx.ST?.teams[opp]?.ppPct ?? null;
  const rows = [
    { key: "ogf", label: `${opp} goals / gm`, season: o?.gf?.v ?? null, seasonRank: o?.gf?.rank ?? null, fmt: "rate2", note: "#1 = scores most", cells: cell((w) => w.gf / w.gp, "gf", (v) => inv(v, o?.gf?.v ?? null, 2.5)) },
    { key: "osf", label: `${opp} shots / gm`, season: o?.sf?.v ?? null, seasonRank: o?.sf?.rank ?? null, fmt: "rate1", note: "#1 = shoots most", cells: cell((w) => w.sf / w.gp, "sf", (v) => inv(v, o?.sf?.v ?? null, 25)) },
    { key: "ol1", label: `${opp} L1 points / gm`, season: o?.l1?.v ?? null, seasonRank: o?.l1?.rank ?? null, fmt: "rate2", note: "points by their top line", cells: cell((w) => w.l1F / w.gp, "l1F", (v) => inv(v, o?.l1?.v ?? null, 1)) },
    { key: "opp", label: `${opp} PP %`, season: sPp, fmt: "pct", note: "PP goals per penalty drawn (#1 = most dangerous)", cells: cell((w) => w.penDrawn ? w.ppgF / w.penDrawn : null, "pp", (v) => v == null || sPp == null ? null : clamp((sPp - v) / 0.1)) }
  ];
  const g = goalieRow(p.team, p.date, data, ctx, F, "own");
  if (g) rows.push({ ...g, label: `${g.label} (his G)` });
  return rows;
}
function formScore(p, data, ctx, F, rows) {
  const off = rows?.off ?? offenseRows(p), mu = rows?.mu ?? matchupRows(p, data, ctx, F);
  const t = (rs, k, wi) => rs.find((r) => r.key === k)?.cells[wi]?.tilt ?? null;
  const mixW = (pairs) => {
    const ok = pairs.filter(([v]) => v != null);
    const W = ok.reduce((s, [, w]) => s + w, 0);
    return W ? ok.reduce((s, [v, w]) => s + v * w, 0) / W : null;
  };
  const side = (wi) => ({
    off: (p.log?.length ?? 0) >= FORM_WINS[wi].n * 0.6 ? mixW([[t(off, "pts", wi), 0.55], [t(off, "sog", wi), 0.3], [t(off, "toi", wi), 0.15]]) : null,
    mu: mixW([[t(mu, "role", wi), 0.5], [t(mu, "ga", wi), 0.25], [t(mu, "gsv", wi), 0.25]])
  });
  const a = side(2), b = side(3);
  const both = (x, y) => x == null ? y : y == null ? x : 0.6 * x + 0.4 * y;
  const o = both(a.off, b.off), m = both(a.mu, b.mu);
  const f = mixW([[o, 0.6], [m, 0.4]]);
  if (f == null) return null;
  const score = Math.round(20 * f);
  return { score, tag: score >= 5 ? "hot" : score <= -5 ? "cold" : "steady", off: o == null ? null : Math.round(20 * o), mu: m == null ? null : Math.round(20 * m) };
}
var formChip = (s) => s == null ? "bg-muted text-muted-foreground" : s >= 10 ? "bg-orange-500/85 text-white" : s >= 5 ? "bg-orange-400/30 text-orange-900 dark:text-orange-200" : s > -5 ? "bg-muted text-foreground/80" : s > -10 ? "bg-sky-400/30 text-sky-900 dark:text-sky-200" : "bg-sky-600/80 text-white";
var formLabel = (f) => f ? `${f.score > 0 ? "+" : ""}${f.score} ${f.tag}` : "\u2014";
export {
  FORM_WINS,
  buildFormCtx,
  defMatchupRows,
  defenseRows,
  formChip,
  formLabel,
  formScore,
  matchupRows,
  offenseRows
};
