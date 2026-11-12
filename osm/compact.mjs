// Turn the raw Overpass downloads in <project>/osm/raw into compact files in <project>/osm.
import fs from "node:fs";
import path from "node:path";
const project = process.argv[2];
const raw = (n) => JSON.parse(fs.readFileSync(path.join(project, "osm", "raw", `${n}.json`), "utf8")).elements;
const r5 = (x) => Math.round(x * 1e5) / 1e5;
const line = (g) => g.map((p) => [r5(p.lon), r5(p.lat)]);
// drop points closer than ~3 m to the previous kept point (keeps every corner that matters at map scale)
const thin = (pts) => pts.filter((p, i) => i === 0 || i === pts.length - 1 || Math.abs(p[0] - pts[i - 1][0]) + Math.abs(p[1] - pts[i - 1][1]) > 3e-5);
const write = (name, obj) => { const s = JSON.stringify(obj); fs.writeFileSync(path.join(project, "osm", name), s); console.log(name, `${(s.length / 1e6).toFixed(1)} MB`); };
const attribution = "© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)";
const bbox = [-87.895, 41.637, -87.515, 42.074];

// ---- streets: every drivable way, keeping what routing needs (OSM node ids so ways connect)
{
  const ways = [];
  for (const w of raw("streets")) {
    if (!w.geometry) continue;
    const t = w.tags;
    const oneway = t.oneway === "yes" || t.oneway === "1" ? 1 : t.oneway === "-1" ? -1 : t.junction === "roundabout" ? 1 : 0;
    const busOnly = t.highway === "busway" || t.highway === "bus_guideway" || t.access === "no" && (t.bus === "yes" || t.psv === "yes") ? 1 : 0;
    ways.push({ id: w.id, h: t.highway.replace("_link", "*"), n: t.name ?? "", r: t.ref ?? "", o: oneway, b: busOnly, nodes: w.nodes, c: line(w.geometry) });
  }
  write("streets.json", { attribution, bbox, note: "h = highway class (* = link ramp), n = name, r = ref (e.g. 'I 94'), o = oneway (1 forward, -1 reverse), b = bus/PSV only, nodes = OSM node ids (shared ids = connected), c = [lon, lat] per node", ways });
}

// ---- bus routes: one ordered line per CTA route variant, plus its stops
{
  const routes = [];
  for (const r of raw("busroutes")) {
    const segs = r.members.filter((m) => m.type === "way" && !/platform/.test(m.role) && m.geometry).map((m) => line(m.geometry.filter(Boolean)));
    // stitch ways in member order, flipping each to meet the end of the line so far
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    let path = [];
    let gaps = 0;
    for (const [i, s] of segs.entries()) {
      if (i === 0) {
        path = s.slice();
        const nx = segs[1];
        // first way points the wrong way if its start (not its end) meets the second way
        if (nx && (same(path[0], nx[0]) || same(path[0], nx.at(-1))) && !same(path.at(-1), nx[0]) && !same(path.at(-1), nx.at(-1))) path.reverse();
        continue;
      }
      const e2 = path.at(-1);
      if (same(e2, s[0])) path.push(...s.slice(1));
      else if (same(e2, s.at(-1))) path.push(...s.slice(0, -1).reverse());
      else { gaps++; path.push(...s); }
    }
    const stops = r.members.filter((m) => m.type === "node" && /stop|platform/.test(m.role) && m.lat).map((m) => [r5(m.lon), r5(m.lat)]);
    const t = r.tags;
    routes.push({ ref: t.ref, name: t.name ?? "", from: t.from ?? "", to: t.to ?? "", direction: t.direction ?? "", osmId: r.id, gaps, stops, path: thin(path) });
  }
  routes.sort((a, b) => a.ref.localeCompare(b.ref, "en", { numeric: true }) || a.name.localeCompare(b.name));
  write("bus-routes.json", { attribution, note: "path = [lon, lat] along the route in member order; gaps = places where consecutive OSM ways don't meet", routes });
}

// ---- basemap: water, lakefront, rivers, parks, rail, city limits
{
  const out = { water: [], coastline: [], rivers: [], parks: [], rail: [], boundary: [] };
  // A relation's outline comes as many member ways; join those that share end points into rings
  // (so Lake Michigan's 1,000+ shoreline pieces become one closed outline that can be filled).
  const key = (p) => `${p[0]},${p[1]}`;
  function joinRings(segs) {
    const left = segs.filter((s) => s.length > 1).map((s) => s.slice());
    const rings = [];
    while (left.length) {
      let ring = left.pop();
      for (let grew = true; grew && key(ring[0]) !== key(ring.at(-1));) {
        grew = false;
        const end = key(ring.at(-1));
        const i = left.findIndex((s) => key(s[0]) === end || key(s.at(-1)) === end);
        if (i !== -1) { const s = left.splice(i, 1)[0]; ring = ring.concat((key(s[0]) === end ? s : s.reverse()).slice(1)); grew = true; }
      }
      rings.push(ring);
    }
    return rings;
  }
  const areaShapes = (e) => {
    if (e.type === "way") return [{ c: thin(line(e.geometry)) }];
    const ways = (role) => e.members.filter((m) => m.type === "way" && m.geometry && (role === "inner" ? m.role === "inner" : m.role !== "inner")).map((m) => line(m.geometry));
    return [...joinRings(ways("outer")).map((c) => ({ c: thin(c) })), ...joinRings(ways("inner")).map((c) => ({ c: thin(c), inner: 1 }))];
  };
  const ringsOf = (e) => e.type === "way" ? [line(e.geometry)] : e.members.filter((m) => m.type === "way" && m.geometry).map((m) => line(m.geometry));
  for (const e of raw("basemap")) {
    if (!e.geometry && !e.members) continue;
    const t = e.tags ?? {};
    if (t.natural === "water" || t.leisure === "park") {
      const list = t.natural === "water" ? out.water : out.parks;
      for (const s of areaShapes(e)) list.push({ n: t.name ?? "", ...s });
      continue;
    }
    const shapes = ringsOf(e).map(thin);
    if (t.natural === "coastline") out.coastline.push(...shapes);
    else if (t.waterway) out.rivers.push(...shapes.map((c) => ({ n: t.name ?? "", c })));
    else if (t.railway) out.rail.push(...shapes.map((c) => ({ k: t.railway, n: t.name ?? "", c })));
    else if (t.boundary) out.boundary.push(...shapes.map((c) => ({ n: t.name ?? "", c })));
  }
  write("basemap.json", { attribution, bbox, note: "all shapes are [lon, lat] lists; water and parks are outlines (inner: 1 = a hole, like an island), joined from relation members where needed", ...out });
}
