// Run with:  npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDuration, parseTime, timeToMinutes, minutesToTime,
  parseNeighbor, parseHeadway, parseRelief, durationToMinutes, run, sundayPay, half, trip, point, operatingDays, garageOf, durationsAsText, resolveMidRunChanges, runStatistics, routeDirections, peakBusesAtOnce,
} from "../run.js";
import { parsePaddlePage } from "../paddle-parser.js";
import { exampleP001 } from "../example-p001.js";

test("durations", () => {
  assert.deepEqual(parseDuration("8h12"), { hours: 8, minutes: 12 });
  assert.deepEqual(parseDuration("10h19"), { hours: 10, minutes: 19 });
  assert.deepEqual(parseDuration(""), { hours: 0, minutes: 0 });
  assert.throws(() => parseDuration("8.12"));
});

test("times", () => {
  assert.equal(parseTime("06:16+"), "06:16:30");
  assert.equal(parseTime("6:05"), "06:05:00");
  assert.equal(parseTime("06:16:30"), "06:16:30");
  assert.equal(minutesToTime(timeToMinutes("24:59:00") + 2), "25:01:00");
});

test("leader / follower", () => {
  assert.equal(parseNeighbor(""), null);
  assert.deepEqual(parseNeighbor("006*"), { run: "006", changesMidRun: true });
});

test("headway", () => {
  assert.deepEqual(parseHeadway("17+/16+"), { headwayAhead: 17, headwayBehind: 16 });
  assert.deepEqual(parseHeadway("fst/20"), { headwayAhead: null, headwayBehind: 20 });
  assert.deepEqual(parseHeadway("19/lst"), { headwayAhead: 19, headwayBehind: null });
  assert.deepEqual(parseHeadway("/"), { headwayAhead: null, headwayBehind: null });
});

test("relief", () => {
  assert.deepEqual(parseRelief("RN P008", "09:06+", "DAVIS PURPL L"),
    { time: "09:06:30", direction: "Northbound", otherRun: "P008", headedTo: "DAVIS PURPL L" });
  assert.equal(parseRelief("R P048", "13:57+", "").direction, "Terminal");
});

test("example run P001 adds up", () => {
  const p = exampleP001.pay;
  const sum = durationToMinutes(p.firstHalf) + durationToMinutes(p.secondHalf) + durationToMinutes(p.allowance);
  assert.equal(sum, durationToMinutes(p.total));
});

// A tiny fake page: one half, pullout -> one trip -> pull-in, crossing midnight.
function fakePage(lines = []) {
  const B = "bold", R = "regular";
  const it = (text, x, y, fontName = R) => ({ text, x, y, width: 10, fontName });
  const page = {
    page: 1, width: 612, height: 792,
    items: [
      it("P999", 4, 30, B), it("Saturday", 4, 41), it("Effective: 08/29/2026", 502, 19, B),
      it("Pay:", 55, 52), it("Plat", 312, 41),
      it("2h00", 50, 73), it("23:30", 95, 73), it("2h00", 180, 73), it("0h00", 218, 73), it("0h00", 260, 73),
      it("2h00", 315, 73), it("23:30", 346, 73), it("23:45", 388, 73), it("01:45", 422, 73), it("01:45", 456, 73),
      it("PULLOUT", 4, 106), it("23:45", 105, 106),
      it("N PARK GARAGE_____", 4, 128, B), it("23:45", 105, 128),
      it("FOSTER CLARK_____", 4, 139, B), it("23:55", 105, 139),
      it("TO RTE:", 4, 161), it("22", 52, 161),
      it("L:001", 4, 172), it("F:002", 38, 172), it("HDW: 10/10", 72, 172),
      it("FOSTER CLARK_____", 4, 183, B), it("00:05", 105, 183),
      it("DEVON CLARK_____", 4, 194), it("00:20", 105, 194), it("E", 139, 194),
      it("HOWARD L_____", 4, 205, B), it("01:35", 105, 205),
      it("b", 131, 227),
      it("HOWARD L_____", 4, 238, B), it("01:35", 105, 238),
      it("N PARK GARAGE_____", 4, 249, B), it("01:45", 105, 249),
      it("PULLIN", 4, 271), it("01:45", 105, 271),
      it("THRU WORK 01:45", 470, 300),
      it("Notes: E", 15, 600), it("-", 50, 600), it("BUS MAY OPERATE EARLY AT TIMEPOINT INDICATED", 60, 600),
      it("b", 50, 611), it("-", 55, 611), it("VIA HOWARD - CLARK", 60, 611),
      it("Subject to revision by street supervisory force", 200, 700),
    ],
    lines,
  };
  return page;
}

test("parser reads a page and continues times past midnight", () => {
  const { run, problems } = parsePaddlePage(fakePage());
  assert.deepEqual(problems, []);
  assert.equal(run.number, "P999");
  assert.equal(run.halves.length, 1);
  const h = run.halves[0];
  assert.equal(h.startType, "pullout");
  assert.equal(h.endType, "pullin");
  assert.equal(h.end.time, "25:45:00");
  assert.equal(h.trips.length, 3);
  assert.equal(h.trips[1].inService, true);
  assert.equal(h.trips[1].route, "22");
  assert.equal(h.trips[1].begin.time, "24:05:00");
  assert.deepEqual(h.trips[1].stops[0].notes, ["E"]);
  assert.deepEqual(h.trips[2].notes, ["b"]);
  assert.equal(run.notes.b, "VIA HOWARD - CLARK");
});

test("Sunday pay rule", () => {
  assert.deepEqual(sundayPay("Sunday", ""), { hours: 0, minutes: 30 });
  assert.deepEqual(sundayPay("Sunday", "BLOCK"), { hours: 0, minutes: 30 });
  assert.deepEqual(sundayPay("Sunday", "SPLIT"), { hours: 0, minutes: 0 });
  assert.deepEqual(sundayPay("Saturday", ""), { hours: 0, minutes: 0 });
  assert.deepEqual(run("P1", "Sunday", { total: "8h00" }).pay.sunday, { hours: 0, minutes: 30 });
  assert.deepEqual(run("P1", "Sunday", { total: "8h00" }, [], { dutyType: "OTHER" }).pay.sunday, { hours: 0, minutes: 0 });
  assert.deepEqual(run("P1", "Weekday", { total: "8h00" }).pay.sunday, { hours: 0, minutes: 0 });
});

test("pay is calculated, not taken from the paddle", () => {
  const r = run("P238", "Sunday",
    { total: "9h45", firstHalf: "3h43", secondHalf: "4h10", allowance: "0h52", spread: "0h00" });
  assert.deepEqual(r.printedPay, { hours: 9, minutes: 45 });
  assert.deepEqual(r.pay.sunday, { hours: 0, minutes: 30 });
  assert.deepEqual(r.pay.total, { hours: 9, minutes: 15 }); // 3h43 + 4h10 + 0h52 + 0h00 + 0h30
  const sat = run("P001", "Saturday", { total: "8h12", firstHalf: "2h51", secondHalf: "4h56", allowance: "0h25" });
  assert.deepEqual(sat.pay.total, { hours: 8, minutes: 12 });
});

test("fallback (X) runs get no Sunday pay, even if BLOCK or blank", () => {
  assert.deepEqual(sundayPay("Sunday", "", true), { hours: 0, minutes: 0 });
  assert.deepEqual(sundayPay("Sunday", "BLOCK", true), { hours: 0, minutes: 0 });
  const layover = trip({ inService: false }, [["HOWARD L", "19:57"], ["HOWARD L", "19:57", ["X"]]]);
  const h = half(point("14:35", "N PARK GARAGE"), [layover], point("23:22", "N PARK GARAGE"));
  const r = run("P228", "Sunday", { firstHalf: "8h32", allowance: "0h15" }, [h], { notes: { X: "FALLBACK" } });
  assert.deepEqual(r.pay.sunday, { hours: 0, minutes: 0 });
  assert.deepEqual(r.pay.total, { hours: 8, minutes: 47 });
});

test("day tags", () => {
  assert.deepEqual(operatingDays("Weekday", ""), ["Mon", "Tue", "Wed", "Thu", "Fri"]);
  assert.deepEqual(operatingDays("Weekday", "Wed Only"), ["Wed"]);
  assert.deepEqual(operatingDays("Weekday", "Mon Only"), ["Mon"]);
  assert.deepEqual(operatingDays("Weekday", "M-U-T-F"), ["Mon", "Tue", "Thu", "Fri"]);
  assert.deepEqual(operatingDays("Weekday", "U-W-T"), ["Tue", "Wed", "Thu"]);
  assert.deepEqual(operatingDays("Saturday", ""), ["Sat"]);
  assert.throws(() => operatingDays("Weekday", "Holidays"));
});

test("garage from run number", () => {
  assert.equal(garageOf("P001"), "North Park");
  assert.equal(garageOf("K123"), "Kedzie");
  assert.equal(garageOf("5123"), "Chicago");
  assert.equal(garageOf("1123"), "103rd");
  assert.equal(garageOf("6123"), "74th");
  assert.equal(garageOf("7123"), "77th");
  assert.equal(garageOf("X123"), "");
  assert.equal(run("K045", "Weekday").garage, "Kedzie");
});

test("swing run = double line between the halves", () => {
  const single = [{ x0: 0, x1: 150, y: 290 }];
  const double = [{ x0: 0, x1: 150, y: 290 }, { x0: 0, x1: 150, y: 301 }];
  assert.equal(parsePaddlePage(fakePage(single)).run.isSwing, false);
  assert.equal(parsePaddlePage(fakePage(double)).run.isSwing, true);
  assert.equal(parsePaddlePage(fakePage()).run.isSwing, false);
  // split across columns: one line under the first half (column 1), one at the top of column 2
  const split = [{ x0: 0, x1: 150, y: 290 }, { x0: 152, x1: 302, y: 104 }];
  assert.equal(parsePaddlePage(fakePage(split)).run.isSwing, true);
  // a line at the top of column 2 alone is not a swing
  assert.equal(parsePaddlePage(fakePage([{ x0: 152, x1: 302, y: 104 }])).run.isSwing, false);
});

test("a relief with no run number is read and flagged", () => {
  const page = fakePage();
  const i = page.items.findIndex((x) => x.text === "PULLOUT");
  page.items[i] = { ...page.items[i], text: "R" };
  const result = parsePaddlePage(page);
  assert.equal(result.unnamedRelief, true);
  assert.equal(result.run.halves[0].startRelief.otherRun, "");
  assert.equal(result.run.halves[0].startRelief.direction, "Terminal");
  assert.ok(result.problems.some((p) => /no run number/.test(p)));
});

test("thru work time = Half End - Plat End", () => {
  const h = half(point("06:01", "GARAGE"), [], point("09:07", "FOSTER ALBANY"), null, { start: "06:16", end: "09:06+" });
  assert.deepEqual(h.thruWorkTime, { hours: 0, minutes: 0, seconds: 30 }); // 09:06:30 -> 09:07:00
  assert.deepEqual(exampleP001.halves[1].thruWorkTime, { hours: 0, minutes: 0, seconds: 30 }); // 15:20:30 -> 15:21:00
});

test("plat time splits into in service + out of service + recovery", () => {
  // P001 Saturday, first half: Plat Start 06:16:30, Plat End 09:06:30 -> exactly 2h50m00s
  // (the printed Plat Time, 2h51, rounds the start down and the end up)
  const h = exampleP001.halves[0];
  const sec = (d) => (d.hours * 60 + d.minutes) * 60 + d.seconds;
  assert.equal(sec(h.inServiceTravel) + sec(h.outOfServiceTravel) + sec(h.recoveryTime), (2 * 60 + 50) * 60);
  // a relief-to-relief half: wait after taking the bus and before handing it over count as recovery
  const trips = [trip({}, [["A", "10:05"], ["B", "10:35+"]]), trip({ inService: false }, [["B", "10:40"], ["C", "10:50"]])];
  const r = half(point("10:00", "A"), trips, point("11:00", "C"), parseRelief("RN P1", "10:55", ""), {}, { startRelief: parseRelief("RS P2", "10:00", "") });
  assert.deepEqual(r.inServiceTravel, { hours: 0, minutes: 30, seconds: 30 });
  assert.deepEqual(r.outOfServiceTravel, { hours: 0, minutes: 10, seconds: 0 });
  assert.deepEqual(r.recoveryTime, { hours: 0, minutes: 14, seconds: 30 }); // 5 + 4.5 + 5
});

test("blank Duty Type is stored as Regular", () => {
  assert.equal(run("P1", "Weekday").dutyType, "Regular");
  assert.equal(run("P1", "Weekday", {}, [], { dutyType: "Block" }).dutyType, "Block");
  assert.deepEqual(sundayPay("Sunday", "Regular"), { hours: 0, minutes: 30 });
  assert.deepEqual(run("P1", "Sunday", { firstHalf: "8h00" }).pay.sunday, { hours: 0, minutes: 30 });
});

test("durations written as H:MM:SS", () => {
  const r = durationsAsText(structuredClone(exampleP001));
  assert.equal(r.pay.total, "8:12:00");
  assert.equal(r.halves[0].recoveryTime, "0:37:00");
  assert.equal(r.halves[0].thruWorkTime, "0:00:30");
  assert.equal(r.halves[0].trips[1].begin.time, "06:16:30"); // clock times are untouched
});

test("a leader marked * points to the run that takes it over", () => {
  // P001 follows run 006, which P002 relieves at 12:24 during P001's 12:05-13:09 trip
  const mine = run("P001", "Saturday", {}, [half(point("10:15", "X"),
    [trip({ leader: "006*" }, [["DAVIS PURPL L", "12:05"], ["LOGAN SQ L", "13:09"]])], point("15:21", "X"))]);
  const p006 = run("P006", "Saturday", {}, [half(point("07:45", "X"),
    [trip({}, [["A", "08:00"], ["LOGAN SQ L", "12:24"]])], point("12:24", "X"), parseRelief("RS P002", "12:24", "LOGAN SQ L"))]);
  const problems = resolveMidRunChanges([mine, p006]);
  assert.deepEqual(problems, []);
  assert.equal(mine.halves[0].trips[0].leader.changesMidRun, "P002");
});

test("a * leader that isn't one of our runs on that route is marked error", () => {
  const mine = run("P042", "Weekday", {}, [half(point("05:00", "X"),
    [trip({ leader: "701*", route: "49" }, [["BERWYN WESTRN", "05:22"], ["79th WESTERN", "06:34"]])], point("09:00", "X"))]);
  const p701 = run("P701", "Weekday", {}, [half(point("04:11", "X"),
    [trip({ route: "147" }, [["HOWARD L", "04:45"], ["CONGRES PLAZA", "05:28+"]])], point("09:15", "X"), parseRelief("R P757", "09:15", ""))]);
  resolveMidRunChanges([mine, p701]);
  assert.equal(mine.halves[0].trips[0].leader.changesMidRun, "error");
});

test("cumulative statistics", () => {
  const st = runStatistics([exampleP001]);
  assert.equal(st.inServiceTrips, 9);
  assert.deepEqual(st.inServiceTripsByRoute, { 93: 9 });
  assert.equal(st.pullouts, 2);
  assert.equal(st.swings, 0);
  assert.equal(st.blocks, 0);
  assert.equal(st.pto, 0);
});

test("trip starts and buses by hour, by route", () => {
  const st = runStatistics([exampleP001]);
  // P001 Saturday: half 1 = pullout, then 3 more 93 trips; half 2 = pullout, then 4 more 93 trips
  assert.equal(st.tripStartsByRoute["93"].trips, 9);
  assert.equal(st.tripStartsByRoute["93"].pullout.count, 2);
  assert.equal(st.tripStartsByRoute["93"].turnAround.count, 7);
  assert.equal(st.tripStartsByRoute["93"].pullout.percent, 22.2);
  assert.equal(st.busesInServiceByRouteByHour["93"]["06:00"], 1);
  assert.equal(st.busesInServiceByRouteByHour["93"]["10:00"], 1);
  assert.equal(st.busesInServiceByRouteByHour["93"]["09:00"], 1); // trip ending 09:06
});

test("a trip that starts with a directional relief (RN) is left out of trip totals but counts as a bus in service", () => {
  const takeover = half(point("13:20", "X"),
    [trip({ route: "22" }, [["FOSTER CLARK", "13:29"], ["HOWARD L", "13:56"]]),
     trip({ route: "22" }, [["HOWARD L", "14:10"], ["HARISON CLARK", "15:38"]])],
    point("15:40", "X"), null, {}, { startType: "relief", startRelief: parseRelief("RN P206", "13:29", "") });
  const st = runStatistics([run("P214", "Weekday", {}, [takeover])]);
  assert.equal(st.inServiceTrips, 1);
  assert.deepEqual(st.inServiceTripsByRoute, { 22: 1 });
  assert.equal(st.tripStartsByRoute["22"].trips, 1);
  assert.equal(st.tripStartsByRoute["22"].turnAround.count, 1);
  assert.equal("terminalRelief" in st.tripStartsByRoute["22"], false);
  assert.equal(st.busesInServiceByRouteByHour["22"]["13:00"], 1); // the bus is still in service
});

test("a bus handed over by relief counts as one bus in service", () => {
  // P903 pulls out, runs 10:15-10:53, and is relieved at Howard at 11:06 by P912, who runs 11:10-11:48.
  // P904 is a separate bus in service in hour 11.
  const p903 = half(point("10:00", "GARAGE"),
    [trip({ route: "201" }, [["OLD ORCHARD", "10:15"], ["HOWARD L", "11:05"]])],
    point("11:06", "HOWARD L"), parseRelief("R P912", "11:06", ""));
  const p912 = half(point("11:06", "HOWARD L"),
    [trip({ route: "201" }, [["HOWARD L", "11:10"], ["OLD ORCHARD", "11:48"]])],
    point("11:50", "GARAGE"), null, {}, { startType: "relief", startRelief: parseRelief("R P903", "11:06", "") });
  const p904 = half(point("11:00", "GARAGE"),
    [trip({ route: "201" }, [["OLD ORCHARD", "11:15"], ["HOWARD L", "11:53"]])], point("12:00", "GARAGE"));
  const runs = [run("P903", "Saturday", {}, [p903]), run("P912", "Saturday", {}, [p912]), run("P904", "Saturday", {}, [p904])];
  const st = runStatistics(runs);
  assert.equal(st.busesInServiceByRouteByHour["201"]["11:00"], 2); // 3 runs, 2 buses
  assert.equal(st.busesInServiceByRouteByHour["201"]["10:00"], 1);
});

test("peak buses at once: a bus leaving and another arriving in the same hour don't overlap", () => {
  const m = (hhmm) => { const [h, mm] = hhmm.split(":").map(Number); return h * 3600 + mm * 60; };
  const buses = new Map([
    // bus 1: two 155 trips with a layover between them (counts through the layover), done at 15:10
    [1, [{ route: "155", from: m("14:00"), to: m("14:40") }, { route: "155", from: m("14:50"), to: m("15:10") }]],
    // bus 2: pulls out at 15:30, after bus 1 is gone
    [2, [{ route: "155", from: m("15:30"), to: m("16:10") }]],
    // bus 3: on the 155 all afternoon, with a trip on the 201 in between
    [3, [{ route: "155", from: m("14:05"), to: m("14:45") }, { route: "201", from: m("15:00"), to: m("15:40") },
         { route: "155", from: m("15:50"), to: m("16:30") }]],
  ]);
  const p = peakBusesAtOnce(buses);
  assert.deepEqual(p["155"], { "14:00": 2, "15:00": 2, "16:00": 2 }); // 15:00: bus 1 then bus 2 and 3 — never 3 at once
  assert.deepEqual(p["201"], { "15:00": 1 });
});

test("peak buses in runStatistics follows the bus through a relief", () => {
  const p903 = half(point("10:00", "GARAGE"),
    [trip({ route: "201" }, [["OLD ORCHARD", "10:15"], ["HOWARD L", "11:05"]])],
    point("11:06", "HOWARD L"), parseRelief("R P912", "11:06", ""));
  const p912 = half(point("11:06", "HOWARD L"),
    [trip({ route: "201" }, [["HOWARD L", "11:10"], ["OLD ORCHARD", "11:48"]])],
    point("11:50", "GARAGE"), null, {}, { startType: "relief", startRelief: parseRelief("R P903", "11:06", "") });
  const st = runStatistics([run("P903", "Saturday", {}, [p903]), run("P912", "Saturday", {}, [p912])]);
  assert.deepEqual(st.peakBusesByRouteByHour["201"], { "10:00": 1, "11:00": 1 });
});

test("a relief by a run that isn't in these paddles leaves the bus on its own", () => {
  const h1 = half(point("11:06", "HOWARD L"),
    [trip({ route: "201" }, [["HOWARD L", "11:10"], ["OLD ORCHARD", "11:48"]])],
    point("11:50", "GARAGE"), null, {}, { startType: "relief", startRelief: parseRelief("R K100", "11:06", "") });
  const h2 = half(point("11:00", "GARAGE"),
    [trip({ route: "201" }, [["OLD ORCHARD", "11:15"], ["HOWARD L", "11:53"]])], point("12:00", "GARAGE"));
  const st = runStatistics([run("P912", "Saturday", {}, [h1]), run("P904", "Saturday", {}, [h2])]);
  assert.equal(st.busesInServiceByRouteByHour["201"]["11:00"], 2);
});

test("first trip, last trip and average frequency from each terminal", () => {
  const at = (name, lat) => ({ location: name, lat, lon: -87.68 });
  const t = (time, from, to) => ({ trip: { inService: true, route: "201", begin: { ...from, time }, end: { ...to, time } }, run: "P9" + time.slice(0, 2) });
  const OO = at("OLD ORCHARD", 42.06), HOW = at("HOWARD", 42.02), MID = at("MID", 42.04), MID2 = at("MID2", 42.03);
  const d = routeDirections([
    t("09:10:00", HOW, OO), t("09:30:00", HOW, OO), t("09:50:00", HOW, OO),
    t("08:55:00", OO, HOW), t("09:15:00", OO, HOW), t("09:35:00", OO, HOW),
    t("08:40:00", MID, HOW),   // pullout starting mid-route, ends at Howard → from Old Orchard
    t("10:00:00", HOW, MID),   // short turn from Howard
    t("10:20:00", MID, MID2),  // short turn to short turn, moving toward Howard → from Old Orchard
  ]);
  assert.deepEqual(Object.keys(d), ["HOWARD", "OLD ORCHARD"]); // the two most common start points: Howard 4, Old Orchard 3
  assert.equal(d.HOWARD.toward, "OLD ORCHARD");
  assert.equal(d.HOWARD.trips, 4);
  assert.deepEqual(d.HOWARD.firstTrip, { time: "09:10:00", run: "P909", from: "HOWARD" });
  assert.deepEqual(d.HOWARD.lastTrip, { time: "10:00:00", run: "P910", from: "HOWARD" });
  assert.equal(d.HOWARD.averageFrequency, 16.7); // 50 min ÷ 3
  assert.deepEqual(d.HOWARD.departures.map((x) => x.time), ["09:10:00", "09:30:00", "09:50:00", "10:00:00"]);
  assert.equal(d.HOWARD.departures[0].run, "P909");
  assert.equal(d["OLD ORCHARD"].trips, 5);
  assert.deepEqual(d["OLD ORCHARD"].firstTrip, { time: "08:40:00", run: "P908", from: "MID" });
  assert.equal(d["OLD ORCHARD"].lastTrip.time, "10:20:00");
  assert.equal(d["OLD ORCHARD"].averageFrequency, 25); // 100 min ÷ 4
});

test("terminals are the ends of the longest regular pattern, not the busiest short line", () => {
  // like the 28: many short trips Olive-Harvey <-> 47th & Lake Park, fewer full trips to Union Station
  const P = (name, lat) => ({ location: name, lat, lon: -87.58 });
  const OH = P("OLIVE HARVEY", 41.70), S95 = P("95 STONY", 41.72), S63 = P("63 STONY", 41.78),
    L47 = P("47 LAKE PARK", 41.81), MID = P("11th COLUMBUS", 41.87), US = P("UNION STATION", 41.88);
  const t = (time, pts) => ({ trip: { inService: true, route: "28", begin: { ...pts[0], time },
    stops: pts.slice(1, -1).map((p) => ({ ...p, time })), end: { ...pts.at(-1), time } }, run: "1801" });
  const list = [];
  for (let i = 0; i < 10; i++) list.push(t(`0${i % 10}:00:00`, [L47, S63, S95, OH]), t(`0${i % 10}:30:00`, [OH, S95, S63, L47]));
  for (let i = 0; i < 4; i++) list.push(t(`1${i}:00:00`, [US, MID, L47, S63, S95, OH]), t(`1${i}:30:00`, [OH, S95, S63, L47, MID, US]));
  const d = routeDirections(list);
  assert.deepEqual(Object.keys(d).sort(), ["OLIVE HARVEY", "UNION STATION"]);
  assert.equal(d["OLIVE HARVEY"].trips + d["UNION STATION"].trips, 28); // every trip still in a direction
  assert.equal(d["UNION STATION"].trips, 14); // 10 from 47th (short of Union Station) + 4 full
});

test("directionsByRoute uses the same trips as the totals", () => {
  const out = half(point("08:50", "X"), [
    trip({ route: "201" }, [["OLD ORCHARD", "08:55"], ["HOWARD L", "09:31"]]),
    trip({ route: "201" }, [["HOWARD L", "09:50"], ["OLD ORCHARD", "10:28"]])], point("10:30", "X"));
  const st = runStatistics([run("P906", "Saturday", {}, [out])]);
  const d = st.directionsByRoute["201"];
  assert.equal(Object.values(d).reduce((a, x) => a + x.trips, 0), st.inServiceTripsByRoute["201"]);
  assert.equal(d["OLD ORCHARD"].toward, "HOWARD L");
  assert.equal(d["HOWARD L"].toward, "OLD ORCHARD");
  assert.equal(d["OLD ORCHARD"].averageFrequency, null); // one trip each way
});

test("a trip that starts with a plain R (terminal) relief counts in trip totals, as a turn around", () => {
  const takeover = half(point("11:06", "X"),
    [trip({ route: "201" }, [["HOWARD L", "11:10"], ["OLD ORCHARD", "11:48"]]),
     trip({ route: "201" }, [["OLD ORCHARD", "11:55"], ["HOWARD L", "12:33"]])],
    point("12:35", "X"), null, {}, { startType: "relief", startRelief: parseRelief("R P903", "11:06", "") });
  const st = runStatistics([run("P912", "Saturday", {}, [takeover])]);
  assert.equal(st.inServiceTrips, 2);
  assert.deepEqual(st.inServiceTripsByRoute, { 201: 2 });
  assert.equal(st.tripStartsByRoute["201"].trips, 2);
  // both trips are turn arounds: the one after the terminal relief and the one after that
  assert.equal(st.tripStartsByRoute["201"].turnAround.count, 2);
  // and each departure carries how it started
  assert.deepEqual(Object.values(st.directionsByRoute["201"]).flatMap((d) => d.departures.map((x) => x.start)), ["turnAround", "turnAround"]);
  assert.equal(st.tripStartsByRoute["201"].turnAround.percent, 100);
  assert.equal("terminalRelief" in st.tripStartsByRoute["201"], false);
  assert.equal(st.pullouts, 0);
  assert.equal(st.busesInServiceByRouteByHour["201"]["11:00"], 1);
});
