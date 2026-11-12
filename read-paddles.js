#!/usr/bin/env node
// read-paddles.js — read the run paddles for ONE day type (Weekday, Saturday or Sunday) and save
// every run in one JSON file named "[Garage] [Day] Runs Parsed.json".
//
// Usage:
//   node read-paddles.js <paddles.pdf> [more.pdf ...] [-o other-name.json]
//   e.g. node read-paddles.js North_Park_Saturday.pdf   ->  "North Park Saturday Runs Parsed.json"
//
// All the PDFs given must be for the same day type and the same garage; otherwise nothing is saved.
//
// The output file looks like:
//   {
//     "createdAt": "2026-11-11T16:00:00.000Z",
//     "garage": "North Park", "day": "Saturday",
//     "statistics": { "inServiceTrips": 2310, "inServiceTripsByRoute": { "22": 400, ... },
//                     "pullouts": 277, "swings": 0, "blocks": 7, "pto": 3 },
//     "sources": [ { "file": "North_Park_Saturday.pdf", "pages": 291, "runs": 291 } ],
//     "runCount": 291,
//     "runs": [ { ...run object, plus "source": "North_Park_Saturday.pdf" }, ... ],
//     "duplicatePages": [ { "source": "...", "page": 76, "sameAsPage": 75, "run": "P227" } ],
//     "discardedPages": [ { "source": "...", "page": 361, "run": "P811", "keptPage": 360, "reason": "..." } ],
//     "locations": { "ARTHUR CLARK": { type, name, query, lat, lon, gtfsStopIds, ... }, ... },  (keyed by paddle name)
//   Durations are "H:MM:SS" text, e.g. "recoveryTime": "1:19:30", "pay": { "total": "8:12:00", ... }.
//   Every time point in "runs" reads like
//     { "time": "06:25:00", "location": "Arthur Ave & Clark St", "type": "intersection",
//       "lat": 42.00013, "lon": -87.671171 }
//     "problems": [ { "source": "...", "page": 12, "run": "P012", "message": "..." } ]
//   }

import fs from "node:fs/promises";
import path from "node:path";
import { readPdfPages } from "./pdf-text.js";
import { parsePaddlePage } from "./paddle-parser.js";
import { LOCATIONS, placeLocations } from "./locations.js";
import { durationsAsText, resolveMidRunChanges, runStatistics } from "./run.js";

const args = process.argv.slice(2);
let outFile = null; // default: "[Garage] [Day] Runs Parsed.json"
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o" || args[i] === "--out") outFile = args[++i];
  else inputs.push(args[i]);
}
if (inputs.length === 0) {
  console.log("Usage: node read-paddles.js <paddles.pdf> [more.pdf ...] [-o other-name.json]");
  console.log("All the PDFs must be for one day type (Weekday, Saturday or Sunday) and one garage.");
  process.exit(1);
}

const all = { createdAt: new Date().toISOString(), garage: null, day: null, statistics: null, sources: [], runCount: 0, runs: [], duplicatePages: [], discardedPages: [], problems: [] };

for (const input of inputs) {
  const name = path.basename(input);
  process.stdout.write(`Reading ${name} ...`);
  const data = new Uint8Array(await fs.readFile(input));
  const pages = await readPdfPages(data, (done, total) => {
    if (done % 25 === 0 || done === total) process.stdout.write(`\rReading ${name} ... page ${done}/${total}`);
  });
  // 1. Read every page.
  const parsedPages = [];
  for (const page of pages) {
    let parsed;
    try {
      parsed = parsePaddlePage(page);
    } catch (err) {
      parsed = { run: null, problems: [`Couldn't read this page: ${err.message}`] };
    }
    parsedPages.push({ page: page.page, ...parsed });
  }
  const sameRun = (a, b) => a.number === b.number && a.day === b.day && a.dayTag === b.dayTag;

  // 2. Keep the runs.
  let count = 0;
  for (const { page, run, problems, unnamedRelief } of parsedPages) {
    // A relief with no run number is likely a printing error: if the same run is printed on
    // another page too, leave this version out; otherwise keep it (it is flagged under problems).
    if (run && unnamedRelief) {
      const other = parsedPages.find((o) => o.page !== page && o.run && sameRun(o.run, run));
      if (other) {
        all.discardedPages.push({ source: name, page, run: run.number, keptPage: other.page,
          reason: "Relief with no run number; the same run is on another page" });
        continue;
      }
    }
    for (const message of problems) all.problems.push({ source: name, page, run: run?.number ?? null, message });
    if (!run) continue;
    // Same run printed again on the next page: skip exact duplicates, flag anything else.
    const prev = all.runs.at(-1);
    if (prev && prev.source === name && sameRun(prev, run)) {
      const { page: _a, source: _b, ...prevBody } = prev;
      const { page: _c, ...thisBody } = run;
      if (JSON.stringify(prevBody) === JSON.stringify(thisBody)) {
        all.duplicatePages.push({ source: name, page, sameAsPage: prev.page, run: run.number });
        continue;
      }
      all.problems.push({ source: name, page, run: run.number,
        message: `Same run number as page ${prev.page} but different contents — kept both` });
    }
    all.runs.push({ ...run, source: name });
    count++;
  }
  all.sources.push({ file: name, pages: pages.length, runs: count });
  console.log(`\rRead ${name}: ${pages.length} pages, ${count} runs.          `);
}

all.runCount = all.runs.length;

// Where each time-point name is (see locations.js), for every name used in these runs.
const used = new Set(all.runs.flatMap((r) => r.halves.flatMap((h) => h.trips.flatMap((t) =>
  [t.begin, ...t.stops, t.end].map((p) => p.location)))));
// Leaders/followers marked "*": look up who takes over that run.
all.problems.push(...resolveMidRunChanges(all.runs));
// Then swap the paddle names in each run for readable names and coordinates.
for (const r of all.runs) placeLocations(r);
// Write every duration (pay, working, travel, recovery, thru work) as "H:MM:SS" text.
for (const r of all.runs) durationsAsText(r);
all.locations = {};
for (const name of [...used].sort()) {
  all.locations[name] = LOCATIONS[name] ?? null;
  if (!LOCATIONS[name]) all.problems.push({ source: null, page: null, run: null, message: `Location "${name}" is not in locations.js` });
}
// One day type and one garage per file.
const days = [...new Set(all.runs.map((r) => r.day))];
const garages = [...new Set(all.runs.map((r) => r.garage || "Unknown garage"))];
if (days.length !== 1 || garages.length !== 1) {
  console.log(`Not saved: these paddles mix ${days.length > 1 ? "days (" + days.join(", ") + ")" : ""}`
    + `${days.length > 1 && garages.length > 1 ? " and " : ""}${garages.length > 1 ? "garages (" + garages.join(", ") + ")" : ""}.`
    + " Run Weekday, Saturday and Sunday paddles separately.");
  process.exit(1);
}
all.statistics = runStatistics(all.runs);
all.garage = garages[0];
all.day = days[0];
outFile ??= `${all.garage} ${all.day} Runs Parsed.json`;
await fs.writeFile(outFile, JSON.stringify(all, null, 2));
console.log(`Saved ${all.runCount} runs to ${outFile}`);
const st = all.statistics;
console.log(`  ${st.inServiceTrips} in-service trips, ${st.pullouts} pullouts, ${st.swings} swings, ${st.blocks} Block, ${st.pto} PTO`);
if (all.duplicatePages.length) console.log(`Skipped ${all.duplicatePages.length} duplicate page(s) — see "duplicatePages".`);
if (all.discardedPages.length) console.log(`Left out ${all.discardedPages.length} page(s) with a printing error that had a good copy elsewhere — see "discardedPages".`);
if (all.problems.length) {
  console.log(`${all.problems.length} problem(s) found — see "problems" in ${outFile}. First few:`);
  for (const p of all.problems.slice(0, 10)) console.log(`  page ${p.page} (${p.run ?? "?"}): ${p.message}`);
}
