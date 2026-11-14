#!/usr/bin/env node
// read-paddles.js — read the run paddles for ONE day type (Weekday, Saturday or Sunday) and save
// every run in one JSON file named "[Garage] [Day] Runs Parsed.json".
//
// Usage:
//   node read-paddles.js <paddles.pdf> [more.pdf ...] [-o other-name.json]
//   e.g. node read-paddles.js North_Park_Saturday.pdf   ->  "North Park Saturday Runs Parsed.json"
//
// All the PDFs given must be for the same day type and the same garage; otherwise nothing is saved.
// The output contains source/run counts, statistics, parsed runs, duplicate/discarded pages, problems,
// and the locations used by those runs. Durations are written as "H:MM:SS" text.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readPdfPages } from "./pdf-text.js";
import { parsePaddlePage } from "./paddle-parser.js";
import { LOCATIONS, placeLocations } from "./locations.js";
import { durationsAsText, resolveMidRunChanges, runStatistics } from "./run.js";

function parseArguments(args) {
  let outFile = null;
  const inputs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--out") outFile = args[++i];
    else inputs.push(args[i]);
  }

  return { inputs, outFile };
}

function createOutput() {
  return {
    createdAt: new Date().toISOString(),
    garage: null,
    day: null,
    statistics: null,
    sources: [],
    runCount: 0,
    runs: [],
    duplicatePages: [],
    discardedPages: [],
    problems: [],
  };
}

async function readSourcePages(input, name) {
  const data = new Uint8Array(await fs.readFile(input));
  const pages = await readPdfPages(data, (done, total) => {
    if (done % 25 === 0 || done === total) {
      process.stdout.write(`\rReading ${name} ... page ${done}/${total}`);
    }
  });

  return pages.map((page) => {
    try {
      return { page: page.page, ...parsePaddlePage(page) };
    } catch (error) {
      return { page: page.page, run: null, problems: [`Couldn't read this page: ${error.message}`] };
    }
  });
}

function sameRun(a, b) {
  return a.number === b.number && a.day === b.day && a.dayTag === b.dayTag;
}

function isDuplicatePage(previous, run, source) {
  if (!previous || previous.source !== source || !sameRun(previous, run)) return false;

  const { page: _previousPage, source: _source, ...previousBody } = previous;
  const { page: _currentPage, ...currentBody } = run;
  return JSON.stringify(previousBody) === JSON.stringify(currentBody);
}

function keepParsedRuns(parsedPages, source, output) {
  let count = 0;

  for (const { page, run, problems, unnamedRelief } of parsedPages) {
    // If a better copy of a run with an unnamed relief exists, leave this page out.
    if (run && unnamedRelief) {
      const betterCopy = parsedPages.find((candidate) =>
        candidate.page !== page && candidate.run && sameRun(candidate.run, run));

      if (betterCopy) {
        output.discardedPages.push({
          source,
          page,
          run: run.number,
          keptPage: betterCopy.page,
          reason: "Relief with no run number; the same run is on another page",
        });
        continue;
      }
    }

    for (const message of problems) {
      output.problems.push({ source, page, run: run?.number ?? null, message });
    }
    if (!run) continue;

    const previous = output.runs.at(-1);
    if (isDuplicatePage(previous, run, source)) {
      output.duplicatePages.push({
        source,
        page,
        sameAsPage: previous.page,
        run: run.number,
      });
      continue;
    }
    if (previous?.source === source && sameRun(previous, run)) {
      output.problems.push({
        source,
        page,
        run: run.number,
        message: `Same run number as page ${previous.page} but different contents — kept both`,
      });
    }

    output.runs.push({ ...run, source });
    count++;
  }

  return count;
}

async function readSource(input, output) {
  const name = path.basename(input);
  process.stdout.write(`Reading ${name} ...`);

  const parsedPages = await readSourcePages(input, name);
  const count = keepParsedRuns(parsedPages, name, output);

  output.sources.push({ file: name, pages: parsedPages.length, runs: count });
  console.log(`\rRead ${name}: ${parsedPages.length} pages, ${count} runs.          `);
}

function addLocationsAndResolveRuns(output) {
  const usedLocations = new Set(
    output.runs.flatMap((run) => run.halves.flatMap((half) =>
      half.trips.flatMap((trip) =>
        [trip.begin, ...trip.stops, trip.end].map((point) => point.location)))),
  );

  output.problems.push(...resolveMidRunChanges(output.runs));

  for (const run of output.runs) {
    placeLocations(run);
    durationsAsText(run);
  }

  output.locations = {};
  for (const name of [...usedLocations].sort()) {
    output.locations[name] = LOCATIONS[name] ?? null;
    if (!LOCATIONS[name]) {
      output.problems.push({
        source: null,
        page: null,
        run: null,
        message: `Location "${name}" is not in locations.js`,
      });
    }
  }
}

function serviceTypes(runs) {
  return {
    days: [...new Set(runs.map((run) => run.day))],
    garages: [...new Set(runs.map((run) => run.garage || "Unknown garage"))],
  };
}

function reportMixedService({ days, garages }) {
  if (days.length === 1 && garages.length === 1) return false;

  const mixedDays = days.length > 1 ? `days (${days.join(", ")})` : "";
  const mixedGarages = garages.length > 1 ? `garages (${garages.join(", ")})` : "";
  const separator = mixedDays && mixedGarages ? " and " : "";
  console.log(`Not saved: these paddles mix ${mixedDays}${separator}${mixedGarages}.`
    + " Run Weekday, Saturday and Sunday paddles separately.");
  return true;
}

function reportResults(output, outFile) {
  const stats = output.statistics;
  console.log(`Saved ${output.runCount} runs to ${outFile}`);
  console.log(`  ${stats.inServiceTrips} in-service trips, ${stats.pullouts} pullouts, ${stats.swings} swings, ${stats.blocks} Block, ${stats.pto} PTO`);
  if (output.duplicatePages.length) {
    console.log(`Skipped ${output.duplicatePages.length} duplicate page(s) — see "duplicatePages".`);
  }
  if (output.discardedPages.length) {
    console.log(`Left out ${output.discardedPages.length} page(s) with a printing error that had a good copy elsewhere — see "discardedPages".`);
  }
  if (output.problems.length) {
    console.log(`${output.problems.length} problem(s) found — see "problems" in ${outFile}. First few:`);
    for (const problem of output.problems.slice(0, 10)) {
      console.log(`  page ${problem.page} (${problem.run ?? "?"}): ${problem.message}`);
    }
  }
}

async function main(args = process.argv.slice(2)) {
  const { inputs, outFile: requestedOutFile } = parseArguments(args);
  if (inputs.length === 0) {
    console.log("Usage: node read-paddles.js <paddles.pdf> [more.pdf ...] [-o other-name.json]");
    console.log("All the PDFs must be for one day type (Weekday, Saturday or Sunday) and one garage.");
    process.exitCode = 1;
    return;
  }

  const output = createOutput();
  for (const input of inputs) await readSource(input, output);

  output.runCount = output.runs.length;
  addLocationsAndResolveRuns(output);

  const types = serviceTypes(output.runs);
  if (reportMixedService(types)) {
    process.exitCode = 1;
    return;
  }

  output.statistics = runStatistics(output.runs);
  output.garage = types.garages[0];
  output.day = types.days[0];

  const outFile = requestedOutFile ?? `${output.garage} ${output.day} Runs Parsed.json`;
  await fs.writeFile(outFile, JSON.stringify(output, null, 2));
  reportResults(output, outFile);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
