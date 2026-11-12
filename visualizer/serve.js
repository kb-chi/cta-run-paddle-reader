#!/usr/bin/env node
// Serves the visualizer, combining every garage's parsed runs for a day type.
//   node visualizer/serve.js            then open http://localhost:5280
//   node visualizer/serve.js --port 6000
//
// Data comes from the "Weekday Parsed", "Saturday Parsed" and "Sunday Parsed" folders. For a day type
// (and optionally one garage) the server joins those files' runs and recomputes the statistics with
// run.js, so a route run by two garages (like the 49: North Park and 74th) is one route.
//   /api/days                                   day types and the garages that have files for each
//   /api/summary?day=Weekday&garage=All         statistics for all routes + where each place is
//   /api/route?day=Weekday&garage=All&route=49  that route's statistics and the runs that drive it
//   /api/anim?day=Weekday&route=147&garage=All&from=54000&to=66600   buses, paths and map for the animation player
//   /api/anim-garage?day=Weekday&garage=North Park&from=54000&to=66600   every bus from one garage, all routes
//   /api/timeuse?day=Weekday&a=15&b=18.5      per garage: platform time in service / deadhead / garage / recovery, and pay
//   /api/routetime?day=Weekday&garage=All&a=15&b=18.5   the same split per route, plus the rush-hour-only routes
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStatistics } from "../run.js";
import { animationFor, garageAnimationFor } from "./anim.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, "..");
const portArg = process.argv.indexOf("--port");
const port = Number(portArg > -1 ? process.argv[portArg + 1] : process.env.PORT) || 5280;

const DAYS = ["Weekday", "Saturday", "Sunday"];
const GARAGE_ORDER = ["North Park", "Kedzie", "Forest Glen", "Chicago", "74th", "77th", "103rd"];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8" };
const garageRank = (g) => { const i = GARAGE_ORDER.indexOf(g); return i === -1 ? 99 : i; };

// ---------- loading (cached until a file changes) ----------
const dayCache = new Map(); // day -> { stamp, runs, garages, sources }
async function loadDay(day) {
  const dir = path.join(project, `${day} Parsed`);
  let names = [];
  try { names = (await fs.readdir(dir)).filter((n) => / Runs Parsed\.json$/i.test(n)).sort(); } catch { names = []; }
  const stats = await Promise.all(names.map((n) => fs.stat(path.join(dir, n))));
  const stamp = names.map((n, i) => `${n}:${stats[i].mtimeMs}`).join("|");
  const cached = dayCache.get(day);
  if (cached && cached.stamp === stamp) return cached;
  const runs = [], garages = new Set(), sources = [];
  for (const n of names) {
    const j = JSON.parse(await fs.readFile(path.join(dir, n), "utf8"));
    for (const r of j.runs) runs.push(r);
    garages.add(j.garage);
    sources.push({ file: n, garage: j.garage, runs: j.runCount });
  }
  const entry = { stamp, runs, garages: [...garages].sort((a, b) => garageRank(a) - garageRank(b)), sources, stats: new Map() };
  dayCache.set(day, entry);
  return entry;
}

// statistics for a day + garage ("All" = every garage), with the garage added to each departure
async function summaryFor(day, garage) {
  const d = await loadDay(day);
  if (d.stats.has(garage)) return d.stats.get(garage);
  const runs = garage === "All" ? d.runs : d.runs.filter((r) => r.garage === garage);
  const statistics = runStatistics(runs);
  const garageOf = new Map(runs.map((r) => [r.number, r.garage]));
  for (const byFrom of Object.values(statistics.directionsByRoute)) for (const dir of Object.values(byFrom)) {
    for (const dep of dir.departures) dep.garage = garageOf.get(dep.run) ?? "";
    dir.firstTrip.garage = garageOf.get(dir.firstTrip.run) ?? "";
    dir.lastTrip.garage = garageOf.get(dir.lastTrip.run) ?? "";
  }
  // where each named place is, so the page can work out directions and distances
  const places = {};
  for (const r of runs) for (const h of r.halves) for (const t of h.trips) for (const p of [t.begin, ...t.stops, t.end]) {
    if (p && typeof p.lat === "number" && !places[p.location]) places[p.location] = { lat: p.lat, lon: p.lon };
  }
  const result = {
    day, garage, garages: d.garages, sources: d.sources.filter((s) => garage === "All" || s.garage === garage),
    runCount: runs.length, statistics, places,
    // every run's duty type and whether it's a swing (a quality, alongside its type): [number, dutyType, 1 = swing]
    runKinds: runs.map((r) => [r.number, r.dutyType, r.isSwing ? 1 : 0, r.garage]),
  };
  d.stats.set(garage, result);
  return result;
}

async function routeFor(day, garage, route) {
  const d = await loadDay(day);
  const s = await summaryFor(day, garage);
  const runs = (garage === "All" ? d.runs : d.runs.filter((r) => r.garage === garage))
    .filter((r) => r.halves.some((h) => h.trips.some((t) => t.inService && t.route === route)));
  const st = s.statistics;
  const pick = (k) => (st[k]?.[route] !== undefined ? { [route]: st[k][route] } : {});
  return {
    day, garage, route,
    statistics: {
      directionsByRoute: pick("directionsByRoute"), tripStartsByRoute: pick("tripStartsByRoute"),
      peakBusesByRouteByHour: pick("peakBusesByRouteByHour"), busesInServiceByRouteByHour: pick("busesInServiceByRouteByHour"),
      inServiceTripsByRoute: pick("inServiceTripsByRoute"),
    },
    runs,
  };
}

// ---------- how buses spend their time, per garage (garage comparison) ----------
// For every run half, its platform time (Plat Start → Plat End) split into: in service, deadhead (between
// routes or back to the start of one), garage (pullout and pull-in) and recovery (the rest: layovers, waits).
// Only the part inside the time window counts: [a, b) in paddle hours, where a window past 24 (overnight,
// 23 → 30) also takes the early morning before b − 24 (paddle times there run 00:00–05:59). Plus each
// garage's paid time (pay.total; whole day only makes sense for it).
const clock = (t) => { if (!t) return null; const [h, m, s] = String(t).split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
const duration = (d) => (d == null ? 0 : typeof d === "string" ? clock(d) : (d.hours ?? 0) * 3600 + (d.minutes ?? 0) * 60 + (d.seconds ?? 0));
function timeUseFor(runs, win) {
  const segs = !win ? [[-Infinity, Infinity]] : [[win[0] * 3600, win[1] * 3600], ...(win[1] > 24 ? [[0, (win[1] - 24) * 3600]] : [])];
  const inWin = (s, e) => segs.reduce((n, [a, b]) => n + Math.max(0, Math.min(e, b) - Math.max(s, a)), 0);
  const out = {};
  for (const r of runs) {
    const g = (out[r.garage] ??= { service: 0, deadhead: 0, garage: 0, recovery: 0, pay: 0 });
    g.pay += duration(r.pay?.total);
    for (const h of r.halves) {
      const trips = h.trips.filter((t) => t.begin?.time && t.end?.time);
      if (!trips.length) continue;
      const ps = clock(h.platformStart) ?? clock(trips[0].begin.time), pe = clock(h.platformEnd) ?? clock(trips.at(-1).end.time);
      let moving = 0;
      trips.forEach((t, i) => {
        const n = inWin(clock(t.begin.time), clock(t.end.time));
        moving += n;
        if (t.inService) { g.service += n; return; }
        const before = trips.slice(0, i).some((x) => x.inService), after = trips.slice(i + 1).some((x) => x.inService);
        if ((!before && h.startType === "pullout") || (!after && h.endType === "pullin")) g.garage += n; else g.deadhead += n;
      });
      g.recovery += Math.max(0, inWin(ps, pe) - moving);
    }
  }
  return out;
}

// The same split per route (interesting facts: most / least efficient routes). In-service time goes to the
// trip's route; time between trips (layovers, deadheads, pullouts) goes to the route of the next in-service
// trip, since it's spent getting ready for it; time after the half's last trip (the pull-in) to that last
// trip's route. Also which routes are "rush hour only": no in-service trip running at any time 12–1 PM.
function routeTimeUseFor(runs, win) {
  const segs = !win ? [[-Infinity, Infinity]] : [[win[0] * 3600, win[1] * 3600], ...(win[1] > 24 ? [[0, (win[1] - 24) * 3600]] : [])];
  const inWin = (s, e) => segs.reduce((n, [a, b]) => n + Math.max(0, Math.min(e, b) - Math.max(s, a)), 0);
  const routes = {}, midday = new Set();
  for (const r of runs) for (const h of r.halves) {
    const trips = h.trips.filter((t) => t.begin?.time && t.end?.time);
    const service = trips.filter((t) => t.inService && t.route);
    if (!service.length) continue;
    for (const t of service) if (clock(t.begin.time) < 13 * 3600 && clock(t.end.time) > 12 * 3600) midday.add(t.route);
    // the route each moment belongs to: the next in-service trip's, else the last one's
    const owner = (i) => (trips.slice(i).find((t) => t.inService && t.route) ?? service.at(-1)).route;
    const add = (route, k, n) => { if (n > 0) { const o = (routes[route] ??= { service: 0, deadhead: 0, garage: 0, recovery: 0 }); o[k] += n; } };
    const ps = clock(h.platformStart) ?? clock(trips[0].begin.time), pe = clock(h.platformEnd) ?? clock(trips.at(-1).end.time);
    let at = ps;
    trips.forEach((t, i) => {
      const s = clock(t.begin.time), e = clock(t.end.time);
      if (s > at) add(owner(i), "recovery", inWin(at, s));
      const n = inWin(s, e);
      if (t.inService && t.route) add(t.route, "service", n);
      else {
        const before = trips.slice(0, i).some((x) => x.inService), after = trips.slice(i + 1).some((x) => x.inService);
        add(owner(i), (!before && h.startType === "pullout") || (!after && h.endType === "pullin") ? "garage" : "deadhead", n);
      }
      at = Math.max(at, e);
    });
    if (pe > at) add(service.at(-1).route, "recovery", inWin(at, pe));
  }
  const rushOnly = Object.keys(routes).filter((r) => !midday.has(r));
  return { routes, rushOnly };
}

// ---------- http ----------
const json = (res, body, status = 200) => {
  res.writeHead(status, { "content-type": types[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const dayParam = (url) => { const d = url.searchParams.get("day") ?? "Weekday"; return DAYS.includes(d) ? d : null; };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    if (p === "/api/days") {
      const out = [];
      for (const day of DAYS) { const d = await loadDay(day); out.push({ day, garages: d.garages, runs: d.runs.length }); }
      return json(res, out);
    }
    if (p === "/api/anim") {
      const day = dayParam(url);
      if (!day) return json(res, { error: "day must be Weekday, Saturday or Sunday" }, 400);
      const route = url.searchParams.get("route");
      if (!route) return json(res, { error: "route is required" }, 400);
      const from = Number(url.searchParams.get("from") ?? 0), to = Number(url.searchParams.get("to") ?? 30 * 3600);
      const garage = url.searchParams.get("garage") || "All";
      const d = await loadDay(day);
      const runs = garage === "All" ? d.runs : d.runs.filter((r) => r.garage === garage);
      return json(res, { day, garage, ...animationFor(project, runs, route, from, to) });
    }
    if (p === "/api/timeuse") {
      const day = dayParam(url);
      if (!day) return json(res, { error: "day must be Weekday, Saturday or Sunday" }, 400);
      const a = url.searchParams.get("a"), b = url.searchParams.get("b");
      const win = a != null && b != null ? [Number(a), Number(b)] : null;
      const d = await loadDay(day);
      return json(res, { day, window: win, garages: timeUseFor(d.runs, win) });
    }
    if (p === "/api/routetime") {
      const day = dayParam(url);
      if (!day) return json(res, { error: "day must be Weekday, Saturday or Sunday" }, 400);
      const a = url.searchParams.get("a"), b = url.searchParams.get("b");
      const win = a != null && b != null ? [Number(a), Number(b)] : null;
      const garage = url.searchParams.get("garage") || "All";
      const d = await loadDay(day);
      const { routes } = routeTimeUseFor(garage === "All" ? d.runs : d.runs.filter((r) => r.garage === garage), win);
      // rush hour only is a quality of the route, so it's judged on every garage's whole day
      const { rushOnly } = routeTimeUseFor(d.runs, null);
      return json(res, { day, garage, window: win, routes, rushOnly });
    }
    if (p === "/api/anim-garage") {
      const day = dayParam(url);
      if (!day) return json(res, { error: "day must be Weekday, Saturday or Sunday" }, 400);
      const garage = url.searchParams.get("garage");
      const d = await loadDay(day);
      if (!garage || !d.garages.includes(garage)) return json(res, { error: `No ${day} file for ${garage}` }, 404);
      const from = Number(url.searchParams.get("from") ?? 0), to = Number(url.searchParams.get("to") ?? 30 * 3600);
      return json(res, { day, ...garageAnimationFor(project, d.runs.filter((r) => r.garage === garage), garage, from, to) });
    }
    // the GIF encoder the animation player uses in the browser (npm package gifenc)
    if (p === "/vendor/gifenc.esm.js") {
      const body = await fs.readFile(path.join(project, "node_modules", "gifenc", "dist", "gifenc.esm.js"));
      res.writeHead(200, { "content-type": types[".js"], "cache-control": "no-store" });
      return res.end(body);
    }
    if (p === "/api/summary" || p === "/api/route") {
      const day = dayParam(url);
      if (!day) return json(res, { error: "day must be Weekday, Saturday or Sunday" }, 400);
      const garage = url.searchParams.get("garage") || "All";
      const d = await loadDay(day);
      if (garage !== "All" && !d.garages.includes(garage)) return json(res, { error: `No ${day} file for ${garage}` }, 404);
      if (p === "/api/summary") return json(res, await summaryFor(day, garage));
      const route = url.searchParams.get("route");
      if (!route) return json(res, { error: "route is required" }, 400);
      return json(res, await routeFor(day, garage, route));
    }
    const file = path.join(here, p === "/" ? "index.html" : p);
    if (!file.startsWith(here + path.sep) || path.basename(file) === "serve.js") { res.writeHead(404); return res.end("Not found"); }
    const body = await fs.readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    if (e.code === "ENOENT") { res.writeHead(404); return res.end("Not found"); }
    console.error(e);
    json(res, { error: String(e.message ?? e) }, 500);
  }
});

server.listen(port, "127.0.0.1", () => console.log(`Run Paddle Visualizer: http://localhost:${port}`));
