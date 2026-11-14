// Shared application state, data loading, time helpers, and display utilities.
"use strict";
const $ = (id) => document.getElementById(id);
const DAYS = ["Weekday", "Saturday", "Sunday"];
const GARAGE_ORDER = ["North Park", "Kedzie", "Forest Glen", "Chicago", "74th", "77th", "103rd"];
const garageColor = (g) => { const i = GARAGE_ORDER.indexOf(g); return i === -1 ? "var(--muted)" : `var(--g${i + 1})`; };
const state = {
  day: "Weekday", garage: "All", route: null, compare: null, // compare = the second route when comparing
  sort: "route", clock: "24", view: "chart", zoom: 1, period: "all",
  days: [], summary: null, rows: [], routeData: null, model: null,
};
const cache = new Map();
async function getJSON(url) {
  if (cache.has(url)) return cache.get(url);
  const p = fetch(url).then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.error || r.statusText); return b; });
  cache.set(url, p);
  p.catch(() => cache.delete(url));
  return p;
}

// ---------- time ----------
const secs = (t) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
// Paddle style: 24-hour, counting past 24:00 after midnight; a half minute shows as "+".
function fmt(sec, { clock = state.clock, short = false } = {}) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), plus = sec % 60 >= 30 ? "+" : "";
  if (clock === "24") return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}${plus}`;
  const h24 = h % 24, ampm = h24 < 12 ? (short ? "a" : " AM") : (short ? "p" : " PM");
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(m).padStart(2, "0")}${plus}${ampm}`;
}
const nextDay = (sec) => sec >= 24 * 3600;
const fmtLong = (sec) => fmt(sec) + (state.clock === "12" && nextDay(sec) ? " (next day)" : "");
function fmtSpan(sec) { const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60); return `${h}h ${String(m).padStart(2, "0")}m`; }
function tickLabel(hr) {
  // the overnight view runs 23:00 → 06:00 on one axis, so its hours wrap at midnight
  if (state.clock === "24") return `${String(state.period === "overnight" ? hr % 24 : hr).padStart(2, "0")}:00`;
  const h24 = hr % 24; return `${h24 % 12 === 0 ? 12 : h24 % 12} ${h24 < 12 ? "AM" : "PM"}`;
}
// ---------- time periods (by departure time) ----------
// Weekdays have rush periods; weekends don't, so Saturday and Sunday use morning / afternoon instead.
// win = the hours each period covers on the chart; overnight runs 23:00 → 30:00 (6 AM), with early-morning
// trips (before 6 AM) drawn after midnight so the night is one stretch.
const WEEKDAY_PERIODS = [
  { key: "overnight", name: "Overnight", short: "Overnight", span: "11 PM–6 AM", win: [23, 30] },
  { key: "am", name: "Morning rush", short: "AM rush", span: "6–9 AM", win: [6, 9] },
  { key: "midday", name: "Midday", short: "Midday", span: "9 AM–3 PM", win: [9, 15] },
  { key: "pm", name: "Evening rush", short: "PM rush", span: "3–6:30 PM", win: [15, 18.5] },
  { key: "evening", name: "Evening", short: "Evening", span: "6:30–11 PM", win: [18.5, 23] },
];
const WEEKEND_PERIODS = [
  { key: "overnight", name: "Overnight", short: "Overnight", span: "11 PM–6 AM", win: [23, 30] },
  { key: "morning", name: "Morning", short: "Morning", span: "6 AM–12 PM", win: [6, 12] },
  { key: "afternoon", name: "Afternoon", short: "Afternoon", span: "12–6 PM", win: [12, 18] },
  { key: "evening", name: "Evening", short: "Evening", span: "6–11 PM", win: [18, 23] },
];
// switching day type keeps the nearest period
const PERIOD_SWAP = { am: "morning", midday: "afternoon", pm: "afternoon", morning: "am", afternoon: "pm" };
const PERIODS = [];
const WINDOW = {};
function usePeriods(day) {
  PERIODS.splice(0, PERIODS.length, ...(day === "Weekday" ? WEEKDAY_PERIODS : WEEKEND_PERIODS));
  for (const key of Object.keys(WINDOW)) delete WINDOW[key];
  Object.assign(WINDOW, Object.fromEntries(PERIODS.map((p) => [p.key, p.win])));
}
usePeriods("Weekday");
function periodOf(sec) {
  const h = (sec / 3600) % 24;
  if (h >= 23 || h < 6) return "overnight";
  return PERIODS.find((p) => p.key !== "overnight" && h >= p.win[0] && h < p.win[1]).key;
}
// ---------- the time-period filter ----------
const inPeriod = (sec) => state.period === "all" || periodOf(sec) === state.period;
const shiftOf = (sec) => (state.period === "overnight" && sec < 6 * 3600 ? 24 * 3600 : 0);
const pos = (sec) => sec + shiftOf(sec); // where a time goes on the chart (labels keep the paddle time)
// Every module's heading says what it shows, so a screenshot of one module stands on its own:
//   "CTA 50 - Average Headway By Hour - PM Rush (Weekday - North Park - 3PM-6:30PM)"
// = the route (on route pages), the module's name, the period, then in grey the day, garage (when one is
// picked) and the period's hours. Headings marked data-ctx get it; fillCtx runs after each render. The
// module's own name is kept in data-base (a heading whose text a renderer resets is read again).
const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const hours = (span) => span.replace(/ (AM|PM)/g, "$1").replace(/^(\d+(?::\d+)?)–(\d+(?::\d+)?)(AM|PM)$/, "$1$3–$2$3").replace("–", "-");
function ctxText() {
  const p = PERIODS.find((q) => q.key === state.period);
  return `(${[state.day, state.garage === "All" ? null : state.garage, p ? hours(p.span) : null].filter(Boolean).join(" - ")})`;
}
function fillCtx(root = document) {
  const p = PERIODS.find((q) => q.key === state.period), period = p ? titleCase(p.short) : "All Day", grey = ctxText();
  for (const el of root.querySelectorAll("[data-ctx]")) {
    if (!el.querySelector(":scope > .ctx-main")) el.dataset.base = el.textContent.trim();
    const route = el.closest("[data-route]")?.dataset.route ?? (el.closest("#routeView") ? state.route : null);
    const main = [route ? `CTA ${route}` : null, el.dataset.base || null, period].filter(Boolean).join(" - ");
    el.replaceChildren();
    const m = document.createElement("span"); m.className = "ctx-main"; m.textContent = main;
    const s = document.createElement("span"); s.className = "ctx"; s.textContent = grey;
    el.append(m, " ", s);
  }
}

const periodLabel = () => {
  if (state.period === "all") return "all day";
  const period = PERIODS.find((item) => item.key === state.period);
  return `${period.short} (${period.span})`;
};

// the summary rows, cut down to the departures in the chosen period (rows with none are left out)
let viewCache = { rows: null, period: null, out: null };
function viewRows() {
  if (state.period === "all") return state.rows;
  if (viewCache.rows === state.rows && viewCache.period === state.period) return viewCache.out;
  const out = [];
  for (const r of state.rows) {
    const deps = r.departures.filter((d) => inPeriod(d.sec)).sort((a, b) => pos(a.sec) - pos(b.sec));
    if (!deps.length) continue;
    const f = deps[0], l = deps[deps.length - 1];
    out.push({
      ...r, departures: deps, trips: deps.length,
      freq: periodStats(r.departures)[state.period].every, // gap from each departure in the period to the next
      first: f.sec, last: l.sec,
      firstTrip: { run: f.run, garage: f.garage, from: r.from },
      lastTrip: { run: l.run, garage: l.garage, from: r.from },
      garages: [...new Set(deps.map((d) => d.garage))].sort(garageSort),
    });
  }
  viewCache = { rows: state.rows, period: state.period, out };
  return out;
}
// chart time range: the period's hours, or the data's first to last departure
function timeRange(rows) {
  if (state.period !== "all") return WINDOW[state.period].map((h, i) => (i ? Math.ceil(h) : Math.floor(h)));
  return [Math.floor(Math.min(...rows.map((r) => r.first)) / 3600), Math.ceil(Math.max(...rows.map((r) => r.last)) / 3600)];
}
// per period: trips leaving then, first and last, and the average gap from each to the next departure
function periodStats(departures) {
  const deps = [...departures].sort((a, b) => a.sec - b.sec);
  const out = Object.fromEntries(PERIODS.map((p) => [p.key, { trips: 0, gaps: [], first: null, last: null }]));
  deps.forEach((d, i) => {
    const o = out[periodOf(d.sec)];
    o.trips++;
    if (o.first === null) o.first = d.sec;
    o.last = d.sec;
    if (i + 1 < deps.length) o.gaps.push(deps[i + 1].sec - d.sec);
  });
  for (const o of Object.values(out)) o.every = o.gaps.length ? Math.round((10 * o.gaps.reduce((a, b) => a + b, 0)) / o.gaps.length / 60) / 10 : null;
  return out;
}
function tickEvery(perHour) {
  const room = state.clock === "12" ? 50 : 44;
  return [1, 2, 3, 4, 6, 12].find((n) => n * perHour >= room) ?? 12;
}

// ---------- data ----------
const routeOrder = (a, b) => (parseInt(a.replace(/\D/g, "")) || 0) - (parseInt(b.replace(/\D/g, "")) || 0) || a.localeCompare(b);
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
const garageSort = (a, b) => GARAGE_ORDER.indexOf(a) - GARAGE_ORDER.indexOf(b);

const coords = new Map();
function compass(from, to) {
  const a = coords.get(from), b = coords.get(to);
  if (!a || !b) return null;
  const dLat = b.lat - a.lat, dLon = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  if (Math.abs(dLat) >= Math.abs(dLon)) return dLat > 0 ? "Northbound" : "Southbound";
  return dLon > 0 ? "Eastbound" : "Westbound";
}
const DIR_ORDER = { Northbound: 0, Eastbound: 1, Southbound: 2, Westbound: 3 };
const ABBR = { Northbound: "NB", Southbound: "SB", Eastbound: "EB", Westbound: "WB" };
// A direction's name: just "Southbound" etc. (many trips start or end short of the terminal, so a
// terminal name would mislead); the terminal only when there's no compass direction to give.
const dirName = (r) => r.direction || `from ${r.from}`;
// distance in km between two named places (flat-earth is plenty at city scale)
function km(a, b) {
  const p = coords.get(a), q = coords.get(b);
  if (!p || !q) return 0;
  const dLat = (q.lat - p.lat) * 111.32, dLon = (q.lon - p.lon) * 111.32 * Math.cos((p.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
}

function buildRows(summary) {
  coords.clear();
  for (const [location, place] of Object.entries(summary.places ?? {})) coords.set(location, place);
  const rows = [];
  for (const [route, byFrom] of Object.entries(summary.statistics.directionsByRoute)) {
    for (const [from, d] of Object.entries(byFrom)) {
      const departures = d.departures.map((x) => ({ sec: secs(x.time), run: x.run, garage: x.garage, start: x.start, fromRoute: x.fromRoute, short: !!x.short }));
      rows.push({
        route, from, toward: d.toward, trips: d.trips, freq: d.averageFrequency,
        direction: compass(from, d.toward),
        first: secs(d.firstTrip.time), last: secs(d.lastTrip.time),
        firstTrip: d.firstTrip, lastTrip: d.lastTrip, departures,
        garages: [...new Set(departures.map((x) => x.garage))].sort(garageSort),
      });
    }
  }
  return rows;
}
const sortDirs = (list) => list.sort((a, b) => (DIR_ORDER[a.direction] ?? 9) - (DIR_ORDER[b.direction] ?? 9) || a.from.localeCompare(b.from));

// group rows by route, order routes by the chosen sort, directions NB/EB before SB/WB
function grouped() {
  const groups = new Map();
  for (const r of viewRows()) { if (!groups.has(r.route)) groups.set(r.route, []); groups.get(r.route).push(r); }
  for (const g of groups.values()) sortDirs(g);
  const key = {
    route: null,
    first: (g) => Math.min(...g.map((r) => pos(r.first))),
    last: (g) => -Math.max(...g.map((r) => pos(r.last))),
    span: (g) => -(Math.max(...g.map((r) => pos(r.last))) - Math.min(...g.map((r) => pos(r.first)))),
  }[showEnds() ? state.sort : "route"];
  const routes = [...groups.keys()].sort((a, b) => (key ? key(groups.get(a)) - key(groups.get(b)) : 0) || routeOrder(a, b));
  return routes.map((route) => ({ route, rows: groups.get(route) }));
}

function garageLegend(garages) {
  return garages.map((g) => `<span><span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}</span>`).join("");
}

// ---------- svg helpers ----------
const NS = "http://www.w3.org/2000/svg";
function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function fitText(t, maxW) {
  const full = t.textContent;
  if (t.getComputedTextLength() <= maxW) return;
  let s = full;
  while (s.length > 4 && t.getComputedTextLength() > maxW) { s = s.slice(0, -1); t.textContent = s.trimEnd() + "…"; }
  el("title", {}, t).textContent = full;
}

// First / last trip figures only make sense for the whole day; with a time period picked they're left
// out and only the departures (timelines, dots, counts, frequency) are shown.
const showEnds = () => state.period === "all";
// A route running round the clock: its last trip of the day leaves after 2 AM (26:00) and its first before
// 4 AM. Its route page says "24/7 route" instead of first / last trip times.
// Overnight circulators: night-only routes that start and end around the service day's change at
// ~3 AM, so they'd look 24/7 by the times alone. Their pages say "Overnight circulator" and keep their
// first and last trips.
const OVERNIGHT_CIRCULATORS = new Set(["N5"]);
const is247 = (route) => {
  if (OVERNIGHT_CIRCULATORS.has(route)) return false;
  const rows = state.rows.filter((r) => r.route === route);
  return rows.length > 0 && Math.min(...rows.map((r) => r.first)) < 4 * 3600 && Math.max(...rows.map((r) => r.last)) > 26 * 3600;
};

// ---------- run types: duty type, and swing as a quality of the run ----------
// Counts runs (all, or just the given run numbers) by duty type, with how many of each are swings.
const DUTY_ORDER = ["Regular", "Block", "PTO"];
const dutyName = (t) => (t === "PTO" ? "Part Time" : t); // PTO on the paddles = part-time operator
function runMix(numbers = null) {
  const only = numbers && new Set(numbers), by = new Map();
  let total = 0, swings = 0;
  for (const [num, type, swing] of state.summary?.runKinds ?? []) {
    if (only && !only.has(num)) continue;
    total++; swings += swing;
    const o = by.get(type) ?? { type, runs: 0, swings: 0 };
    o.runs++; o.swings += swing; by.set(type, o);
  }
  const rank = (t) => { const i = DUTY_ORDER.indexOf(t); return i === -1 ? 99 : i; };
  return { total, swings, types: [...by.values()].sort((a, b) => rank(a.type) - rank(b.type) || a.type.localeCompare(b.type)) };
}
function runTypesTile(tile, numbers) {
  const m = runMix(numbers);
  if (!m.total) return "";
  return tile("Run types", `${m.swings.toLocaleString()} swing${m.swings === 1 ? "" : "s"}`,
    m.types.map((t) => `${esc(dutyName(t.type))} ${t.runs.toLocaleString()}${t.swings ? ` <span class="small">(${t.swings.toLocaleString()} swing)</span>` : ""}`).join(" · "));
}
function renderRunMix(P, m) {
  const nums = [...new Set(m.trips.filter((t) => inPeriod(t.begin.sec)).flatMap((t) => t.runs))];
  const mix = runMix(nums);
  const pct = (n, of) => (of ? ` <span class="small">${Math.round((100 * n) / of)}%</span>` : "");
  P.part("runMix").innerHTML = mix.total ? `
    <thead><tr><th>Duty type</th><th class="num">Runs</th><th class="num">Swings</th></tr></thead>
    <tbody>${mix.types.map((t) => `<tr><td>${esc(dutyName(t.type))}</td><td class="num">${t.runs}</td><td class="num">${t.swings}${pct(t.swings, t.runs)}</td></tr>`).join("")}
      <tr><td><strong>All runs</strong></td><td class="num"><strong>${mix.total}</strong></td><td class="num"><strong>${mix.swings}</strong>${pct(mix.swings, mix.total)}</td></tr></tbody>` : "";
}


const ORIGINS = [
  ["pullout", "Pullout", "First trip after leaving the garage", "var(--g1)", "#fff"],
  ["deadheadSameRoute", "Deadhead, same route", "After an out-of-service move; the bus's previous trip was this route", "var(--g3)", "#fff"],
  ["fromOtherRoute", "From another route", "The bus's previous trip was a different route", "var(--g4)", "#0b0b0b"],
  ["turnAround", "Turn around", "Right after another trip on this route, or the first trip after taking over the bus at a terminal (plain R relief)", "var(--g5)", "#fff"],
];

const RUN_TYPE_COLORS = { Regular: ["var(--g1)", "#fff"], Block: ["var(--g4)", "#0b0b0b"], PTO: ["var(--g5)", "#fff"] };
const TIME_PARTS = [
  ["service", "In service", "Carrying passengers", "var(--g1)", "#fff"],
  ["recovery", "Layover / recovery", "On the platform but not moving: layovers at terminals, waits before and after reliefs", "var(--axis)", "var(--ink)"],
  ["deadhead", "Deadhead", "Out of service between routes, or back to the start of a route", "var(--g4)", "#0b0b0b"],
  ["garage", "To / from garage", "Pullouts and pull-ins", "var(--g5)", "#fff"],
];
const hrs = (s) => `${Math.round(s / 3600).toLocaleString()} h`;
const pctOf = (n, of) => (of ? Math.round((1000 * n) / of) / 10 : 0);
const legendOf = (items) => items.map(([name, bg]) => `<span><span class="swatch" style="background:${bg}"></span>${esc(name)}</span>`).join("");

const facts = { origin: "pullout", rank: "count", eff: "most", noRush: { origin: false, short: false, hour: false, eff: false }, all: { origin: false, short: false, hour: false, eff: false },
  rt: null, rtKey: null }; // rt = api/routetime result for rtKey (day|garage|period)
async function loadRouteTime() {
  const key = `${state.day}|${state.garage}|${state.period}`;
  if (facts.rtKey === key) return facts.rt;
  const w = state.period === "all" ? "" : `&a=${WINDOW[state.period][0]}&b=${WINDOW[state.period][1]}`;
  const rt = await getJSON(`api/routetime?day=${encodeURIComponent(state.day)}&garage=${encodeURIComponent(state.garage)}${w}`);
  facts.rt = rt; facts.rtKey = key;
  return rt;
}
const SHARE_MIN_TRIPS = 10; // ranking by share only counts routes with at least this many trips (else 1 of 1 = 100%)
function animWindow() {
  const [a, b] = state.period === "all" ? [0, 30] : WINDOW[state.period];
  return { from: a * 3600, to: b * 3600, night: state.period === "overnight" };
}
const runLabel = (run, garage) => `run ${esc(run)}${garage && state.garage === "All" ? ` <span class="swatch" style="background:${garageColor(garage)};margin:0 2px 0 6px"></span>${esc(garage)}` : ""}`;
function byGarageText(deps) {
  const c = {};
  for (const d of deps) c[d.garage] = (c[d.garage] ?? 0) + 1;
  return Object.entries(c).sort((a, b) => garageSort(a[0], b[0]));
}
// ---------- tooltip ----------
function showTip(ev, html) {
  const tip = $("tip");
  tip.innerHTML = html;
  tip.style.display = "block";
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
  let left = ev.clientX + pad, topY = ev.clientY + pad;
  if (left + w > window.innerWidth - 8) left = ev.clientX - w - pad;
  if (topY + h > window.innerHeight - 8) topY = ev.clientY - h - pad;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, topY) + "px";
}
function hideTip() { $("tip").style.display = "none"; }
export const core = {
  $, DAYS, GARAGE_ORDER, garageColor, state, getJSON,
  secs, fmt, nextDay, fmtLong, fmtSpan, tickLabel,
  WEEKDAY_PERIODS, WEEKEND_PERIODS, PERIOD_SWAP, PERIODS, WINDOW, usePeriods, periodOf, inPeriod, shiftOf, pos,
  titleCase, hours, ctxText, fillCtx, periodLabel, viewRows, timeRange, periodStats, tickEvery,
  routeOrder, esc, garageSort, compass, DIR_ORDER, ABBR, dirName, km, coords, buildRows, sortDirs, grouped, garageLegend,
  NS, el, fitText, showEnds, OVERNIGHT_CIRCULATORS, is247, DUTY_ORDER, dutyName, runMix, runTypesTile, renderRunMix,
  RUN_TYPE_COLORS, TIME_PARTS, hrs, pctOf, legendOf, ORIGINS, facts, loadRouteTime, SHARE_MIN_TRIPS, animWindow,
  runLabel, byGarageText, showTip, hideTip,
};
