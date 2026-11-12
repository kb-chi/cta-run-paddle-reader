// locations.js — what each paddle time-point name means, so it can be mapped.
//
// Each entry:
//   type:   "intersection" | "station" | "landmark" | "garage"
//   name:   readable name
//   query:  text a geocoder can use (ArcGIS style: "Street & Street, City, IL")
//   city:   municipality
//   review: true if the meaning is a guess and needs checking
//   lat/lon, gtfsStopIds, coordsFrom: filled in below from CTA's GTFS stops file
//
// Lake Shore Drive is officially "DuSable Lake Shore Dr" (renamed 2021).

import { GTFS_LOCATIONS } from "./locations-gtfs.js";
import { COORDS, ESTIMATED, LOCATIONS } from "./locations-data.js";
export { LOCATIONS };

for (const [key, loc] of Object.entries(LOCATIONS)) {
  if (ESTIMATED[key]) {
    const e = ESTIMATED[key];
    Object.assign(loc, { lat: e.lat, lon: e.lon, gtfsStopIds: [], coordsFrom: e.how.startsWith("from ") ? e.how : `estimated: ${e.how}` });
    continue;
  }
  const c = COORDS[key];
  Object.assign(loc, c
    ? { lat: c.lat, lon: c.lon, gtfsStopIds: c.gtfsStopIds, coordsFrom: "CTA GTFS stops" }
    : { lat: null, lon: null, gtfsStopIds: [], coordsFrom: "none yet — geocode the query" });
}

// Time points matched to CTA stops by script (see locations-gtfs.js). A hand-written entry above wins.
for (const [key, loc] of Object.entries(GTFS_LOCATIONS)) {
  if (!LOCATIONS[key]) LOCATIONS[key] = { ...loc };
}

/** Look up a paddle location name. Unknown names return null. */
export function locationOf(paddleName) {
  return LOCATIONS[String(paddleName ?? "").trim()] ?? null;
}

/**
 * Swap paddle names for readable locations in a run (in place), e.g.
 *   { time, location: "BELMONT CALIF" }
 *   -> { time, location: "Belmont Ave & California Ave", type: "intersection", lat: 41.93983, lon: -87.69756 }
 * Applies to every trip time point, each half's start and end, and relief "headed to" names.
 * Names not in the table keep their paddle text, with lat/lon null.
 */
export function placeLocations(run) {
  const place = (p) => {
    if (!p || "lat" in p) return; // already converted
    const paddleName = p.location;
    const loc = locationOf(paddleName);
    const { time, notes } = p;
    for (const k of Object.keys(p)) delete p[k];
    Object.assign(p, {
      time,
      location: loc?.name ?? paddleName,
      type: loc?.type ?? null,
      lat: loc?.lat ?? null,
      lon: loc?.lon ?? null,
    });
    if (notes) p.notes = notes;
  };
  const headed = (r) => {
    if (!r || !r.headedTo) return;
    const loc = locationOf(r.headedTo);
    if (loc) r.headedTo = loc.name;
  };
  for (const h of run.halves) {
    place(h.start);
    place(h.end);
    headed(h.startRelief);
    headed(h.relief);
    for (const t of h.trips) [t.begin, ...t.stops, t.end].forEach(place);
  }
  return run;
}
