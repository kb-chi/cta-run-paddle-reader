// Build the line every bus movement follows, for the animations.
//
// For each distinct in-service trip pattern (route + its time points in order) and each distinct
// out-of-service move (pullout, pull-in, deadhead: from → to) in the Weekday/Saturday/Sunday Parsed
// folders, find a path and how far along it each time point is:
//   1. in service: a CTA GTFS shape of the route (CTA GTFS/route-shapes.json) that passes all the
//      time points in order; failing that, an OSM route relation (osm/bus-routes.json);
//   2. otherwise, time point by time point: the GTFS/OSM line between the two points if one fits,
//      else a route over OSM streets (osm/streets.json), preferring arterials and obeying one-ways;
//   3. out of service: always over OSM streets.
//
// Usage: node animation/build-paths.mjs        → animation/paths.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { viaStreets, streetKeys } from "./via.js";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(project, ...p), "utf8"));

const COS = Math.cos((41.85 * Math.PI) / 180);
const meters = (a, b) => Math.hypot((b[1] - a[1]) * 111320, (b[0] - a[0]) * 111320 * COS);
const FIT = 200; // a time point "is on" a line if within this many meters

// ---------------------------------------------------------------- street graph
const streets = readJson("osm", "streets.json");
const FACTOR = { motorway: 0.75, trunk: 0.8, primary: 0.85, secondary: 0.9, tertiary: 1, unclassified: 1.1, residential: 1.4, living_street: 2, service: 1.6, busway: 0.8, bus_guideway: 0.8 };
const idOf = new Map();
const lon = [], lat = [], snapOk = [];
const edges = []; // [from, to, weight, meters, way index]
const wayKeys = []; // per way: the street keys a paddle note could call it by
for (const [wi, w] of streets.ways.entries()) {
  wayKeys.push(streetKeys(w.n, w.r, w.h));
  const cls = w.h.replace("*", "");
  const f = FACTOR[cls] ?? 1.2;
  const idx = w.nodes.map((id, i) => {
    let n = idOf.get(id);
    if (n === undefined) { n = lon.length; idOf.set(id, n); lon.push(w.c[i][0]); lat.push(w.c[i][1]); snapOk.push(false); }
    if (cls !== "motorway" && cls !== "trunk" && !w.h.endsWith("*")) snapOk[n] = true; // never snap a time point onto an expressway or ramp
    return n;
  });
  for (let i = 1; i < idx.length; i++) {
    const m = meters(w.c[i - 1], w.c[i]);
    if (w.o !== -1) edges.push([idx[i - 1], idx[i], m * f, m, wi]);
    if (w.o !== 1) edges.push([idx[i], idx[i - 1], m * f, m, wi]);
  }
}
const N = lon.length;
// keep only the biggest connected piece (pieces cut off by the download edge or by left-out alleys can't be reached)
const parent = Int32Array.from({ length: N }, (_, i) => i);
const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
for (const [a, b] of edges) parent[find(a)] = find(b);
const size = new Map();
for (let i = 0; i < N; i++) { const r = find(i); size.set(r, (size.get(r) ?? 0) + 1); }
const main = [...size].sort((a, b) => b[1] - a[1])[0][0];
// compressed adjacency (forward and, for the fallback, both ways)
function csr(list) {
  const start = new Int32Array(N + 1);
  for (const [a] of list) start[a + 1]++;
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const to = new Int32Array(list.length), wt = new Float64Array(list.length), way = new Int32Array(list.length), fill = start.slice(0, N);
  for (const [a, b, w, , wi] of list) { const k = fill[a]++; to[k] = b; wt[k] = w; way[k] = wi; }
  return { start, to, wt, way };
}
const G = csr(edges);
const G2 = csr(edges.flatMap((e) => [e, [e[1], e[0], e[2], e[3], e[4]]])); // ignoring one-ways, last resort
console.log(`street graph: ${N} nodes, ${edges.length} directed edges`);

// snap grid
const grid = new Map(), cell = (x, y) => `${Math.floor(x * 500)},${Math.floor(y * 500)}`;
for (let i = 0; i < N; i++) if (snapOk[i] && find(i) === main) { const k = cell(lon[i], lat[i]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
function snap(p) {
  const gx = Math.floor(p[0] * 500), gy = Math.floor(p[1] * 500);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= 6 && best === -1; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    for (const i of grid.get(`${gx + dx},${gy + dy}`) ?? []) { const d = meters(p, [lon[i], lat[i]]); if (d < bd) { bd = d; best = i; } }
  }
  return best;
}

// nodes of each named street (main piece only), for finding where a note's streets meet
const keyNodes = new Map();
for (const [wi, w] of streets.ways.entries()) for (const k of wayKeys[wi]) {
  if (!keyNodes.has(k)) keyNodes.set(k, new Set());
  for (const id of w.nodes) { const n = idOf.get(id); if (find(n) === main) keyNodes.get(k).add(n); }
}
const PREF = 0.3; // a street the note names costs this much of normal, so the route sticks to it

// A* (heuristic = straight distance × the cheapest factor, so it never overestimates).
// `prefer` = a street key whose edges are cheaper (PREF).
const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1), seen = new Uint8Array(N);
let touched = [];
// `targets` (a Set) = stop at the first of these nodes reached (all within `slack` m of t), e.g.
// either carriageway of an expressway; returns the path to whichever one it reached.
function astar(g, s, t, prefer = null, targets = null, slack = 0) {
  for (const i of touched) { dist[i] = Infinity; prev[i] = -1; seen[i] = 0; }
  touched = [s];
  const hf = prefer ? 0.75 * PREF : 0.75;
  const h = (i) => Math.max(0, Math.hypot((lat[t] - lat[i]) * 111320, (lon[t] - lon[i]) * 111320 * COS) - slack) * hf;
  const done = targets ? (u) => targets.has(u) : (u) => u === t;
  const cheap = prefer ? (k) => wayKeys[g.way[k]].includes(prefer) : () => false;
  const heapK = [], heapV = [];
  const push = (k, v) => { heapK.push(k); heapV.push(v); let i = heapK.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= k) break; heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p; } heapK[i] = k; heapV[i] = v; };
  const pop = () => { const v = heapV[0], k = heapK.pop(), w = heapV.pop(); if (heapK.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heapK.length) break; if (c + 1 < heapK.length && heapK[c + 1] < heapK[c]) c++; if (heapK[c] >= k) break; heapK[i] = heapK[c]; heapV[i] = heapV[c]; i = c; } heapK[i] = k; heapV[i] = w; } return v; };
  dist[s] = 0; push(h(s), s);
  while (heapK.length) {
    const u = pop();
    if (seen[u]) continue;
    seen[u] = 1;
    if (done(u)) { t = u; break; }
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const v = g.to[k], nd = dist[u] + (cheap(k) ? g.wt[k] * PREF : g.wt[k]);
      if (nd < dist[v]) { if (dist[v] === Infinity) touched.push(v); dist[v] = nd; prev[v] = u; push(nd + h(v), v); }
    }
  }
  if (!seen[t] || !done(t)) return null;
  const out = [];
  for (let u = t; u !== -1; u = prev[u]) out.push([lon[u], lat[u]]);
  out.reverse();
  out.end = t;
  return out;
}
const streetCache = new Map();
function streetPath(a, b) {
  const s = snap(a), t = snap(b);
  const key = `${s}>${t}`;
  if (streetCache.has(key)) return streetCache.get(key);
  let res;
  if (s === -1 || t === -1) res = { pts: [a, b], src: "straight" };
  else if (s === t) res = { pts: [[lon[s], lat[s]]], src: "streets" };
  else {
    const p = astar(G, s, t);
    res = p ? { pts: p, src: "streets" } : (astar(G2, s, t) ? { pts: astar(G2, s, t), src: "streets (ignoring one-ways)" } : { pts: [a, b], src: "straight" });
  }
  streetCache.set(key, res);
  return res;
}

// Follow a paddle note's streets in order, as one search over (street stage, node): stage i prefers
// the note's i-th street (PREF), and a bus may move up to stage i+1 at any node of the (i+1)-th street,
// so the best place to turn (and the right carriageway of a divided road) comes out of the search.
// Only streets with some part inside an ellipse around the trip count; the route must end on the last.
const lenOf = (pts) => pts.reduce((d, p, i) => (i ? d + meters(pts[i - 1], p) : 0), 0);
let lDist = new Float64Array(0), lPrev = new Int32Array(0), lSeen = new Uint8Array(0), lTouched = [];
function layered(g, s, t, sets, keys) {
  const K = sets.length, size = K * N;
  if (lDist.length < size) { lDist = new Float64Array(size).fill(Infinity); lPrev = new Int32Array(size).fill(-1); lSeen = new Uint8Array(size); lTouched = []; }
  for (const i of lTouched) { lDist[i] = Infinity; lPrev[i] = -1; lSeen[i] = 0; }
  lTouched = [s];
  const hf = 0.75 * PREF;
  const h = (i) => Math.hypot((lat[t] - lat[i]) * 111320, (lon[t] - lon[i]) * 111320 * COS) * hf;
  const heapK = [], heapV = [];
  const push = (k, v) => { heapK.push(k); heapV.push(v); let i = heapK.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heapK[p] <= k) break; heapK[i] = heapK[p]; heapV[i] = heapV[p]; i = p; } heapK[i] = k; heapV[i] = v; };
  const pop = () => { const v = heapV[0], k = heapK.pop(), w = heapV.pop(); if (heapK.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heapK.length) break; if (c + 1 < heapK.length && heapK[c + 1] < heapK[c]) c++; if (heapK[c] >= k) break; heapK[i] = heapK[c]; heapV[i] = heapV[c]; i = c; } heapK[i] = k; heapV[i] = w; } return v; };
  const relax = (from, to, nd) => { if (nd < lDist[to]) { if (lDist[to] === Infinity) lTouched.push(to); lDist[to] = nd; lPrev[to] = from; push(nd + h(to % N), to); } };
  // start on the first street's stage, or later ones if the start is already on them
  lDist[s] = 0; push(h(s), s);
  const goal = (K - 1) * N + t;
  while (heapK.length) {
    const st = pop();
    if (lSeen[st]) continue;
    lSeen[st] = 1;
    if (st === goal) break;
    const stage = Math.floor(st / N), u = st - stage * N;
    if (stage + 1 < K && sets[stage + 1].has(u)) relax(st, st + N, lDist[st]); // turn onto the next street here
    for (let k = g.start[u]; k < g.start[u + 1]; k++) {
      const w = wayKeys[g.way[k]].includes(keys[stage]) ? g.wt[k] * PREF : g.wt[k];
      relax(st, stage * N + g.to[k], lDist[st] + w);
    }
  }
  if (!lSeen[goal]) return null;
  const out = [];
  for (let st = goal; st !== -1; st = lPrev[st]) { const u = st % N; const p = [lon[u], lat[u]]; const l = out.at(-1); if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push(p); }
  return out.reverse();
}
function viaPath(a, b, keys) {
  const plain = streetPath(a, b);
  const s = snap(a), t = snap(b);
  if (s === -1 || t === -1 || !keys.length) return { ...plain, used: [] };
  const D = meters(a, b), inside = (n) => meters(a, [lon[n], lat[n]]) + meters([lon[n], lat[n]], b) <= D * 1.8 + 5000;
  const used = keys.filter((k) => keyNodes.has(k))
    .map((k) => ({ k, nodes: new Set([...keyNodes.get(k)].filter(inside)) })).filter((x) => x.nodes.size);
  if (!used.length) return { ...plain, used: [] };
  // the start counts as on the first street (a garage or terminal is usually just off it)
  const pts = layered(G, s, t, used.map((u) => u.nodes), used.map((u) => u.k)) ?? layered(G2, s, t, used.map((u) => u.nodes), used.map((u) => u.k));
  if (!pts || !pts.length) return { ...plain, used: [], failed: true };
  if (process.env.DEBUG_VIA && keys.join(" ").includes(process.env.DEBUG_VIA)) console.log("DEBUG " + JSON.stringify([used.map((u) => u.k), Math.round(lenOf(pts)), Math.round(lenOf(plain.pts))]));
  // a note route can be longer than the shortest, but not wildly (a sign something matched the wrong street)
  if (lenOf(pts) > 2.5 * lenOf(plain.pts) + 3000) return { ...plain, used: [], failed: true };
  return { pts, src: "streets (paddle note)", used: used.map((u) => u.k) };
}

// ---------------------------------------------------------------- route lines
const lines = new Map(); // route → [{ id, pts, cum }]
const addLine = (route, id, pts) => {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + meters(pts[i - 1], pts[i]));
  if (!lines.has(route)) lines.set(route, []);
  lines.get(route).push({ id, pts, cum });
};
for (const r of readJson("CTA GTFS", "route-shapes.json").routes) for (const s of r.shapes) addLine(r.route, `gtfs:${s.shapeId}`, s.path.map(([x, y]) => [x, y]));
// OSM relations go after the GTFS shapes, under "osm|<route>", so GTFS wins a tie
for (const r of readJson("osm", "bus-routes.json").routes) addLine(`osm|${r.ref}`, `osm:${r.osmId}`, r.path);

// The first time the line comes within FIT of p, at or after index `from`: the closest point of that pass.
function locate(line, p, from) {
  let best = -1, bd = Infinity;
  for (let j = from; j < line.pts.length; j++) {
    const d = meters(line.pts[j], p);
    if (d < FIT) { if (d < bd) { bd = d; best = j; } }
    else if (best !== -1) break;
  }
  return best === -1 ? null : { at: best, d: bd };
}
// Does the line pass all points in order, without big detours (a piece much longer than the straight hop)?
function fitAll(line, pts) {
  const at = [];
  let from = 0, score = 0;
  for (const p of pts) {
    const f = locate(line, p, from);
    if (!f) return null;
    if (at.length) {
      const along = line.cum[f.at] - line.cum[at.at(-1)];
      if (along > 3 * meters(pts[at.length - 1], p) + 2000) return null;
    }
    at.push(f.at); score += f.d; from = f.at + 1;
  }
  return { at, score };
}
const linesFor = (route) => [...(lines.get(route) ?? []), ...(lines.get(`osm|${route}`) ?? [])];

// ---------------------------------------------------------------- build
const r5 = (x) => Math.round(x * 1e5) / 1e5;
function finish(segments, src) {
  // segments: one point list per hop between time points; returns coords + meters at each time point
  const coords = [], at = [0], ti = [0];
  let total = 0;
  for (const seg of segments) {
    for (const p of seg) {
      const q = [r5(p[0]), r5(p[1])];
      const last = coords.at(-1);
      if (last && last[0] === q[0] && last[1] === q[1]) continue;
      if (last) total += meters(last, q);
      coords.push(q);
    }
    at.push(Math.round(total));
    ti.push(Math.max(0, coords.length - 1));
  }
  return { src, len: Math.round(total), at, ti, coords, hw: highwayRanges(coords) };
}

// Which stretches of a line run along an expressway (OSM motorway / trunk, not ramps): a piece counts
// when its middle is within 20 m of an expressway piece running the same way (so streets crossing
// under it, or frontage roads beside it, don't). Returned as [first, last] coordinate-piece ranges.
const HW_CELL = 0.002;
const hwGrid = new Map();
for (const w of streets.ways) {
  if (!/^(motorway|trunk)$/.test(w.h)) continue;
  for (let i = 1; i < w.c.length; i++) {
    const a = w.c[i - 1], b = w.c[i];
    for (const [x, y] of [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]) {
      const k = `${Math.floor(x / HW_CELL)},${Math.floor(y / HW_CELL)}`;
      if (!hwGrid.has(k)) hwGrid.set(k, new Set());
      hwGrid.get(k).add(a.concat(b));
    }
  }
}
function onHighway(p, q) {
  const m = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const ux = (q[0] - p[0]) * COS, uy = q[1] - p[1], ul = Math.hypot(ux, uy);
  if (!ul) return false;
  const gx = Math.floor(m[0] / HW_CELL), gy = Math.floor(m[1] / HW_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of hwGrid.get(`${gx + dx},${gy + dy}`) ?? []) {
    const vx = (s[2] - s[0]) * COS, vy = s[3] - s[1], vl = Math.hypot(vx, vy);
    if (!vl || Math.abs((ux * vx + uy * vy) / (ul * vl)) < 0.9) continue;
    // distance from m to the piece, in meters
    const px = (m[0] - s[0]) * COS, py = m[1] - s[1];
    const t = Math.max(0, Math.min(1, (px * vx + py * vy) / (vl * vl)));
    if (Math.hypot(px - t * vx, py - t * vy) * 111320 < 20) return true;
  }
  return false;
}
function highwayRanges(coords) {
  const out = [];
  for (let i = 1; i < coords.length; i++) {
    if (!onHighway(coords[i - 1], coords[i])) continue;
    const last = out.at(-1);
    if (last && last[1] === i - 2) last[1] = i - 1; else out.push([i - 1, i - 1]);
  }
  return out;
}
function inService(route, pts) {
  const cands = linesFor(route);
  // GTFS shapes first; an OSM relation only when no GTFS shape passes every time point
  let best = null;
  for (const l of lines.get(route) ?? []) { const f = fitAll(l, pts); if (f && (!best || f.score < best.f.score)) best = { l, f }; }
  if (!best) for (const l of lines.get(`osm|${route}`) ?? []) { const f = fitAll(l, pts); if (f && (!best || f.score < best.f.score)) best = { l, f }; }
  if (best) {
    const segs = [];
    for (let i = 1; i < pts.length; i++) segs.push(best.l.pts.slice(best.f.at[i - 1], best.f.at[i] + 1));
    return finish(segs, [best.l.id]);
  }
  // hop by hop
  const segs = [], src = [];
  for (let i = 1; i < pts.length; i++) {
    let hop = null;
    for (const l of cands) { const f = fitAll(l, [pts[i - 1], pts[i]]); if (f && (!hop || f.score < hop.f.score || (hop.l.id.startsWith("osm") && l.id.startsWith("gtfs")))) hop = { l, f }; }
    if (hop) { segs.push(hop.l.pts.slice(hop.f.at[0], hop.f.at[1] + 1)); src.push(hop.l.id); }
    else { const s = streetPath(pts[i - 1], pts[i]); segs.push(s.pts); src.push(s.src); }
  }
  return finish(segs, src);
}

const patterns = new Map(), uses = new Map();
for (const day of ["Weekday", "Saturday", "Sunday"]) {
  const dir = path.join(project, `${day} Parsed`);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) for (const r of readJson(`${day} Parsed`, f).runs) for (const h of r.halves) for (const t of h.trips) {
    const tp = [t.begin, ...t.stops, t.end].filter((p, i, a) => i === 0 || p.location !== a[i - 1].location);
    // an out-of-service move's routing note ("VIA FOSTER - WESTERN - DEVON - CLARK") is part of its key
    const note = t.inService ? "" : (t.notes ?? []).map((k) => r.notes?.[k] ?? "").filter((x) => /\bVIA\b/i.test(x)).join(" ");
    const key = t.inService ? `${t.route}|${tp.map((p) => p.location).join(">")}` : `deadhead|${t.begin.location}>${t.end.location}${note ? `|${note}` : ""}`;
    uses.set(key, (uses.get(key) ?? 0) + 1);
    if (!patterns.has(key)) patterns.set(key, { route: t.inService ? t.route : null, points: t.inService ? tp : [t.begin, t.end], note });
  }
}
// A move printed without a routing note takes the route most often noted for the same from → to
// (e.g. a Howard → North Park Garage pull-in with no note still goes Howard - Western - Foster).
// Its key stays note-less, so it still matches the trip; `borrowedNote` says where its route came from.
{
  const noted = new Map(); // "from>to" → Map(note → trips)
  for (const [key, p] of patterns) if (!p.route && p.note) {
    const pair = key.split("|")[1];
    if (!noted.has(pair)) noted.set(pair, new Map());
    noted.get(pair).set(p.note, (noted.get(pair).get(p.note) ?? 0) + uses.get(key));
  }
  let borrowed = 0;
  for (const [key, p] of patterns) if (!p.route && !p.note) {
    const best = [...(noted.get(key.split("|")[1]) ?? [])].sort((a, b) => b[1] - a[1])[0];
    if (best) { p.note = best[0]; p.borrowedNote = true; borrowed++; }
  }
  console.log(`${borrowed} out-of-service moves with no note use the route noted for the same from → to`);
}
console.log(`${patterns.size} patterns to build`);
const out = {};
const tally = { gtfs: 0, osm: 0, mixed: 0, streets: 0, straight: 0, oneWayIgnored: 0, missingCoords: 0, noteFollowed: 0, noteRejected: 0, noteNoStreets: 0 };
const rejected = [];
let n = 0;
const t0 = Date.now();
for (const [key, p] of patterns) {
  if (++n % 500 === 0) console.log(`  ${n}/${patterns.size}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (p.points.some((q) => typeof q.lat !== "number")) { tally.missingCoords++; continue; }
  const pts = p.points.map((q) => [q.lon, q.lat]);
  let res, via;
  if (p.route) res = inService(p.route, pts);
  else {
    const keys = viaStreets(p.note);
    const s = keys.length ? viaPath(pts[0], pts[1], keys) : streetPath(pts[0], pts[1]);
    if (keys.length) {
      via = s.used;
      if (s.failed) { tally.noteRejected++; rejected.push(key); }
      else if (s.used.length) tally.noteFollowed++;
      else tally.noteNoStreets++;
    }
    res = finish([s.pts], [s.src]);
  }
  const kinds = new Set(res.src.map((s) => s.split(":")[0].split(" ")[0]));
  if (res.src.includes("straight")) tally.straight++;
  if (res.src.some((s) => s.includes("one-ways"))) tally.oneWayIgnored++;
  if (kinds.size > 1) tally.mixed++; else tally[[...kinds][0]]++;
  out[key] = { ...res, src: [...new Set(res.src)], ...(via ? { via } : {}), ...(p.borrowedNote ? { borrowedNote: p.note } : {}), trips: uses.get(key) };
}
if (rejected.length) console.log(`note routes that looked wrong (used the plain street route instead):\n  ${rejected.join("\n  ")}`);
const json = JSON.stringify({
  createdAt: new Date().toISOString(),
  attribution: "Route lines: CTA GTFS. Streets and some route lines: © OpenStreetMap contributors, ODbL 1.0",
  note: "key = 'route|time point>time point>…' (in service) or 'deadhead|from>to|routing note' (pullout, pull-in, deadhead; out-of-service moves follow the streets their paddle note names, listed in via); coords = [lon, lat]; at = meters along the line at each time point; ti = index in coords of each time point; hw = [first, last] ranges of pieces (piece i = coords i → i+1) that run along an expressway; len = meters; src = where the line came from (gtfs:<shape id>, osm:<relation id>, streets, straight); trips = how many trips (all days) use it",
  patterns: out,
});
fs.writeFileSync(path.join(project, "animation", "paths.json"), json);
console.log(`paths.json ${(json.length / 1e6).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(0)}s`, tally);

