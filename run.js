// run.js — data model for a CTA run paddle.
//
// Shape of a Run (plain JavaScript object, safe to save as JSON):
//
// {
//   number: "P001",
//   garage: "North Park",                  // from the run number's first character (see GARAGES)
//   day: "Saturday",                       // "Weekday" | "Saturday" | "Sunday"
//   dayTag: "",                            // printed after the run number, e.g. "Wed Only", "M-U-T-F" ("" if none)
//   operatingDays: ["Sat"],                // days the run operates: from dayTag, else every day of `day`
//   effectiveDate: "08/29/2026",           // "Effective:" as printed
//   reportTime: "06:01",                   // "Report:"
//   working: { hours: 8, minutes: 12 },    // "Working:"
//   dutyType: "Regular",                   // "Duty Type:" as printed (Block, PTO, ...); "Regular" when blank
//   isSwing: false,                        // swing run: double line between the halves on the paddle
//   page: 1,                               // PDF page the run came from (0 if entered by hand)
//   notes: { E: "BUS MAY OPERATE EARLY AT TIMEPOINT INDICATED", a: "VIA FOSTER - ..." },  // legend at page bottom
//   printedPay: { hours: 8, minutes: 12 }, // "Pay:" as printed — for reference only, can be wrong
//   inServiceTravel, outOfServiceTravel, recoveryTime: totals of both halves (h/m/s)
//   pay: {                                 // each { hours, minutes }
//     total,        // CALCULATED: firstHalf + secondHalf + allowance + spread + sunday
//     allowance,    // paddle "Allow"
//     spread,       // paddle "Spread"
//     firstHalf,    // paddle "Plat Time", row 1
//     secondHalf,   // paddle "Plat Time", row 2
//     sunday,       // not printed: 0h30 on Sunday runs with Duty Type BLOCK or blank and no
//                   // fallback (X); otherwise 0h00
//   },
//   halves: [
//     {
//       startType: "pullout",                                    // "pullout" | "relief"
//       startRelief: null,                                       // relief you make to start the half (same shape as relief)
//       start: { time: "06:01", location: "N PARK GARAGE" },     // header "Half Start"
//       platformStart: "06:16",                                  // header "Plat Start"
//       platformEnd: "09:06",                                    // header "Plat End"
//       trips: [
//         {
//           inService: true,                               // false = pullout / pull-in / deadhead / layover
//           route: "93",                                   // "TO RTE:" in effect (null when not in service)
//           notes: [],                                     // note letters on the trip, e.g. ["a"] (see run.notes)
//           leader:   { run: "005", changesMidRun: false } | null,   // "L:" — bus ahead
//           follower: { run: "002", changesMidRun: false } | null,   // "F:" — bus behind
//                     // "006*" (changes mid-run): changesMidRun is the run that takes over, e.g. "P002"
//           headway: {                                     // "HDW:" — e.g. "19/18", "fst/", "/lst", "/" (fst/lst not kept)
//             headwayAhead: 19,   // minutes to the leader (null if blank)
//             headwayBehind: 18,  // minutes to the follower (null if blank)
//           },
//           begin: { time: "07:37", location: "DAVIS PURPL L" },
//           stops: [ { time, location }, ... ],            // 0 or more intermediate time points
//                                                          // any point may also have notes: ["E"]
//           end:   { time: "08:27", location: "LOGAN SQ L" },
//         },
//       ],
//       end: { time: "09:07", location: "FOSTER ALBANY" },       // header "Half End"
//       thruWorkTime: { hours: 0, minutes: 0, seconds: 30 },     // Half End - Plat End
//       inServiceTravel:    { hours: 2, minutes: 14, seconds: 0 },  // Plat Time, split three ways
//       outOfServiceTravel: { hours: 0, minutes: 0, seconds: 0 },   // (see platTimeBreakdown())
//       recoveryTime:       { hours: 0, minutes: 36, seconds: 30 },
//       endType: "relief",                                       // "relief" | "pullin"
//       relief: {                                          // relief that ends the half (null for a pull-in)
//         time: "09:06",
//         direction: "Northbound",                         // from RN / RS / RE / RW; "Terminal" for plain "R"
//         otherRun: "P008",                                // run that relieves you (or, in startRelief, the run you relieve)
//         headedTo: "DAVIS PURPL L",
//       },
//     },
//     { ...second half... },
//   ],
// }
//
// Times are stored as "HH:MM:SS". A "+" on the paddle means 30 seconds (04:30+ -> "04:30:30",
// 04:30 -> "04:30:00"). Times after midnight continue past 24:00 (00:01 -> "24:01:00",
// 01:01 -> "25:01:00"). Use timeToSeconds() / timeToMinutes() to do math.

export const DAYS = ["Weekday", "Saturday", "Sunday"];

export const PAY_FIELDS = ["total", "allowance", "spread", "firstHalf", "secondHalf", "sunday"];

export const DIRECTIONS = { N: "Northbound", S: "Southbound", E: "Eastbound", W: "Westbound" };

/** Garage, by the first character of the run number. */
export const GARAGES = { P: "North Park", K: "Kedzie", F: "Forest Glen", 5: "Chicago", 1: "103rd", 6: "74th", 7: "77th" };

/** "P001" -> "North Park". Unknown first character -> "". */
export function garageOf(runNumber) {
  return GARAGES[String(runNumber ?? "").trim().charAt(0).toUpperCase()] ?? "";
}

// ---------- Operating days ----------

const DAY_LETTERS = { M: "Mon", U: "Tue", W: "Wed", T: "Thu", F: "Fri" };
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Days a run operates.
 * "" -> every day of its service day (Weekday = Mon-Fri, Saturday = Sat, Sunday = Sun)
 * "Wed Only" -> ["Wed"];  "M-U-T-F" -> ["Mon", "Tue", "Thu", "Fri"]  (M Mon, U Tue, W Wed, T Thu, F Fri)
 */
export function operatingDays(day, dayTag = "") {
  const tag = String(dayTag ?? "").trim();
  if (tag === "") return day === "Weekday" ? DAY_NAMES.slice(0, 5) : day === "Saturday" ? ["Sat"] : ["Sun"];
  const only = tag.match(/^(\w{3})\w*\s+Only$/i);
  if (only) {
    const name = DAY_NAMES.find((d) => d.toLowerCase() === only[1].toLowerCase());
    if (name) return [name];
  }
  const letters = tag.split(/[-\s]+/);
  if (letters.every((l) => DAY_LETTERS[l.toUpperCase()])) return letters.map((l) => DAY_LETTERS[l.toUpperCase()]);
  throw new Error(`Can't read day tag "${dayTag}"`);
}

// ---------- Sunday pay ----------

/**
 * Sunday pay isn't printed on paddles. Sunday runs whose Duty Type is Regular (blank) or Block get 30 minutes,
 * unless the run has a fallback (X) — then 0, whatever the Duty Type.
 */
export function sundayPay(day, dutyType = "", fallback = false) {
  const type = String(dutyType ?? "").trim().toUpperCase();
  return day === "Sunday" && !fallback && (type === "" || type === "REGULAR" || type === "BLOCK") ? duration(0, 30) : duration(0, 0);
}

/**
 * Does the run have a fallback? True if any trip or time point carries the fallback note letter
 * (the letter whose legend text is "FALLBACK", or "X" if the legend doesn't say).
 */
export function hasFallback(halves = [], notes = {}) {
  const letter = Object.keys(notes).find((k) => /^FALLBACK$/i.test(String(notes[k]).trim())) ?? "X";
  return halves.some((h) => h.trips.some((t) =>
    t.notes.includes(letter) || [t.begin, ...t.stops, t.end].some((p) => (p.notes ?? []).includes(letter))));
}

/** Total pay = first half + second half + allowance + spread + Sunday pay. */
export function calculatePay(pay) {
  const parts = ["firstHalf", "secondHalf", "allowance", "spread", "sunday"];
  return duration(0, parts.reduce((sum, k) => sum + (pay[k] ? pay[k].hours * 60 + pay[k].minutes : 0), 0));
}

// ---------- Durations (pay amounts) ----------

/** Make a duration. Minutes over 59 roll into hours. */
export function duration(hours = 0, minutes = 0) {
  const total = Math.round(hours * 60 + minutes);
  if (!Number.isFinite(total) || total < 0) throw new Error(`Invalid duration: ${hours}h ${minutes}m`);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}

/** Parse a duration written "8h12" (as on paddles) or "8:12". Empty text means 0h00. */
export function parseDuration(text) {
  const t = String(text ?? "").trim();
  if (t === "") return duration(0, 0);
  const m = t.match(/^(\d+)\s*[h:]\s*(\d{2})$/i);
  if (!m) throw new Error(`Can't read duration "${text}" (expected like 8h12)`);
  return duration(Number(m[1]), Number(m[2]));
}

export function durationToMinutes(d) {
  return d.hours * 60 + d.minutes;
}

export function formatDuration(d) {
  return `${d.hours}h${String(d.minutes).padStart(2, "0")}`;
}

// ---------- Times and points ----------

/**
 * Read a paddle time into "HH:MM:SS". A "+" means 30 seconds:
 * "06:16" -> "06:16:00", "06:16+" -> "06:16:30". "HH:MM:SS" is accepted as is.
 */
export function parseTime(text) {
  const t = String(text ?? "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(\+?)$/);
  if (!m || (m[3] && m[4])) throw new Error(`Can't read time "${text}" (expected like 06:16 or 06:16+)`);
  const sec = m[3] ?? (m[4] ? "30" : "00");
  return `${m[1].padStart(2, "0")}:${m[2]}:${sec}`;
}

/** "06:16:30" -> seconds after midnight (22590). Times past 24:00 work too. */
export function timeToSeconds(time) {
  const [h, m, sec = 0] = time.split(":").map(Number);
  return h * 3600 + m * 60 + sec;
}

/** "06:16:30" -> minutes after midnight (376.5). */
export function timeToMinutes(time) {
  return timeToSeconds(time) / 60;
}

/** Seconds after midnight -> "HH:MM:SS" (86430 -> "24:00:30"). */
export function secondsToTime(seconds) {
  const s = Math.round(seconds);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Minutes after midnight -> "HH:MM:SS" (1441 -> "24:01:00"). */
export function minutesToTime(minutes) {
  return secondsToTime(minutes * 60);
}

/** Seconds -> { hours, minutes, seconds } (e.g. 8070 -> 2h 14m 30s). */
export function durationFromSeconds(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return { hours: Math.floor(s / 3600), minutes: Math.floor((s % 3600) / 60), seconds: s % 60 };
}

/** { hours, minutes, seconds? } -> "H:MM:SS" (e.g. 1:19:30). */
export function durationText(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.hours}:${pad(d.minutes)}:${pad(d.seconds ?? 0)}`;
}

/** Replace every { hours, minutes[, seconds] } object inside a run with "H:MM:SS" text (in place). */
export function durationsAsText(value) {
  if (Array.isArray(value)) { value.forEach((v, i) => { value[i] = durationsAsText(v); }); return value; }
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => ["hours", "minutes", "seconds"].includes(k)) && "hours" in value) {
      return durationText(value);
    }
    for (const k of keys) value[k] = durationsAsText(value[k]);
  }
  return value;
}

/** { hours, minutes, seconds? } -> seconds. */
export function durationToSeconds(d) {
  return (d.hours * 60 + d.minutes) * 60 + (d.seconds ?? 0);
}

/**
 * Split a half's platform time into in-service travel, out-of-service travel and recovery time.
 *   in service:     length of each in-service trip (first to last time point)
 *   out of service: length of each out-of-service move (pullout, pull-in, deadhead)
 *   recovery:       every gap between trips, plus the wait between a starting relief and the first
 *                   trip and between the last trip and an ending relief (zero-length layover entries
 *                   add nothing either way)
 */
export function platTimeBreakdown(trips = [], startRelief = null, endRelief = null) {
  let inService = 0, outOfService = 0, recovery = 0;
  if (trips.length) {
    let prevEnd = startRelief ? timeToSeconds(startRelief.time) : timeToSeconds(trips[0].begin.time);
    for (const t of trips) {
      const begin = timeToSeconds(t.begin.time), end = timeToSeconds(t.end.time);
      recovery += begin - prevEnd;
      if (t.inService) inService += end - begin;
      else if (end > begin) outOfService += end - begin;
      prevEnd = end;
    }
    if (endRelief) recovery += timeToSeconds(endRelief.time) - prevEnd;
  }
  return {
    inServiceTravel: durationFromSeconds(inService),
    outOfServiceTravel: durationFromSeconds(outOfService),
    recoveryTime: durationFromSeconds(recovery),
  };
}

/** A time and place, e.g. point("06:16+", "FOSTER ALBANY"). Notes (letters) are kept only when given. */
export function point(time, location, notes = []) {
  const p = { time: parseTime(time), location: String(location).trim() };
  if (notes.length) p.notes = [...notes];
  return p;
}

// ---------- Leader / follower / relief ----------

/** Parse the value after "L:" or "F:". "006*" -> { run: "006", changesMidRun: true }; blank -> null. */
export function parseNeighbor(text) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const m = t.match(/^(\w+?)(\*?)$/);
  if (!m) throw new Error(`Can't read leader/follower "${text}"`);
  return { run: m[1], changesMidRun: m[2] === "*" };
}

/**
 * Parse a relief line, e.g. parseRelief("RN P008", "09:06+", "DAVIS PURPL L").
 * R = relief, then N/S/E/W for direction, then the relieving run.
 */
export function parseRelief(code, time, headedTo) {
  const m = String(code).trim().match(/^R([NSEW]?)\s+(\w+)$/i);
  if (!m) throw new Error(`Can't read relief "${code}" (expected like RN P008)`);
  return {
    time: parseTime(time),
    direction: m[1] ? DIRECTIONS[m[1].toUpperCase()] : "Terminal", // plain "R" = relief at a terminal
    otherRun: m[2],
    headedTo: String(headedTo ?? "").trim(),
  };
}

// ---------- Headway ----------

/**
 * Parse the value after "HDW:".
 * "19/18" -> { headwayAhead: 19, headwayBehind: 18 }
 * "fst/20" -> { headwayAhead: null, headwayBehind: 20 }   ("fst" / "lst" = first / last bus out: not kept)
 * "/" or blank -> all empty
 */
export function parseHeadway(text) {
  const t = String(text ?? "").replace(/\+/g, "").trim();
  const result = { headwayAhead: null, headwayBehind: null };
  if (t === "" || t === "/") return result;
  const parts = t.split("/").map((x) => x.trim().toLowerCase());
  if (parts.length > 2) throw new Error(`Can't read headway "${text}"`);
  const [a = "", b = ""] = parts;
  const read = (part, side) => {
    if (part === "") return;
    if (part === "fst" || part === "lst") return; // first / last bus out: not kept
    else if (/^\d+$/.test(part)) result[side] = Number(part);
    else throw new Error(`Can't read headway "${text}"`);
  };
  read(a, "headwayAhead");
  read(b, "headwayBehind");
  return result;
}

// ---------- Trips, halves, runs ----------

/**
 * Make a trip.
 * @param {Object} opts
 * @param {boolean} opts.inService  false for pullouts / deadheads
 * @param {string}  [opts.leader]   text after "L:", e.g. "006*"
 * @param {string}  [opts.follower] text after "F:"
 * @param {string}  [opts.headway]  text after "HDW:"
 * @param {string}  [opts.route]    "TO RTE:" value (ignored when not in service)
 * @param {string[]} [opts.notes]   note letters on the trip
 * @param {Array<[string,string,string[]?]>} timepoints  [location, time, notes?] rows in order; first = begin, last = end
 */
export function trip(
  { inService = true, leader = "", follower = "", headway = "", route = null, notes = [] } = {},
  timepoints,
) {
  if (!Array.isArray(timepoints) || timepoints.length < 2) {
    throw new Error("A trip needs at least a begin and an end time point");
  }
  const pts = timepoints.map(([location, time, ptNotes = []]) => point(time, location, ptNotes));
  return {
    inService: Boolean(inService),
    route: inService && route ? String(route) : null,
    notes: [...notes],
    leader: parseNeighbor(leader),
    follower: parseNeighbor(follower),
    headway: parseHeadway(headway),
    begin: pts[0],
    stops: pts.slice(1, -1),
    end: pts[pts.length - 1],
  };
}

/**
 * Make one half of a run.
 * @param {Object} start  point() for "Half Start"
 * @param {Array} trips
 * @param {Object} end    point() for "Half End"
 * @param {Object|null} relief  parseRelief(...) or null
 * @param {{start:string,end:string}} [platform]  "Plat Start" / "Plat End" times
 * @param {Object} [how]  { startType: "pullout"|"relief", endType: "relief"|"pullin", startRelief }
 */
export function half(start, trips = [], end, relief = null, platform = {}, how = {}) {
  return {
    startType: how.startType ?? "",
    startRelief: how.startRelief ?? null,
    start,
    platformStart: platform.start ? parseTime(platform.start) : "",
    platformEnd: platform.end ? parseTime(platform.end) : "",
    trips: [...trips],
    end,
    thruWorkTime: platform.end && end?.time
      ? durationFromSeconds(timeToSeconds(end.time) - timeToSeconds(parseTime(platform.end)))
      : durationFromSeconds(0),
    endType: how.endType ?? (relief ? "relief" : ""),
    relief,
    ...platTimeBreakdown(trips, how.startRelief ?? null, relief),
  };
}

/**
 * Make a run.
 * @param {string} number  e.g. "P001"
 * @param {"Weekday"|"Saturday"|"Sunday"} day
 * @param {Object} pay  any of PAY_FIELDS, each "8h12" text or { hours, minutes }. Missing ones become 0h00,
 *                      except a missing sunday, which follows the Sunday pay rule (see sundayPay(),
 *                      hasFallback()).
 *                      pay.total is NOT used for the total: the total is always calculated
 *                      (first half + second half + allowance + spread + Sunday pay). A given total is
 *                      kept as printedPay for reference.
 * @param {Array} halves  first half and second half
 * @param {Object} [details]  { dayTag, effectiveDate, reportTime, working, dutyType, isSwing, page, notes } as printed on the paddle
 */
export function run(number, day, pay = {}, halves = [], details = {}) {
  if (!DAYS.includes(day)) throw new Error(`Day must be one of ${DAYS.join(", ")} — got "${day}"`);
  const fullPay = {};
  for (const field of PAY_FIELDS) {
    const v = pay[field];
    fullPay[field] = v == null ? duration(0, 0) : typeof v === "string" ? parseDuration(v) : duration(v.hours, v.minutes);
  }
  if (pay.sunday == null) fullPay.sunday = sundayPay(day, details.dutyType, hasFallback(halves, details.notes));
  const printedPay = pay.total == null ? null : fullPay.total;
  fullPay.total = calculatePay(fullPay);
  return {
    number: String(number).trim(),
    garage: garageOf(number),
    day,
    dayTag: String(details.dayTag ?? "").trim(),
    operatingDays: operatingDays(day, details.dayTag),
    effectiveDate: String(details.effectiveDate ?? "").trim(),
    reportTime: details.reportTime ? parseTime(details.reportTime) : "",
    working: details.working == null ? duration(0, 0)
      : typeof details.working === "string" ? parseDuration(details.working)
      : duration(details.working.hours, details.working.minutes),
    dutyType: String(details.dutyType ?? "").trim() || "Regular",
    isSwing: Boolean(details.isSwing),
    page: details.page ?? 0,
    notes: { ...(details.notes ?? {}) },
    printedPay,
    pay: fullPay,
    ...Object.fromEntries(["inServiceTravel", "outOfServiceTravel", "recoveryTime"].map((k) =>
      [k, durationFromSeconds(halves.reduce((sum, h) => sum + (h[k] ? durationToSeconds(h[k]) : 0), 0))])),
    halves: [...halves],
  };
}

/**
 * Fill in changesMidRun for leaders/followers marked "*" (in place, across a list of runs).
 * "L:006*" means run 006 is relieved partway through: find run 006 on the same paddle file
 * (same garage letter, overlapping operating days), take the relief closest to this trip's time —
 * either one ending a half of run 006 ("RS P002"), or another run starting a half by relieving 006
 * ("RN P006") — and set changesMidRun to the relieving run (e.g. "P002").
 * If no run of ours with that number is on the same route around that time (most likely another
 * garage's run), changesMidRun is set to "error".
 * Returns messages for marks that still couldn't be resolved (those keep changesMidRun: true).
 */
export function resolveMidRunChanges(runs) {
  const problems = [];
  const byKey = new Map();
  for (const r of runs) {
    const k = `${r.source ?? ""}|${r.number}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  for (const r of runs) {
    const prefix = r.number.match(/^[A-Z]*/)[0];
    for (const h of r.halves) for (const t of h.trips) for (const side of ["leader", "follower"]) {
      const n = t[side];
      if (!n || n.changesMidRun !== true) continue;
      const want = /^[A-Z]/.test(n.run) ? n.run : prefix + n.run;
      const from = timeToSeconds(t.begin.time), to = timeToSeconds(t.end.time);
      // Only a run of ours that is on the same route around this trip can be the bus ahead/behind.
      // Leader/follower numbers carry no garage letter, so a number that doesn't fit is most likely
      // another garage's run: mark it "error" for now.
      const onRouteNearby = (o) => o.halves.some((oh) => oh.trips.some((ot) => ot.inService && ot.route === t.route
        && timeToSeconds(ot.end.time) >= from - 3600 && timeToSeconds(ot.begin.time) <= to + 3600));
      const candidates = (byKey.get(`${r.source ?? ""}|${want}`) ?? [])
        .filter((o) => o.day === r.day && o.operatingDays.some((d) => r.operatingDays.includes(d)) && onRouteNearby(o));
      if (!candidates.length) { n.changesMidRun = "error"; continue; }
      let best = null;
      const consider = (time, who) => {
        if (!time || !who) return;
        const at = timeToSeconds(time);
        const gap = at < from ? from - at : at > to ? at - to : 0;
        if (!best || gap < best.gap) best = { gap, run: who };
      };
      // 1. that run's own paddle: "RS P002" ending one of its halves
      for (const o of candidates) for (const oh of o.halves) if (oh.relief) consider(oh.relief.time, oh.relief.otherRun);
      // 2. another paddle that starts a half by relieving that run: "RN P006"
      for (const o of runs) {
        if (o.source !== r.source || o.day !== r.day || !o.operatingDays.some((d) => r.operatingDays.includes(d))) continue;
        for (const oh of o.halves) if (oh.startRelief && oh.startRelief.otherRun === want) consider(oh.startRelief.time, o.number);
      }
      if (best && best.gap <= 90 * 60 && best.run) n.changesMidRun = best.run;
      else problems.push({ source: r.source ?? null, page: r.page, run: r.number,
        message: `${side === "leader" ? "Leader" : "Follower"} ${n.run}* on the ${t.begin.time} trip: couldn't find who relieves ${want}` });
    }
  }
  return problems;
}

/**
 * Totals across a list of runs:
 *   inServiceTrips          number of in-service trips
 *   inServiceTripsByRoute   { "22": 812, "36": 401, ... } (sorted by route)
 *   pullouts                halves that start with a pullout
 *   swings                  swing runs (double line between the halves)
 *   blocks                  runs with Duty Type "Block"
 *   pto                     runs with Duty Type "PTO"
 *   tripStartsByRoute       per route: how each in-service trip starts (count and percent):
 *                             pullout, deadheadSameRoute, fromOtherRoute, turnAround
 *   (the first trip after taking over a bus by relief: a plain "R" (terminal) relief counts
 *   everywhere, as turnAround; a directional relief (RN / RS / RE / RW) is left out of the
 *   trip totals and trip starts, but still counts in buses in service by hour)
 *   busesInServiceByRouteByHour  per route, per hour ("05:00", ... "25:00"): distinct buses with
 *                             an in-service trip on that route during that hour (a bus handed from
 *                             one run to another by relief counts once; see busesFromReliefs)
 *   peakBusesByRouteByHour  per route, per hour: the most buses on the route at the same moment
 *                             (see peakBusesAtOnce)
 *   directionsByRoute       per route, per terminal: first and last trip from it, trip count and
 *                             average frequency in minutes (see routeDirections; uses the same
 *                             trips as the trip totals)
 */
export function runStatistics(runs) {
  const byRoute = {};
  let inServiceTrips = 0, pullouts = 0;
  // The first trip after taking over a bus by relief: a plain "R" relief (at a terminal) counts
  // like any other trip; a directional relief (RN / RS / RE / RW, mid-route) is left out of the
  // trip totals and trip starts (it still counts toward buses in service by hour).
  const isTerminalRelief = (h) => h.startType === "relief" && h.startRelief?.direction === "Terminal";
  const startsWithDirectionalRelief = (h, t) =>
    h.startType === "relief" && !isTerminalRelief(h) && h.trips.find((x) => x.inService) === t;
  // A trip split by a mid-route relief is printed as two pieces on two paddles. Join them back (the
  // piece that ends a half → the piece that starts the relieving run's half at the same place, within
  // 2 minutes, same route), so where the trip really ends is known (the route page does the same).
  const piecesByRun = new Map(); // run -> its in-service pieces { h, t, first, last }
  for (const r of runs) for (const h of r.halves) {
    const ins = h.trips.filter((x) => x.inService);
    const list = piecesByRun.get(r.number) ?? piecesByRun.set(r.number, []).get(r.number);
    ins.forEach((t, i) => list.push({ h, t, first: i === 0, last: i === ins.length - 1 }));
  }
  const nextPiece = new Map(); // trip -> the piece that finishes it
  for (const list of piecesByRun.values()) for (const p of list) {
    if (!p.first || !startsWithDirectionalRelief(p.h, p.t)) continue;
    const at = timeToSeconds(p.t.begin.time);
    const prev = (piecesByRun.get(p.h.startRelief?.otherRun) ?? []).find((q) => q.last && !nextPiece.has(q.t)
      && q.t.route === p.t.route && q.t.end.location === p.t.begin.location && Math.abs(timeToSeconds(q.t.end.time) - at) <= 120);
    if (prev) nextPiece.set(prev.t, p);
  }
  // the whole trip: this piece's start, every later piece's stops (relief points included), the last piece's end;
  // and whether its last piece is handed over mid-route to a run not found here (then its end isn't known)
  const joinTrip = (t, h) => {
    let cur = { h, t };
    const stops = [...(t.stops ?? [])];
    while (nextPiece.has(cur.t)) { const n = nextPiece.get(cur.t); stops.push(cur.t.end, ...(n.t.stops ?? [])); cur = n; }
    const relievedMidRoute = cur.h.endType === "relief" && cur.h.relief?.direction !== "Terminal" && cur.h.trips.filter((x) => x.inService).at(-1) === cur.t;
    return { trip: cur.t === t ? t : { ...t, stops, end: cur.t.end }, relievedMidRoute };
  };
  const tripsByRoute = {}; // the counted trips (joined), with their run, for the by-direction summary
  for (const r of runs) for (const h of r.halves) {
    if (h.startType === "pullout") pullouts++;
    for (const t of h.trips) if (t.inService && !startsWithDirectionalRelief(h, t)) {
      inServiceTrips++;
      const route = t.route ?? "unknown";
      byRoute[route] = (byRoute[route] ?? 0) + 1;
      (tripsByRoute[route] ??= []).push({ ...joinTrip(t, h), source: t, run: r.number });
    }
  }
  // --- How each in-service trip starts, by route ---
  // pullout:              first trip after leaving the garage
  // deadheadSameRoute:    after an out-of-service move; the bus's previous trip was this route
  // fromOtherRoute:       the bus's previous trip was a different route (directly or via deadhead)
  // turnAround:           right after another trip on the same route, or the first trip after
  //                       taking over a bus by a plain "R" (terminal) relief
  // (the first trip after a directional relief — RN / RS / RE / RW — is left out)
  const starts = {};
  const startOf = new Map(); // trip -> how it starts, kept on each departure in directionsByRoute
  const fromRouteOf = new Map(); // trip -> the route the bus came from, for a fromOtherRoute start
  // --- Buses in service by route by hour: distinct buses with an in-service trip in that hour ---
  // (a bus handed from one run to another by relief is one bus)
  const busOf = busesFromReliefs(runs);
  const busesByHour = {};
  const tripsByBus = new Map(); // bus id -> its in-service trips, for the peak at once
  for (const r of runs) for (const h of r.halves) {
    let prevRoute = null, sawDeadhead = false;
    for (const t of h.trips) {
      if (!t.inService) { if (prevRoute !== null) sawDeadhead = true; continue; }
      const route = t.route ?? "unknown";
      // buses by hour counts every in-service trip, including one that starts with a relief
      const from = timeToSeconds(t.begin.time), to = timeToSeconds(t.end.time);
      const bus = busOf.get(h);
      if (!tripsByBus.has(bus)) tripsByBus.set(bus, []);
      tripsByBus.get(bus).push({ route, from, to });
      for (let hr = Math.floor(from / 3600); hr * 3600 < Math.max(to, from + 1); hr++) {
        ((busesByHour[route] ??= {})[hr] ??= new Set()).add(busOf.get(h));
      }
      if (prevRoute === null && h.startType !== "pullout" && !isTerminalRelief(h)) { prevRoute = t.route ?? "unknown"; sawDeadhead = false; continue; }
      const how = prevRoute === null ? (h.startType === "pullout" ? "pullout" : "turnAround")
        : prevRoute !== route ? "fromOtherRoute"
        : sawDeadhead ? "deadheadSameRoute" : "turnAround";
      starts[route] ??= { pullout: 0, deadheadSameRoute: 0, fromOtherRoute: 0, turnAround: 0 };
      starts[route][how]++;
      startOf.set(t, how);
      if (how === "fromOtherRoute") fromRouteOf.set(t, prevRoute);
      prevRoute = route; sawDeadhead = false;
    }
  }
  const directionsByRoute = {};
  for (const [route, list] of Object.entries(tripsByRoute)) {
    for (const item of list) { item.start = startOf.get(item.source); item.fromRoute = fromRouteOf.get(item.source); }
    directionsByRoute[route] = routeDirections(list);
  }
  const pct = (n, total) => Math.round((1000 * n) / total) / 10;
  const tripStartsByRoute = {};
  for (const [route, c] of Object.entries(starts)) {
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    tripStartsByRoute[route] = { trips: total };
    for (const [k, n] of Object.entries(c)) tripStartsByRoute[route][k] = { count: n, percent: pct(n, total) };
  }
  const busesInServiceByRouteByHour = {};
  for (const [route, hours] of Object.entries(busesByHour)) {
    busesInServiceByRouteByHour[route] = {};
    for (const hr of Object.keys(hours).map(Number).sort((a, b) => a - b)) {
      busesInServiceByRouteByHour[route][`${String(hr).padStart(2, "0")}:00`] = hours[hr].size;
    }
  }
  const peakBusesByRouteByHour = peakBusesAtOnce(tripsByBus);

  const routeOrder = (a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0) || a.localeCompare(b);
  const type = (t) => runs.filter((r) => String(r.dutyType).toUpperCase() === t).length;
  return {
    inServiceTrips,
    inServiceTripsByRoute: Object.fromEntries(Object.keys(byRoute).sort(routeOrder).map((k) => [k, byRoute[k]])),
    pullouts,
    swings: runs.filter((r) => r.isSwing).length,
    blocks: type("BLOCK"),
    pto: type("PTO"),
    tripStartsByRoute: Object.fromEntries(Object.keys(tripStartsByRoute).sort(routeOrder).map((k) => [k, tripStartsByRoute[k]])),
    busesInServiceByRouteByHour: Object.fromEntries(Object.keys(busesInServiceByRouteByHour).sort(routeOrder)
      .map((k) => [k, busesInServiceByRouteByHour[k]])),
    peakBusesByRouteByHour: Object.fromEntries(Object.keys(peakBusesByRouteByHour).sort(routeOrder)
      .map((k) => [k, peakBusesByRouteByHour[k]])),
    directionsByRoute: Object.fromEntries(Object.keys(directionsByRoute).sort(routeOrder).map((k) => [k, directionsByRoute[k]])),
  };
}

/**
 * The most buses on each route at the same moment, for each hour.
 * A bus is on a route from the start of an in-service trip to the end of its last trip in a row on
 * that route, so layovers (and deadheads) between back-to-back trips on the same route count; the
 * stretch ends when the bus's next in-service trip is on another route, or it has no more trips.
 * @param {Map<any, {route: string, from: number, to: number}[]>} tripsByBus  seconds after midnight
 * @returns {{ [route]: { "HH:00": number } }}
 */
export function peakBusesAtOnce(tripsByBus) {
  const stretches = {}; // route -> [[start, end)]
  for (const trips of tripsByBus.values()) {
    const sorted = [...trips].sort((a, b) => a.from - b.from);
    let cur = null;
    for (const t of sorted) {
      if (cur && cur.route === t.route) { cur.end = Math.max(cur.end, t.to); continue; }
      if (cur) (stretches[cur.route] ??= []).push([cur.start, cur.end]);
      cur = { route: t.route, start: t.from, end: t.to };
    }
    if (cur) (stretches[cur.route] ??= []).push([cur.start, cur.end]);
  }
  const out = {};
  for (const [route, list] of Object.entries(stretches)) {
    const hours = new Set();
    for (const [s, e] of list) for (let hr = Math.floor(s / 3600); hr * 3600 < Math.max(e, s + 1); hr++) hours.add(hr);
    out[route] = {};
    for (const hr of [...hours].sort((a, b) => a - b)) {
      const h0 = hr * 3600, h1 = h0 + 3600;
      // the count only goes up when a stretch starts, so check the top of the hour and every start in it
      const moments = [h0, ...list.map(([s]) => s).filter((s) => s > h0 && s < h1)];
      let peak = 0;
      for (const m of moments) {
        let n = 0;
        for (const [s, e] of list) if (s <= m && m < e) n++;
        peak = Math.max(peak, n);
      }
      out[route][`${String(hr).padStart(2, "0")}:00`] = peak;
    }
  }
  return out;
}

/**
 * Which bus each half is driven on. A half is one stretch on one bus (pullout or relief, to relief
 * or pull-in), so halves joined by a relief share a bus: a half that starts by relieving run X
 * ("R P903" / "RN P206") is matched to X's half that ends with a relief by this run, within two
 * minutes of the same time (with the same day and overlapping operating days). A relief whose other
 * run isn't among these runs (e.g. another garage's) or doesn't match leaves that half on its own bus.
 * @returns {Map<Object, number>} half object -> bus id
 */
export function busesFromReliefs(runs) {
  const halves = [], parent = [], index = new Map();
  for (const r of runs) for (const h of r.halves) { index.set(h, halves.length); parent.push(halves.length); halves.push({ r, h }); }
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const byNumber = new Map();
  for (const r of runs) { if (!byNumber.has(r.number)) byNumber.set(r.number, []); byNumber.get(r.number).push(r); }
  const sameService = (a, b) => a.day === b.day
    && (!a.operatingDays || !b.operatingDays || a.operatingDays.some((d) => b.operatingDays.includes(d)));
  // the relieved run's half that ends with a relief by `by`, closest to `time` (within 2 minutes)
  const match = (candidates, by, time, side) => {
    let best = null;
    for (const o of candidates) for (const oh of o.halves) {
      const rel = side === "end" ? oh.relief : oh.startRelief;
      if (!rel || rel.otherRun !== by.number || !sameService(o, by)) continue;
      const gap = Math.abs(timeToSeconds(rel.time) - timeToSeconds(time));
      if (gap <= 120 && (!best || gap < best.gap)) best = { gap, h: oh };
    }
    return best?.h ?? null;
  };
  for (const { r, h } of halves) {
    // starts by relieving another run: find that run's half ending with a relief by this run
    if (h.startRelief?.otherRun) {
      const other = match(byNumber.get(h.startRelief.otherRun) ?? [], r, h.startRelief.time, "end");
      if (other) union(index.get(h), index.get(other));
    }
    // ends by being relieved: find the relieving run's half that starts by relieving this run
    if (h.relief?.otherRun) {
      const other = match(byNumber.get(h.relief.otherRun) ?? [], r, h.relief.time, "start");
      if (other) union(index.get(h), index.get(other));
    }
  }
  return new Map(halves.map(({ h }, i) => [h, find(i)]));
}

/**
 * One route's service in each direction, keyed by the terminal it runs from:
 *   { "<terminal>": { toward, trips, firstTrip: { time, run, from }, lastTrip: { ... }, averageFrequency,
 *                     departures: [{ time, run, start, fromRoute }, ...] (every trip that way, in time order;
 *                     start = how the trip starts, as in tripStartsByRoute, when known;
 *                     fromRoute = the route the bus was on before, for a fromOtherRoute start;
 *                     short = 1 when the trip starts or ends short of a terminal) } }
 * The terminals are the route's two most common trip start points among places that are really ends
 * of the line: a place that other trips pass through (a time point in the middle of at least 20% as
 * many trips as start or end there) is a short-line point, not a terminal. So a busy short line
 * (e.g. 28s to 47th & Lake Park, which full trips pass through) doesn't push out the real end of the
 * line (Union Station). Each trip goes in the direction
 * it travels: starts at a terminal → away from it; otherwise ends at a terminal → toward it;
 * otherwise (short turn to short turn) whichever terminal it moves closer to, by coordinates.
 * firstTrip / lastTrip .from is where that trip actually starts (a pullout or short turn may start
 * short of the terminal). averageFrequency is minutes between departures, first to last:
 * (last − first) ÷ (trips − 1), or null with fewer than two trips.
 * @param {{ trip: Object, run: string }[]} list  the route's counted in-service trips
 */
export function routeDirections(list) {
  const starts = {};
  for (const { trip: t } of list) starts[t.begin.location] = (starts[t.begin.location] ?? 0) + 1;
  const byStarts = (a, b) => (starts[b] ?? 0) - (starts[a] ?? 0) || a.localeCompare(b);
  // how often each place is a trip's end, and how often trips pass through it
  const ends = {}, middle = {};
  for (const { trip: t } of list) {
    for (const p of [t.begin, t.end]) ends[p.location] = (ends[p.location] ?? 0) + 1;
    for (const p of t.stops ?? []) middle[p.location] = (middle[p.location] ?? 0) + 1;
  }
  const isEnd = (loc) => (middle[loc] ?? 0) < 0.2 * (ends[loc] ?? 0);
  let terminals = Object.keys(starts).filter(isEnd).sort(byStarts).slice(0, 2);
  if (terminals.length < 2) terminals = Object.keys(starts).sort(byStarts).slice(0, 2); // fallback
  const [A, B] = terminals;
  const coords = {};
  for (const { trip: t } of list) for (const p of [t.begin, t.end]) {
    if (typeof p.lat === "number" && typeof p.lon === "number") coords[p.location] ??= p;
  }
  const dist = (p, name) => {
    const q = coords[name];
    return q && typeof p.lat === "number" ? Math.hypot(p.lat - q.lat, (p.lon - q.lon) * Math.cos((q.lat * Math.PI) / 180)) : null;
  };
  const fromOf = (t) => {
    if (B === undefined) return A; // only one start point (e.g. a loop)
    if (t.begin.location === A) return A;
    if (t.begin.location === B) return B;
    if (t.end.location === B) return A;
    if (t.end.location === A) return B;
    const b0 = dist(t.begin, B), b1 = dist(t.end, B);
    if (b0 === null || b1 === null || b0 === b1) return null;
    return b1 < b0 ? A : B;
  };
  const groups = Object.fromEntries(terminals.map((x) => [x, []]));
  for (const item of list) {
    const from = fromOf(item.trip);
    if (from !== null) groups[from].push(item);
  }
  const out = {};
  for (const from of terminals) {
    const g = groups[from].sort((x, y) => timeToSeconds(x.trip.begin.time) - timeToSeconds(y.trip.begin.time));
    if (!g.length) continue;
    const describe = ({ trip: t, run }) => ({ time: t.begin.time, run, from: t.begin.location });
    const first = g[0], last = g[g.length - 1];
    const commonEnd = (pick) => {
      const c = {};
      for (const { trip: t } of g) { const loc = pick(t).location; if (isEnd(loc)) c[loc] = (c[loc] ?? 0) + 1; }
      return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
    };
    const fullStarts = new Set([from, commonEnd((t) => t.begin)]);
    const fullEnds = new Set([terminals.find((x) => x !== from) ?? from, commonEnd((t) => t.end)]);
    const span =(timeToSeconds(last.trip.begin.time) - timeToSeconds(first.trip.begin.time)) / 60;
    out[from] = {
      toward: terminals.find((x) => x !== from) ?? from,
      trips: g.length,
      firstTrip: describe(first),
      lastTrip: describe(last),
      averageFrequency: g.length > 1 ? Math.round((10 * span) / (g.length - 1)) / 10 : null,
      // short: starts or ends short of the line's ends (a short line / short turn). A trip's full ends are
      // the terminals, plus this direction's own most common start and end when those are real ends of
      // the line (not stops other trips pass through) — so a one-way downtown loop like the 134's, whose
      // inbound trips end at Adams & Wacker but outbound ones start at Jackson & Franklin, isn't short.
      departures: g.map(({ trip: t, run, start, fromRoute, relievedMidRoute }) => {
        const toward = terminals.find((x) => x !== from) ?? from;
        const short = !fullStarts.has(t.begin.location) || (!relievedMidRoute && !fullEnds.has(t.end.location));
        return { time: t.begin.time, run, ...(start ? { start } : {}), ...(fromRoute ? { fromRoute } : {}), ...(short ? { short: 1 } : {}) };
      }),
    };
  }
  return out;
}
