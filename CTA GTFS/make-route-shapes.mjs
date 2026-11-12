// Build route-shapes.json from CTA GTFS: every bus route's line shapes, with which direction and
// headsign each serves and how many scheduled trips use it.
// Usage: node "CTA GTFS/make-route-shapes.mjs"   (reads shapes.txt, trips.txt, routes.txt next to this file)
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));

async function* rows(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, file)) });
  let head = null;
  for await (const raw of rl) {
    const line = raw.replace(/^﻿/, "");
    if (!line.trim()) continue;
    // GTFS fields here may be quoted and contain commas
    const cells = []; let cur = "", q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (ch === "," && !q) { cells.push(cur); cur = ""; } else cur += ch; }
    cells.push(cur);
    if (!head) { head = cells.map((c) => c.trim()); continue; }
    yield Object.fromEntries(head.map((h, i) => [h, cells[i]]));
  }
}

const routes = new Map();
for await (const r of rows("routes.txt")) if (r.route_type === "3") routes.set(r.route_id, { route: r.route_id, name: r.route_long_name, shapes: new Map() });

for await (const t of rows("trips.txt")) {
  const r = routes.get(t.route_id);
  if (!r || !t.shape_id) continue;
  const s = r.shapes.get(t.shape_id) ?? { shapeId: t.shape_id, direction: t.direction, headsigns: new Map(), trips: 0 };
  s.trips++;
  s.headsigns.set(t.trip_headsign, (s.headsigns.get(t.trip_headsign) ?? 0) + 1);
  r.shapes.set(t.shape_id, s);
}

const pts = new Map();
for await (const p of rows("shapes.txt")) {
  if (!pts.has(p.shape_id)) pts.set(p.shape_id, []);
  pts.get(p.shape_id).push([+p.shape_pt_sequence, +(+p.shape_pt_lon).toFixed(6), +(+p.shape_pt_lat).toFixed(6), Math.round(+p.shape_dist_traveled)]);
}

const out = [];
for (const r of routes.values()) {
  const shapes = [...r.shapes.values()].filter((s) => pts.has(s.shapeId)).map((s) => {
    const p = pts.get(s.shapeId).sort((a, b) => a[0] - b[0]);
    return {
      shapeId: s.shapeId, direction: s.direction, trips: s.trips,
      headsign: [...s.headsigns].sort((a, b) => b[1] - a[1])[0][0],
      lengthFt: p.at(-1)[3],
      path: p.map(([, lon, lat, d]) => [lon, lat, d]),
    };
  }).sort((a, b) => a.direction.localeCompare(b.direction) || b.trips - a.trips);
  if (shapes.length) out.push({ route: r.route, name: r.name, shapes });
}
out.sort((a, b) => a.route.localeCompare(b.route, "en", { numeric: true }));
const json = JSON.stringify({
  source: "CTA GTFS (shapes.txt, trips.txt, routes.txt)",
  note: "path = [lon, lat, feet along the shape]; trips = scheduled GTFS trips using the shape (the busiest shape per direction is the main pattern)",
  routes: out,
});
fs.writeFileSync(path.join(dir, "route-shapes.json"), json);
console.log(`route-shapes.json ${(json.length / 1e6).toFixed(1)} MB, ${out.length} routes, ${out.reduce((n, r) => n + r.shapes.length, 0)} shapes`);
