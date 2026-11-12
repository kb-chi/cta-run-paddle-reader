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
