// Download OpenStreetMap data for the CTA service area from Overpass into <project>/osm/raw.
import fs from "node:fs";
import path from "node:path";
const project = process.argv[2];
const only = process.argv[3];
const out = path.join(project, "osm", "raw");
fs.mkdirSync(out, { recursive: true });
const bbox = "41.637,-87.895,42.074,-87.515"; // service area + ~1 km
const queries = {
  streets: `[out:json][timeout:600][maxsize:1073741824][bbox:${bbox}];
way[highway~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|busway|bus_guideway)$"];
out geom;
way[highway=service][service!~"^(alley|parking_aisle|driveway|drive-through|emergency_access)$"];
out geom;`,
  busroutes: `[out:json][timeout:600][bbox:${bbox}];
relation[type=route][route=bus][~"^(network|operator)$"~"CTA|Chicago Transit",i];
out geom;`,
  basemap: `[out:json][timeout:600][bbox:${bbox}];
(
  way[natural=coastline];
  way[natural=water]; relation[natural=water];
  way[waterway~"^(river|canal)$"];
  way[leisure=park][~"^(name)$"~"."]; relation[leisure=park];
  way[railway~"^(rail|subway|light_rail)$"][service!~"."];
  way[boundary=administrative][admin_level=8]; relation[boundary=administrative][admin_level=8][name=Chicago];
);
out geom;`,
};
for (const [name, q] of Object.entries(queries)) {
  if (only && only !== name) continue;
  const t0 = Date.now();
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "run-paddle-reader/1.0" },
    body: "data=" + encodeURIComponent(q),
  });
  const text = await res.text();
  if (!res.ok) { console.log(name, res.status, text.slice(0, 400)); continue; }
  fs.writeFileSync(path.join(out, `${name}.json`), text);
  const j = JSON.parse(text);
  console.log(name, `${(text.length / 1e6).toFixed(1)} MB`, `${j.elements.length} elements`, `${((Date.now() - t0) / 1000).toFixed(0)}s`, j.remark ?? "");
}
