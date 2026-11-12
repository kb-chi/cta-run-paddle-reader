// paddle-parser.js — turn one page of a HASTUS run paddle into a run object (see run.js).
//
// How a page is laid out:
//   * Header (top): run number, day, effective date, pay boxes, and one row per half with
//     Plat Time / Half Start / Plat Start / Plat End / Half End.
//   * Body: four columns read left to right, top to bottom. Inside them:
//       PULLOUT 06:16            a half starts by leaving the garage
//       RN P229 16:48            a relief (R + optional N/S/E/W + other run + time), maybe
//       DAVIS PURPL L            followed by where the bus is headed
//       TO RTE: 93 FB code: 93   route for the trips that follow (FB code is not kept)
//       L:005 F:002 HDW: /       header of an in-service trip
//       LOGAN SQ L_____ 08:27 E  a time point (bold = trip begins/ends here; letters = notes)
//       a                        note letter for the out-of-service move below it
//       PULLIN 10:37             a half ends at the garage
//       THRU WORK 15:21          end of the run
//     Groups of time points with no "L: F: HDW:" header are out-of-service moves.
//   * Notes (bottom): "E - BUS MAY OPERATE EARLY ..." legend for the note letters.
//
// Times after midnight continue past 24:00 (00:01 -> 24:01).

import {
  DAYS, duration, parseDuration, parseTime, timeToSeconds, secondsToTime, durationToSeconds,
  parseNeighbor, parseHeadway, parseRelief, point, run, half, trip,
  durationToMinutes, formatDuration,
} from "./run.js";

const TIME = String.raw`\d{1,2}:\d{2}\+?`;
const RE = {
  time: new RegExp(`^${TIME}$`),
  duration: /^\d+h\d{2}$/,
  pullout: new RegExp(`^PULLOUT\\s+(${TIME})$`),
  pullin: new RegExp(`^PULLIN\\s+(${TIME})$`),
  thruWork: new RegExp(`^THRU WORK\\s+(${TIME})$`),
  thruWorkHalf: new RegExp(`^THRU WORK\\s+(1st|2nd)\\s+HALF\\s+(${TIME})$`, "i"),
  route: /^TO RTE:\s*(\S+)(?:\s+FB code:\s*(\S*))?$/, // FB code can be blank ("TO RTE: N5 FB code:")
  // bus-movement notes: "ARR. 29 STOP FOR RELIEF" (bus comes in as a route 29 bus to be relieved),
  // "BUS ARR. FROM RTE. J14" (bus arrives from route J14). Kept on the run as instructions.
  arrival: /^(?:BUS\s+)?ARR\.\s+(?:FROM RTE\.\s*(\S+)|(\S+)\s+STOP FOR RELIEF)$/i,
  tripHeader: /^L:\s*(\S*?)\s*F:\s*(\S*?)\s*HDW:\s*(.*?)((?:\s+[A-Za-z])*)$/, // trailing letters = trip notes
  relief: new RegExp(`^(R[NSEW]?)\\s+(\\S+)\\s+(${TIME})$`),
  reliefNoRun: new RegExp(`^R[NSEW]?\\s+(${TIME})$`), // a relief with no run number: treated as a printing error
  timepoint: new RegExp(`^(.*?)_{2,}\\s*(${TIME})((?:\\s+[A-Za-z])*)$`),
  noteLetters: /^[A-Za-z](?:\s+[A-Za-z])*$/,
  noteLegend: /^(?:Notes:\s*)?([A-Za-z])\s*-\s*(.*)$/,
};

const LINE_TOLERANCE = 2.5; // points: items this close vertically are on the same line
const GROUP_GAP = 16;       // points: a vertical gap bigger than this separates groups (lines are ~11 apart)

/**
 * Parse one page.
 * @param {{page:number,width:number,height:number,items:Array}} page  from readPdfPages()
 * @returns {{ run: Object|null, problems: string[], unnamedRelief?: boolean }}
 *   unnamedRelief: the page has a relief with no run number (read-paddles.js drops the page if the
 *   same run also appears on another page).
 */
export function parsePaddlePage(page) {
  const problems = [];
  const items = page.items.map((i) => ({ ...i, text: i.text.trim() }));

  // ---------- Header ----------
  // Some pages start with a bulletin (e.g. "ROUTE #77 BELMONT HAZARD: ...") that pushes the whole
  // paddle down. The "Effective:" date sits just above the run number on every page (normally at
  // y ≈ 19), so measure the header from it; anything above it is the bulletin.
  const effectiveItem = items.find((i) => /^Effective:/.test(i.text));
  const top = effectiveItem ? effectiveItem.y - 5 : -Infinity;
  const shift = effectiveItem ? Math.max(0, effectiveItem.y - 19) : 0;
  const bulletin = effectiveItem
    ? groupLines(items.filter((i) => i.y < top)).map((l) => tokensInOrder(l.items).join(" ")).join(" ").trim()
    : "";
  // Run number, sometimes with a day tag glued on: "P220Wed Only", "P219M-U-T-F".
  const numberItem = items.find((i) => i.y > top && i.y < 36 + shift && i.x < page.width / 2 && /^[A-Z]?\d{2,}/.test(i.text));
  if (!numberItem) return { run: null, problems: ["No run number found at the top of the page"] };
  const boldFont = numberItem.fontName; // the run number is printed in the bold font
  const [, runNumber, tagStart] = numberItem.text.match(/^([A-Z]?\d{2,})\s*(.*)$/);
  const dayTag = [tagStart, ...items
    .filter((i) => i !== numberItem && Math.abs(i.y - numberItem.y) < 3 && i.x < page.width / 2)
    .sort((a, b) => a.x - b.x).map((i) => i.text)].join(" ").trim();

  const day = items.find((i) => i.y > top && i.y < 48 + shift && DAYS.includes(i.text))?.text;
  if (!day) return { run: null, problems: [`Run ${runNumber}: no day (Weekday/Saturday/Sunday) found`] };
  const effectiveDate = items.map((i) => i.text.match(/Effective:\s*(\S+)/)).find(Boolean)?.[1] ?? "";

  const footerTop = Math.min(
    page.height,
    ...items.filter((i) => /^Notes:/.test(i.text) || /^Subject to revision/.test(i.text)).map((i) => i.y),
  );
  const labelY = items.find((i) => i.text === "Pay:")?.y ?? 52;
  const valueItems = items.filter((i) => i.y > labelY + 5 && i.y < labelY + 45);
  const bodyTop = Math.max(labelY + 20, ...valueItems.map((i) => i.y)) + 5;

  const mid = page.width / 2;
  const leftTokens = tokensInOrder(valueItems.filter((i) => i.x < mid));
  const durations = leftTokens.filter((t) => RE.duration.test(t));
  const reportTimeText = leftTokens.find((t) => RE.time.test(t)) ?? "";
  const dutyType = leftTokens.filter((t) => !RE.duration.test(t) && !RE.time.test(t)).join(" ");
  if (durations.length !== 4) problems.push(`Expected 4 pay boxes on the left, found ${durations.length}`);
  const [payText = "", workingText = "", allowText = "", spreadText = ""] = durations;

  const halfRows = groupLines(valueItems.filter((i) => i.x >= mid)).map((line) => tokensInOrder(line.items));
  for (const row of halfRows) {
    if (row.length !== 5) problems.push(`Half row should have 5 values, found: ${row.join(" ")}`);
  }

  // Times after midnight: anything more than an hour before the report time is the next day.
  const reportSec = reportTimeText ? timeToSeconds(parseTime(reportTimeText)) : 0;
  const fixTime = (text) => {
    let sec = timeToSeconds(parseTime(text));
    if (sec < reportSec - 3600) sec += 24 * 3600;
    return secondsToTime(sec);
  };

  const headerHalves = halfRows.map(([platTime, halfStart, platStart, platEnd, halfEnd]) => ({
    platTime, halfStart: fixTime(halfStart), platStart: fixTime(platStart),
    platEnd: fixTime(platEnd), halfEnd: fixTime(halfEnd),
  }));

  // ---------- Notes legend ----------
  const notes = {};
  let lastCode = null;
  const footerLines = groupLines(items.filter((i) => i.y >= footerTop && !/^Subject to revision/.test(i.text) && i.y < footerTop + 200));
  for (const line of footerLines) {
    if (/^Subject to revision|^HASTUS|^\(/.test(line.text)) break;
    const m = line.text.match(RE.noteLegend);
    if (m) { lastCode = m[1]; notes[lastCode] = m[2].trim(); }
    else if (lastCode) notes[lastCode] += " " + line.text;
  }

  // ---------- Swing run: a double line (instead of a single line) between the halves ----------
  const separators = (page.lines ?? []).filter((l) => {
    const w = l.x1 - l.x0;
    return w > 0.2 * page.width && w < 0.4 * page.width && l.y > bodyTop - 15 && l.y < footerTop;
  });
  // Usually the two lines sit together in one column. When the first half ends at the bottom of a
  // column, the double line is split: one line under the first half, the other at the top of the
  // next column.
  const sepCol = (l) => [0.245, 0.495, 0.744].filter((f) => l.x0 + 3 >= f * page.width).length;
  const stacked = separators.some((a, k) => separators.some((b, j) =>
    j > k && sepCol(a) === sepCol(b) && Math.abs(b.y - a.y) > 2 && Math.abs(b.y - a.y) < 16));
  const firstTextY = Math.min(...items.filter((i) => i.y > bodyTop && i.y < footerTop).map((i) => i.y));
  const split = separators.some((top) => top.y < firstTextY && sepCol(top) > 0 &&
    separators.some((l) => sepCol(l) === sepCol(top) - 1 && l.y > firstTextY));
  const isSwing = stacked || split;

  // ---------- Body: columns -> lines ----------
  const colEdges = [0.245, 0.495, 0.744].map((f) => f * page.width);
  const colOf = (x) => colEdges.filter((e) => x >= e).length;
  const bodyItems = items.filter((i) => i.y > bodyTop && i.y < footerTop);
  const lines = [];
  for (let c = 0; c < 4; c++) {
    const colLines = groupLines(bodyItems.filter((i) => colOf(i.x) === c));
    colLines.forEach((line, k) => {
      line.newColumn = k === 0;
      line.gapBefore = k > 0 && line.y - colLines[k - 1].y > GROUP_GAP;
      lines.push(line);
    });
  }

  // ---------- Body: read the lines in order ----------
  const halves = [];
  let cur = null;          // half being built
  let group = null;        // trip being built: { opts, points: [[loc, time, notes]], bold: [] }
  let route = null;
  let pendingNotes = [];
  let lastRelief = null;   // so a following plain line can fill in headedTo
  let thruWork = null;
  let unnamedRelief = false; // a relief line with no run number
  const halfThruWork = [];    // from "THRU WORK 1st HALF" / "2nd HALF" lines
  const instructions = [];    // "ARR. 29 STOP FOR RELIEF", "BUS ARR. FROM RTE. J14"

  const newHalf = (startType) => ({ startType, startRelief: null, endType: "", relief: null, trips: [] });
  const closeGroup = () => {
    if (!group) return;
    if (group.points.length < 2) problems.push(`Trip with fewer than 2 time points near ${group.points[0]?.[1] ?? "?"}`);
    else cur?.trips.push(trip(group.opts, group.points));
    group = null;
  };
  const closeHalf = () => {
    closeGroup();
    if (cur) halves.push(cur);
    cur = null; route = null;
  };

  for (const line of lines) {
    const t = line.text;
    if (line.gapBefore) closeGroup();
    const wasRelief = lastRelief;
    lastRelief = null;
    let m;

    if ((m = t.match(RE.pullout))) {
      if (cur) { problems.push(`PULLOUT at ${m[1]} while a half was still open`); closeHalf(); }
      cur = newHalf("pullout");
    } else if ((m = t.match(RE.relief)) || (m = t.match(RE.reliefNoRun))) {
      closeGroup();
      let r;
      if (m.length === 2) { // "R 06:11": no run number
        r = { ...parseRelief("R X", fixTime(m[1]), ""), otherRun: "" };
        unnamedRelief = true;
        problems.push(`Relief at ${r.time} has no run number (likely a printing error)`);
      } else {
        r = parseRelief(`${m[1]} ${m[2]}`, fixTime(m[3]), "");
      }
      if (!cur) { cur = newHalf("relief"); cur.startRelief = r; }
      else { cur.relief = r; cur.endType = "relief"; closeHalf(); }
      lastRelief = r;
    } else if ((m = t.match(RE.pullin))) {
      if (!cur) problems.push(`PULLIN at ${m[1]} with no half open`);
      else { cur.endType = "pullin"; closeHalf(); }
    } else if ((m = t.match(RE.thruWorkHalf))) {
      // "THRU WORK 1st HALF 10:32": when that half is done (should equal its Half End)
      if (cur) closeHalf();
      halfThruWork[m[1].toLowerCase() === "1st" ? 0 : 1] = fixTime(m[2]);
    } else if ((m = t.match(RE.thruWork))) {
      if (cur) closeHalf();
      thruWork = fixTime(m[1]);
    } else if ((m = t.match(RE.route))) {
      closeGroup();
      route = m[1];
    } else if ((m = t.match(RE.arrival))) {
      // the half it belongs to: the open one, or the next one if it comes before that half starts
      instructions.push({ half: halves.length + 1, text: t, route: m[1] ?? m[2],
        kind: m[1] ? "arrivesFromRoute" : "arrivesForRelief" });
    } else if ((m = t.match(RE.tripHeader))) {
      closeGroup();
      group = {
        opts: {
          inService: true, leader: m[1], follower: m[2], headway: m[3], route,
          notes: [...pendingNotes, ...(m[4].trim() ? m[4].trim().split(/\s+/) : [])],
        },
        points: [],
      };
      pendingNotes = [];
    } else if ((m = t.match(RE.timepoint))) {
      if (!cur) { problems.push(`Time point "${t}" outside any half`); continue; }
      if (!group) {
        group = { opts: { inService: false, notes: pendingNotes }, points: [] };
        pendingNotes = [];
      }
      const ptNotes = m[3].trim() ? m[3].trim().split(/\s+/) : [];
      group.points.push([m[1].trim(), fixTime(m[2]), ptNotes]);
      const isBold = line.items.some((i) => i.fontName === boldFont && /_{2,}/.test(i.text));
      if (isBold && group.points.length > 1) closeGroup(); // bold = trip ends here
    } else if (RE.noteLetters.test(t)) {
      closeGroup();
      pendingNotes.push(...t.split(/\s+/));
    } else if (wasRelief && !wasRelief.headedTo) {
      wasRelief.headedTo = t;
    } else {
      problems.push(`Didn't recognize line "${t}"`);
    }
  }
  if (cur) { problems.push("Last half was never closed (no relief or PULLIN)"); closeHalf(); }

  // ---------- Put it together ----------
  if (halves.length !== headerHalves.length) {
    problems.push(`Header lists ${headerHalves.length} half/halves but the body has ${halves.length}`);
  }
  const builtHalves = halves.map((h, idx) => {
    const hdr = headerHalves[idx] ?? {};
    const first = h.trips[0]?.begin.location ?? h.startRelief?.headedTo ?? "";
    const last = h.trips.at(-1)?.end.location ?? "";
    const actualStart = h.startRelief?.time ?? h.trips[0]?.begin.time;
    const actualEnd = h.relief?.time ?? h.trips.at(-1)?.end.time;
    if (hdr.platStart && actualStart && hdr.platStart !== actualStart) {
      problems.push(`Half ${idx + 1}: Plat Start ${hdr.platStart} but body starts at ${actualStart}`);
    }
    if (hdr.platEnd && actualEnd && hdr.platEnd !== actualEnd) {
      problems.push(`Half ${idx + 1}: Plat End ${hdr.platEnd} but body ends at ${actualEnd}`);
    }
    return half(
      hdr.halfStart ? point(hdr.halfStart, first) : point(actualStart ?? "00:00", first),
      h.trips,
      hdr.halfEnd ? point(hdr.halfEnd, last) : point(actualEnd ?? "00:00", last),
      h.relief,
      { start: hdr.platStart, end: hdr.platEnd },
      { startType: h.startType, endType: h.endType, startRelief: h.startRelief },
    );
  });
  // The three parts of each half add up to the exact time from Plat Start to Plat End. The printed
  // Plat Time rounds Plat Start down and Plat End up to whole minutes, so it can be up to a minute more.
  builtHalves.forEach((h, k) => {
    const hdr = headerHalves[k];
    if (!hdr?.platTime || !hdr.platStart || !hdr.platEnd) return;
    const parts = durationToSeconds(h.inServiceTravel) + durationToSeconds(h.outOfServiceTravel) + durationToSeconds(h.recoveryTime);
    const start = timeToSeconds(hdr.platStart), end = timeToSeconds(hdr.platEnd);
    const rounded = Math.ceil(end / 60) * 60 - Math.floor(start / 60) * 60;
    if (parts !== end - start || rounded !== durationToSeconds(parseDuration(hdr.platTime))) {
      problems.push(`Half ${k + 1}: in service + out of service + recovery = ${secondsToTime(parts)}, `
        + `Plat Start-End = ${secondsToTime(end - start)}, printed Plat Time ${hdr.platTime}`);
    }
  });
  halfThruWork.forEach((tw, k) => {
    if (tw && builtHalves[k] && tw !== builtHalves[k].end.time) {
      problems.push(`THRU WORK ${k ? "2nd" : "1st"} HALF ${tw} doesn't match Half End ${builtHalves[k].end.time}`);
    }
  });
  const lastHalfEnd = builtHalves.at(-1)?.end.time;
  if (thruWork && lastHalfEnd && thruWork !== lastHalfEnd) {
    problems.push(`THRU WORK ${thruWork} doesn't match last Half End ${lastHalfEnd}`);
  }

  const result = run(
    runNumber,
    day,
    {
      total: payText || null,
      allowance: allowText || null,
      spread: spreadText || null,
      firstHalf: headerHalves[0]?.platTime ?? null,
      secondHalf: headerHalves[1]?.platTime ?? null,
      sunday: null, // not printed: run() applies the Sunday pay rule
    },
    builtHalves,
    {
      effectiveDate,
      reportTime: reportTimeText,
      working: workingText ? parseDuration(workingText) : duration(0, 0),
      dutyType,
      dayTag,
      isSwing,
      page: page.page,
      notes,
    },
  );
  if (reportTimeText) result.reportTime = fixTime(reportTimeText);
  if (bulletin) result.bulletin = bulletin;
  if (instructions.length) result.instructions = instructions;

  if (!result.garage) problems.push(`Unknown garage for run number ${result.number}`);

  // Pay is calculated in run(); flag runs where the printed Pay disagrees.
  if (result.printedPay && durationToMinutes(result.printedPay) !== durationToMinutes(result.pay.total)) {
    problems.push(`Printed Pay ${formatDuration(result.printedPay)} differs from calculated Pay ${formatDuration(result.pay.total)}`);
  }
  return { run: result, problems, unnamedRelief };
}

// ---------- helpers ----------

/** Group items into lines (same y), each line's items sorted left to right. */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(it.y - line.y) <= LINE_TOLERANCE) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.text = line.items.map((i) => i.text).join(" ").replace(/\s+/g, " ").trim();
  }
  return lines;
}

/** Split items into whitespace-separated tokens, left to right (top to bottom for ties). */
function tokensInOrder(items) {
  return [...items]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .flatMap((i) => i.text.split(/\s+/))
    .filter(Boolean);
}
