// Data for the route animation (animate.html): every bus that runs the route in a time window, with
// the movements to show and the lines they follow (from animation/paths.json), plus map layers.
//
// For each run half, a "block" is a stretch of trips on the route (with any out-of-service moves in
// between). It is shown together with the out-of-service moves right before and after it:
//   pullout / pull-in (to or from the garage, labelled G) and deadheads (to or from another route).
// If the bus comes from another route or goes on to one, the block says which (fromRoute / toRoute).
import fs from "node:fs";
import path from "node:path";

const HIGHWAY_SPEEDUP = 3; // buses cover expressway distance this many times faster than street distance
const COS = Math.cos((41.85 * Math.PI) / 180);
const meters = (a, b) => Math.hypot((b[1] - a[1]) * 111320, (b[0] - a[0]) * 111320 * COS);
const secs = (t) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };

let cache = null;
function load(project) {
  if (cache) return cache;
  const read = (...p) => JSON.parse(fs.readFileSync(path.join(project, ...p), "utf8"));
  cache = { paths: read("animation", "paths.json").patterns, base: read("osm", "basemap.json"), streets: read("osm", "streets.json"), shapes: read("CTA GTFS", "route-shapes.json").routes };
  return cache;
}

const pointsOf = (t) => [t.begin, ...t.stops, t.end];
// same keys as animation/build-paths.mjs
function pathKey(run, t) {
  const tp = pointsOf(t).filter((p, i, a) => i === 0 || p.location !== a[i - 1].location);
  if (t.inService) return `${t.route}|${tp.map((p) => p.location).join(">")}`;
  const note = (t.notes ?? []).map((k) => run.notes?.[k] ?? "").filter((x) => /\bVIA\b/i.test(x)).join(" ");
  return `deadhead|${t.begin.location}>${t.end.location}${note ? `|${note}` : ""}`;
}
// time keyframes: [seconds, time point index along the path] (a repeated place = waiting there)
function keyframes(t) {
  const out = [];
  let k = -1, prevLoc = null;
  for (const p of pointsOf(t)) { if (p.location !== prevLoc) k++; prevLoc = p.location; out.push([secs(p.time), k]); }
  return out;
}
function direction(t) {
  const a = t.begin, b = t.end;
  if (typeof a.lat !== "number" || typeof b.lat !== "number") return "";
  const dy = b.lat - a.lat, dx = (b.lon - a.lon) * COS;
  return Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? "NB" : "SB") : (dx > 0 ? "EB" : "WB");
}

// Pull every point of an outline into the box (outside parts run along the box edge instead), dropping
// repeats: fills the same inside the box with far fewer points.
function clampRing(c, box) {
  const out = [];
  for (const [x, y] of c) {
    const p = [Math.min(box[2], Math.max(box[0], x)), Math.min(box[3], Math.max(box[1], y))];
    const l = out.at(-1);
    if (l && l[0] === p[0] && l[1] === p[1]) continue;
    // a run along the same box edge only needs its ends
    if (out.length > 1) {
      const k = out.at(-2);
      if ((k[0] === l[0] && l[0] === p[0] && (p[0] === box[0] || p[0] === box[2])) || (k[1] === l[1] && l[1] === p[1] && (p[1] === box[1] || p[1] === box[3]))) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

export function animationFor(project, runs, route, from, to) {
  const { paths, base, streets, shapes } = load(project);
  const buses = [], used = new Set(), missing = new Set();
  for (const run of runs) for (const [hi, h] of run.halves.entries()) {
    const trips = h.trips;
    const isR = (t) => t.inService && t.route === route;
    const blocks = [];
    let cur = null;
    trips.forEach((t, i) => {
      if (isR(t)) { if (!cur) blocks.push((cur = { first: i, last: i })); else cur.last = i; }
      else if (t.inService) cur = null;
    });
    for (const b of blocks) {
      let s = b.first, e = b.last;
      while (s > 0 && !trips[s - 1].inService) s--;
      while (e < trips.length - 1 && !trips[e + 1].inService) e++;
      const prevIn = trips.slice(0, b.first).findLast((t) => t.inService);
      const nextIn = trips.slice(b.last + 1).find((t) => t.inService);
      const segs = [];
      for (let i = s; i <= e; i++) {
        const t = trips[i];
        const anyBefore = trips.slice(0, i).some((x) => x.inService), anyAfter = trips.slice(i + 1).some((x) => x.inService);
        const kind = t.inService ? "trip" : !anyBefore && h.startType === "pullout" ? "pullout" : !anyAfter && h.endType === "pullin" ? "pullin" : "deadhead";
        const key = pathKey(run, t);
        if (!paths[key]) { missing.add(key); continue; }
        used.add(key);
        segs.push({ kind, path: key, kf: keyframes(t), ...(t.inService ? { dir: direction(t) } : {}) });
      }
      if (!segs.length) continue;
      // on screen from the start of its first move (or, coming off another route with no deadhead, from
      // when that trip ended, waiting at the terminal) to the end of its last (or, going on to another
      // route with no deadhead, until that route's trip starts)
      const startSec = s === b.first && prevIn ? secs(prevIn.end.time) : segs[0].kf[0][0];
      const endSec = e === b.last && nextIn ? secs(nextIn.begin.time) : segs.at(-1).kf.at(-1)[0];
      if (endSec < from || startSec > to) continue;
      buses.push({
        run: run.number, garage: run.garage, half: hi + 1, start: startSec, end: endSec,
        fromRoute: prevIn?.route ?? null, toRoute: nextIn?.route ?? null,
        lastTripEnd: trips[b.last].end.time ? secs(trips[b.last].end.time) : null,
        startsByRelief: s === 0 && h.startType === "relief", endsByRelief: e === trips.length - 1 && h.endType === "relief",
        segs,
      });
    }
  }
  const { lines, map } = linesAndMap(project, used, [route], { minor: true });
  return { route, title: `Route ${route}`, from, to, highwaySpeedup: HIGHWAY_SPEEDUP, buses, lines, map, missingPaths: [...missing] };
}

// The lines buses follow, with "effective" distance (expressway distance counts 1/3) at each point,
// and the map around them (water, parks, rail, streets, and the given routes' GTFS lines).
function linesAndMap(project, used, routes, { minor }) {
  const { paths, base, streets, shapes } = load(project);
  const lines = {};
  let box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const key of used) {
    const p = paths[key];
    const hw = new Set();
    for (const [a, b] of p.hw ?? []) for (let i = a; i <= b; i++) hw.add(i);
    const eff = [0];
    for (let i = 1; i < p.coords.length; i++) eff.push(eff[i - 1] + meters(p.coords[i - 1], p.coords[i]) / (hw.has(i - 1) ? HIGHWAY_SPEEDUP : 1));
    lines[key] = { coords: p.coords, ti: p.ti, eff: eff.map((x) => Math.round(x * 10) / 10), hw: p.hw ?? [] };
    for (const [x, y] of p.coords) box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  }
  // map layers around it
  const m = 0.012;
  box = [box[0] - m, box[1] - m * 0.75, box[2] + m, box[3] + m * 0.75];
  const wide = [box[0] - 0.2, box[1] - 0.15, box[2] + 0.2, box[3] + 0.15]; // room to pan before outlines run out
  const touches = (pts) => pts.some(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3]);
  const map = {
    box,
    // outlines (inner = island/hole), squeezed into the map box so Lake Michigan's 50,000-point outline stays small
    water: base.water.filter((w) => touches(w.c)).map((w) => ({ c: clampRing(w.c, wide), inner: w.inner ?? 0 })),
    coastline: base.coastline.filter(touches),
    parks: base.parks.filter((w) => touches(w.c)).map((w) => ({ c: clampRing(w.c, wide), inner: w.inner ?? 0 })),
    rail: base.rail.map((w) => w.c).filter(touches),
    // main streets, plus side streets ("minor") for close zoom and GIFs when asked (too many for a whole garage's area)
    streets: streets.ways.filter((w) => (minor ? /^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street)$/ : /^(motorway|trunk|primary|secondary|tertiary)$/).test(w.h) && touches(w.c))
      .map((w) => (/^(residential|unclassified|living_street)$/.test(w.h) ? { h: "minor", c: w.c } : { h: w.h, n: w.n, c: w.c })),
    // each route's GTFS lines (for a garage: just the busiest shape each way, to keep it light)
    route: routes.flatMap((rt) => {
      const sh = shapes.find((r) => r.route === rt)?.shapes ?? [];
      const pick = routes.length > 1 ? [...new Map(sh.map((s) => [s.direction, s])).values()] : sh; // shapes come busiest first per direction
      return pick.map((s) => s.path.map(([x, y]) => [x, y]));
    }),
  };
  return { lines, map };
}

// Every bus from one garage: each run half from its first move to its last, on every route.
// Labels: in service "run · route" coloured by direction; pullouts / pull-ins "G"; and when a bus deadheads
// between trips, or changes route at a terminal, "NB 151 → NB 147" (the trip it came from → the next one).
export function garageAnimationFor(project, runs, garage, from, to) {
  const { paths } = load(project);
  const buses = [], used = new Set(), missing = new Set(), routes = new Set();
  const tripName = (t) => `${direction(t)} ${t.route}`.trim();
  for (const run of runs) for (const [hi, h] of run.halves.entries()) {
    const trips = h.trips;
    const segs = [];
    let prevIn = null;
    trips.forEach((t, i) => {
      const nextIn = trips.slice(i + 1).find((x) => x.inService) ?? null;
      const before = trips.slice(0, i).findLast((x) => x.inService) ?? null;
      let kind, label = null, wait = null;
      if (t.inService) {
        kind = "trip"; routes.add(t.route);
        // waiting at a terminal before this trip after one on another route: "NB 151 → NB 147"
        if (before && before.route !== t.route && !trips.slice(trips.indexOf(before) + 1, i).some((x) => !x.inService)) wait = `${tripName(before)} → ${tripName(t)}`;
      } else if (!before && h.startType === "pullout") kind = "pullout";
      else if (!nextIn && h.endType === "pullin") kind = "pullin";
      else {
        kind = "deadhead";
        if (before && nextIn) label = `${tripName(before)} → ${tripName(nextIn)}`;
        else if (nextIn) label = `→ ${tripName(nextIn)}`;
        else if (before) label = `${tripName(before)} →`;
      }
      const key = pathKey(run, t);
      if (!paths[key]) { missing.add(key); return; }
      used.add(key);
      segs.push({ kind, path: key, kf: keyframes(t), ...(t.inService ? { dir: direction(t), route: t.route } : {}), ...(label ? { label } : {}), ...(wait ? { wait } : {}) });
      if (t.inService) prevIn = t;
    });
    if (!segs.length) continue;
    const start = segs[0].kf[0][0], end = segs.at(-1).kf.at(-1)[0];
    if (end < from || start > to) continue;
    buses.push({ run: run.number, garage: run.garage, half: hi + 1, start, end, fromRoute: null, toRoute: null, lastTripEnd: null,
      startsByRelief: h.startType === "relief", endsByRelief: h.endType === "relief", segs });
  }
  const { lines, map } = linesAndMap(project, used, [...routes], { minor: false });
  return { garage, title: `${garage} garage`, mode: "garage", from, to, highwaySpeedup: HIGHWAY_SPEEDUP, buses, lines, map, missingPaths: [...missing], routes: [...routes] };
}
