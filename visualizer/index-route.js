import { core } from "./index-core.js";

export function createRouteView({ writeHash }) {
  const {
    $,
    state,
    secs,
    km,
    coords,
    garageSort,
    inPeriod,
    periodLabel,
    viewRows,
    sortDirs,
    garageLegend,
    OVERNIGHT_CIRCULATORS,
    esc,
    showEnds,
    is247,
    dirName,
    fmtLong,
    fmtSpan,
    pos,
    garageColor,
    byGarageText,
    runLabel,
    facts,
    TIME_PARTS,
    pctOf,
    routeOrder,
    legendOf,
    SHARE_MIN_TRIPS,
    ORIGINS,
    PERIODS,
    WINDOW,
    shiftOf,
    tickEvery,
    tickLabel,
    el,
    fitText,
    ABBR,
    fmt,
    showTip,
    hideTip,
    loadRouteTime,
    animWindow,
    renderRunMix,
    fillCtx,
  } = core;

// =====================================================================
// Route view
// =====================================================================

/**
 * Every in-service trip on one route, sorted into the two directions of directionsByRoute.
 * A trip split by a mid-route relief (RN / RS / RE / RW) is printed as two pieces on two
 * paddles; they're joined back into one trip here (with the relief point remembered), so only
 * trips that really start or end short of a terminal show as short trips.
 */
function routeModel(route, data) {
  const dirs = data.statistics.directionsByRoute[route] ?? {};
  const terminals = Object.keys(dirs);
  const [A, B] = terminals;
  const garageOfRun = new Map(data.runs.map((r) => [r.number, r.garage]));

  const pieces = [];
  for (const r of data.runs) for (const h of r.halves) {
    const inService = h.trips.filter((t) => t.inService);
    inService.forEach((t, i) => {
      if (t.route !== route) return;
      pieces.push({ run: r.number, half: h, trip: t, first: i === 0, last: i === inService.length - 1 });
    });
  }
  const next = new Map(), hasPrev = new Set();
  for (const p of pieces) {
    const rel = p.half.startRelief;
    if (!p.first || p.half.startType !== "relief" || !rel || rel.direction === "Terminal") continue;
    const at = secs(p.trip.begin.time);
    const prev = pieces.find((q) => q.run === rel.otherRun && q.last && !next.has(q)
      && q.trip.end.location === p.trip.begin.location && Math.abs(secs(q.trip.end.time) - at) <= 120);
    if (prev) { next.set(prev, p); hasPrev.add(p); }
  }
  const trips = [];
  for (const p of pieces) {
    if (hasPrev.has(p)) continue;
    const chain = [p];
    while (next.has(chain[chain.length - 1])) chain.push(next.get(chain[chain.length - 1]));
    const points = [], reliefs = [];
    chain.forEach((c, i) => {
      const pts = [c.trip.begin, ...(c.trip.stops ?? []), c.trip.end].map((q) => ({ location: q.location, sec: secs(q.time) }));
      if (i > 0) { reliefs.push({ ...pts[0], from: chain[i - 1].run, to: c.run }); pts.shift(); }
      points.push(...pts);
    });
    // last piece handed over mid-route to a run that isn't here: where the trip ends isn't known
    const lastPiece = chain[chain.length - 1];
    const openEnd = lastPiece.last && lastPiece.half.endType === "relief" && lastPiece.half.relief?.direction !== "Terminal";
    trips.push({ runs: chain.map((c) => c.run), garage: garageOfRun.get(chain[0].run) ?? "", points, reliefs, begin: points[0], end: points[points.length - 1], openEnd });
  }

  const fromOf = (t) => {
    if (B === undefined) return A;
    if (t.begin.location === A) return A;
    if (t.begin.location === B) return B;
    if (t.end.location === B) return A;
    if (t.end.location === A) return B;
    const b0 = km(t.begin.location, B), b1 = km(t.end.location, B);
    return b1 < b0 ? A : B;
  };
  for (const t of trips) { t.from = fromOf(t); t.toward = t.from === A ? B : A; }
  // Short = starts or ends short of the line's ends: the terminals, plus each direction's own most common
  // start and end when those are real ends of the line, not stops other trips pass through (as in run.js,
  // so a one-way downtown loop like the 134's isn't all short).
  const endsAt = {}, passes = {};
  for (const t of trips) {
    for (const p of [t.begin, t.end]) endsAt[p.location] = (endsAt[p.location] ?? 0) + 1;
    for (const p of t.points.slice(1, -1)) passes[p.location] = (passes[p.location] ?? 0) + 1;
  }
  const isEnd = (loc) => (passes[loc] ?? 0) < 0.2 * (endsAt[loc] ?? 0);
  const commonEnd = (list, pick) => {
    const c = {};
    for (const t of list) { const loc = pick(t).location; if (isEnd(loc)) c[loc] = (c[loc] ?? 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0];
  };
  for (const from of terminals) {
    const list = trips.filter((t) => t.from === from);
    const starts = new Set([from, commonEnd(list, (t) => t.begin)]);
    const ends = new Set([from === A ? B : A, commonEnd(list, (t) => t.end)]);
    for (const t of list) {
      t.startsShort = !starts.has(t.begin.location);
      t.endsShort = t.toward !== undefined && !t.openEnd && !ends.has(t.end.location);
      t.short = t.startsShort || t.endsShort;
    }
  }
  trips.sort((a, b) => a.begin.sec - b.begin.sec);
  const garages = [...new Set(trips.map((t) => t.garage))].sort(garageSort);
  return { route, terminals, dirs, trips, garages, order: stopOrder(trips, A, B), stats: data.statistics };
}

/**
 * The stops from terminal A (top) to terminal B (bottom). Starts from the fullest A→B trip, then
 * fits in every other stop where the trips put it: between the known stops a trip passes just
 * before and just after it (so a stop beyond a terminal, like Solo Cup past Ford City, goes past
 * the end), choosing among those slots by the least added distance.
 */
function stopOrder(trips, A, B) {
  const seqs = trips.map((t) => {
    const s = t.points.map((p) => p.location).filter((loc, i, arr) => loc !== arr[i - 1]);
    return t.from === A ? s : s.reverse();
  });
  const full = seqs.filter((s) => s[0] === A && s[s.length - 1] === B);
  const ref = (full.length ? full : seqs).reduce((a, b) => (b.length > a.length ? b : a), []);
  const order = [...new Set(ref)];
  const slotCost = (loc, i) => {
    const prev = order[i - 1], nxt = order[i];
    return prev === undefined ? km(loc, nxt) : nxt === undefined ? km(prev, loc) : km(prev, loc) + km(loc, nxt) - km(prev, nxt);
  };
  const bestSlot = (loc, lo, hi) => {
    let best = lo, bestCost = Infinity;
    for (let i = lo; i <= hi; i++) { const c = slotCost(loc, i); if (c < bestCost) { bestCost = c; best = i; } }
    return best;
  };
  // longer trips first, so their stops are placed before the short ones that lean on them
  for (const s of [...seqs].sort((a, b) => b.length - a.length)) {
    for (let i = 0; i < s.length; i++) {
      const loc = s[i];
      if (order.includes(loc)) continue;
      let p = -1, n = -1;
      for (let j = i - 1; j >= 0; j--) if (order.includes(s[j])) { p = order.indexOf(s[j]); break; }
      for (let k = i + 1; k < s.length; k++) if (order.includes(s[k])) { n = order.indexOf(s[k]); break; }
      let at;
      if (p !== -1 && (n === -1 || n > p)) at = bestSlot(loc, p + 1, n === -1 ? order.length : n);
      else if (n !== -1 && p === -1) at = bestSlot(loc, 0, n);
      else at = bestSlot(loc, 0, order.length); // the trip runs against the order here: go by distance
      order.splice(at, 0, loc);
    }
  }
  return order;
}

// ---------- panes ----------
// The route view is drawn into a "pane": one in single view, two side by side when comparing.
// Each pane has its own parts (found by data-part) and its own route; day, garage and period are shared.
const PANE_HTML = `
  <div class="pane-head">
    <label class="pane-pick hidden">Route <input data-part="pick" class="route-input" list="routeList" autocomplete="off" spellcheck="false" aria-label="Route for this side" title="Type a route number and press Enter, or pick one from the list"></label>
    <h2 data-part="title" data-ctx></h2>
    <span class="route-kind hidden" data-part="kind">Overnight circulator</span>
    <div class="legend" data-part="garages"></div>
  </div>
  <div class="card notice hidden" data-part="multi">
    <span data-part="multiText"></span>
    <button type="button" class="primary-btn" data-part="multiBtn">Switch to All Garages</button>
  </div>
  <div class="dir-cards" data-part="dirCards"></div>
  <section class="card chart-card">
    <h2 data-ctx>Where Trips Start From</h2>
    <div class="sub">How each in-service trip on this route begins, by direction.</div>
    <div class="legend" data-part="originLegend" style="margin-bottom:10px"></div>
    <div data-part="originBars"></div>
    <div class="table-scroll"><table data-part="originTable"></table></div>
  </section>
  <section class="card chart-card">
    <h2 data-ctx>Average Headway By Hour</h2>
    <div class="sub">Average minutes from each departure in that hour to the next one from the same terminal, with the number of departures below. The day's last departure has no next one, so an hour with only that shows "—".</div>
    <div class="table-scroll"><table class="hours" data-part="hoursTable"></table></div>
  </section>
  <section class="card chart-card">
    <h2 data-ctx>Runs By Duty Type</h2>
    <div class="sub">Runs with an in-service trip on this route, by duty type. Swing is a quality of a run, not a type, so a Regular, Block or Part Time run can also be a swing.</div>
    <div class="table-scroll"><table data-part="runMix"></table></div>
  </section>
  <section class="card chart-card">
    <h2 data-ctx>Service Efficiency</h2>
    <div class="sub">How the buses working this route spend their platform time (pull-out to pull-in). Layovers, deadheads and pullouts count toward the route of the bus's next trip; the pull-in toward its last one.</div>
    <div data-part="eff"></div>
  </section>
  <section class="card chart-card">
    <div class="card-head">
      <div>
        <h2 data-ctx>All Trips</h2>
        <div class="sub">One line per trip: time runs left to right, stops top to bottom, spaced by distance. Lines are colored by garage. Hover a line for its run and times.</div>
      </div>
      <div class="seg" role="group" aria-label="Zoom">
        <button type="button" data-zoom="1">1×</button><button type="button" data-zoom="2">2×</button><button type="button" data-zoom="4">4×</button><button type="button" data-zoom="8">8×</button>
      </div>
    </div>
    <div class="legend" style="margin-bottom:12px" data-part="graphLegend"></div>
    <div data-part="graphs"></div>
  </section>`;
const panes = []; // [{ el, side, route, model }]
function paneFor(side) {
  let p = panes[side];
  if (!p) {
    const el = document.createElement("div");
    el.className = "route-pane"; el.innerHTML = PANE_HTML;
    p = panes[side] = { el, side, part: (n) => el.querySelector(`[data-part="${n}"]`) };
    // this side's own route picker
    routeInput(p.part("pick"), (r) => r && writeHash(side === 0 ? { route: r } : { compare: r }), () => (side === 0 ? state.route : state.compare));
    p.part("multiBtn").addEventListener("click", () => writeHash({ garage: "All" }));
  }
  return p;
}
function layoutPanes() {
  const host = $("panes"), comparing = !!state.compare;
  const want = comparing ? [paneFor(0), paneFor(1)] : [paneFor(0)];
  if (host.children.length !== want.length || [...host.children].some((c, i) => c !== want[i].el)) host.replaceChildren(...want.map((p) => p.el));
  host.classList.toggle("compare", comparing);
  document.body.classList.toggle("comparing", comparing);
  for (const p of want) p.el.querySelector(".pane-pick").classList.toggle("hidden", !comparing);
  $("compareBtn").classList.toggle("hidden", comparing);
  $("singleBtn").classList.toggle("hidden", !comparing);
  $("animCard").classList.toggle("hidden", comparing); // no animation while comparing
  for (const b of $("panes").querySelectorAll("[data-zoom]")) b.setAttribute("aria-pressed", String(Number(b.dataset.zoom) === state.zoom));
  return want;
}
// A route picker you can type in or pick from (an input with the routes in #routeList). Typing a route
// ("49", "x49") and pressing Enter goes there; picking from the list goes at once. While it has focus
// the box is emptied (current route shown greyed) so the list shows every route, not just matches.
function routeInput(el, go, current, { allowEmpty = false } = {}) {
  const blank = el.placeholder;
  const msg = document.createElement("span"); msg.className = "route-msg"; msg.setAttribute("role", "status");
  el.after(msg);
  let msgTimer = 0;
  const say = (text) => { msg.textContent = text; clearTimeout(msgTimer); if (text) msgTimer = setTimeout(() => (msg.textContent = ""), 4000); };
  const find = (text) => {
    const t = text.trim().replace(/^(route|cta)\s*/i, "").replace(/^#/, "").toUpperCase();
    return t ? (state.routes ?? []).find((r) => r.toUpperCase() === t) ?? null : "";
  };
  const commit = () => {
    const r = find(el.value);
    if (r === "") { if (allowEmpty && current()) go(null); return; }
    if (!r) { say(`No route ${el.value.trim()} on ${state.day}${state.garage === "All" ? "" : " at " + state.garage}`); el.select(); return; }
    say(""); el.value = r; el.placeholder = blank;
    if (r !== current()) go(r);
    el.blur();
  };
  el.addEventListener("focus", () => { el.placeholder = current() ?? blank; el.value = ""; });
  el.addEventListener("blur", () => { if (!find(el.value)) el.value = current() ?? ""; el.placeholder = blank; });
  el.addEventListener("input", (e) => {
    if (!e.inputType || e.inputType === "insertReplacementText") commit(); // picked from the list
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { el.value = ""; el.blur(); }
  });
}
function fillPickers(routes) {
  for (const p of panes) if (p) {
    const cur = p.side === 0 ? state.route : state.compare;
    p.part("pick").value = cur ?? "";
  }
}

function renderRoute() {
  const list = layoutPanes();
  for (const p of list) renderPane(p);
  if (!state.compare) syncAnimation();
  fillCtx();
}

// With one garage picked: the other garages with a trip on the route in the chosen period (from the
// all-garages summary, state.allSummary), or [] when only the picked garage runs it then.
function otherGarages(route) {
  if (state.garage === "All" || state.allSummary?.day !== state.day) return [];
  const out = new Set();
  for (const d of Object.values(state.allSummary.statistics.directionsByRoute[route] ?? {}))
    for (const x of d.departures) if (x.garage && x.garage !== state.garage && inPeriod(secs(x.time))) out.add(x.garage);
  return [...out].sort(garageSort);
}

function renderPane(P) {
  const m = P.model, route = P.route;
  const rows = sortDirs(viewRows().filter((r) => r.route === route));
  P.el.dataset.route = route; P.part("title").textContent = "";
  P.part("garages").innerHTML = m.garages.length > 1 || state.garage === "All" ? garageLegend(m.garages) : "";
  P.part("kind").classList.toggle("hidden", !OVERNIGHT_CIRCULATORS.has(route));
  // one garage picked, but other garages also run this route in the period: say so, with a way to see them all
  const others = otherGarages(route);
  P.part("multi").classList.toggle("hidden", !others.length);
  if (others.length) P.part("multiText").textContent = `Route ${route} has runs from multiple garages scheduled at this time. Switch to All Garages to see them.`;
  if (!rows.length) {
    P.part("dirCards").innerHTML = `<div class="card dir-card"><h3>No trips</h3><div class="toward">Route ${esc(route)} has no trips leaving in ${esc(periodLabel())}.</div></div>`;
    for (const n of ["originLegend", "originBars", "originTable", "hoursTable", "runMix", "eff", "graphs", "graphLegend"]) P.part(n).innerHTML = "";
    return;
  }

  // --- first / last trip per direction (or "24/7 route") ---
  const allDay247 = showEnds() && is247(route);
  const shortCount = (from) => m.trips.filter((t) => t.from === from && t.short && inPeriod(t.begin.sec)).length;
  const startNote = (t) => `<span class="small">${runLabel(t.run, t.garage)} · from ${esc(t.from)}</span>`;
  P.part("dirCards").innerHTML = rows.map((r) => `
    <div class="card dir-card">
      <h3 data-ctx>${esc(dirName(r))}</h3>
      <dl class="facts">
        ${allDay247 ? `<div><dt>Service</dt><dd>24/7 route</dd></div>`
          : showEnds() ? `<div><dt>First trip</dt><dd>${fmtLong(r.first)}${startNote(r.firstTrip, r)}</dd></div>
        <div><dt>Last trip</dt><dd>${fmtLong(r.last)}${startNote(r.lastTrip, r)}</dd></div>` : ""}
        <div><dt>Trips</dt><dd>${r.trips}<span class="small">${shortCount(r.from)} short</span></dd></div>
        <div><dt>Every (${state.period === "all" ? "all day" : "average"})</dt><dd>${r.freq == null ? "—" : r.freq + " min"}${showEnds() && !allDay247 ? `<span class="small">span ${fmtSpan(pos(r.last) - pos(r.first))}</span>` : ""}</dd></div>
      </dl>
      ${r.garages.length > 1 ? `<div class="by-garage">${byGarageText(r.departures).map(([g, n]) => `<span><span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}: ${n} trips</span>`).join("")}</div>` : ""}
    </div>`).join("");

  renderOrigins(P, rows);
  renderHours(P, rows, m);
  renderRunMix(P, m);
  renderEfficiency(P, route);
  renderGraphs(P, m, rows);
}

// --- service efficiency: this route's platform time split (api/routetime, as on the facts page) ---
function renderEfficiency(P, route) {
  const box = P.part("eff");
  const rt = facts.rtKey === `${state.day}|${state.garage}|${state.period}` ? facts.rt : null;
  if (!rt) { box.innerHTML = `<div class="sub">Loading…</div>`; loadRouteTime().then(() => { if (state.route && !state.fview && !state.gview) renderRoute(); },
    (e) => { box.innerHTML = `<div class="sub">Couldn't load: ${esc(e.message)}</div>`; }); return; }
  const t = rt.routes[route];
  const total = (x) => TIME_PARTS.reduce((a, [k]) => a + (x?.[k] ?? 0), 0);
  if (!t || !total(t)) { box.innerHTML = `<div class="sub">No platform time on this route in ${esc(periodLabel())}.</div>`; return; }
  const h1 = (s) => `${(s / 3600).toFixed(1)} h`, all = total(t), pct = pctOf(t.service, all);
  // compared with the other routes in the same period (and garage): routes with enough trips to rank
  const tripsOf = new Map();
  for (const r of viewRows()) tripsOf.set(r.route, (tripsOf.get(r.route) ?? 0) + r.departures.length);
  const ranked = Object.entries(rt.routes).filter(([r, x]) => (tripsOf.get(r) ?? 0) >= SHARE_MIN_TRIPS && total(x) > 0)
    .map(([r, x]) => [r, pctOf(x.service, total(x))]).sort((a, b) => b[1] - a[1] || routeOrder(a[0], b[0]));
  const place = ranked.findIndex(([r]) => r === route);
  const sum = Object.values(rt.routes).reduce((a, x) => { for (const [k] of TIME_PARTS) a[k] = (a[k] ?? 0) + (x[k] ?? 0); return a; }, {});
  const avg = pctOf(sum.service, total(sum)), diff = Math.round(10 * (pct - avg)) / 10;
  const scope = state.garage === "All" ? "all routes" : `all ${state.garage} routes`;
  const rush = rt.rushOnly.includes(route);
  box.innerHTML = `
    <dl class="facts eff-facts">
      <div><dt>In service</dt><dd>${pct}%<span class="small">${diff === 0 ? "same as" : `${Math.abs(diff)} points ${diff > 0 ? "above" : "below"}`} ${esc(scope)} (${avg}%)</span></dd></div>
      <div><dt>Rank</dt><dd>${place === -1 ? "—" : `${place + 1} of ${ranked.length}`}<span class="small">${place === -1 ? `fewer than ${SHARE_MIN_TRIPS} trips, not ranked` : "most efficient first"}</span></dd></div>
      <div><dt>Platform time</dt><dd>${h1(all)}<span class="small">${rush ? "rush hour only route" : "bus-hours"}</span></dd></div>
    </dl>
    <div class="legend" style="margin:12px 0 8px">${legendOf(TIME_PARTS.map(([, name, , bg]) => [name, bg]))}</div>
    <div class="segbar" role="img" aria-label="${esc(TIME_PARTS.map(([k, name]) => `${name} ${pctOf(t[k], all)}%`).join(", "))}">${TIME_PARTS.filter(([k]) => t[k] > 0).map(([k, name, , bg, ink]) =>
      `<div style="flex:${t[k]} 1 0;background:${bg};color:${ink}" title="${esc(name)}: ${h1(t[k])} (${pctOf(t[k], all)}%)"><span>${pctOf(t[k], all)}%</span></div>`).join("")}</div>
    <div class="table-scroll" style="margin-top:12px"><table>
      <thead><tr>${TIME_PARTS.map(([, name, what]) => `<th class="num" title="${esc(what)}">${name}</th>`).join("")}<th class="num">Platform</th></tr></thead>
      <tbody><tr>${TIME_PARTS.map(([k]) => `<td class="num">${h1(t[k])} <span class="small">${pctOf(t[k], all)}%</span></td>`).join("")}<td class="num">${h1(all)}</td></tr></tbody>
    </table></div>`;
  requestAnimationFrame(() => { for (const d of box.querySelectorAll(".segbar > div")) { const sp = d.firstChild; if (sp.offsetWidth + 16 > d.clientWidth) sp.style.visibility = "hidden"; } });
}

// --- animation (drawn in the browser by anim-player.js) ---
// Made when asked for; once made for this route it follows the day / garage / period picked at the top.
const anim = { player: null, key: null, route: null, loading: 0 };
const animKey = () => `${state.day}|${state.garage}|${state.route}|${state.period}`;
async function generateAnimation() {
  const ticket = ++anim.loading, key = animKey();
  anim.player ??= AnimPlayer.create($("animPlayer"));
  $("animPlayer").classList.remove("hidden");
  $("animGo").textContent = "Regenerate";
  $("animStatus").textContent = `Loading route ${state.route}…`;
  try {
    const d = await anim.player.load({ day: state.day, garage: state.garage, route: state.route, ...animWindow() });
    if (ticket !== anim.loading) return;
    anim.key = key; anim.route = state.route;
    $("animStatus").textContent = `${state.day} · ${state.garage === "All" ? "all garages" : state.garage} · ${periodLabel()} · ${d.buses.length} bus${d.buses.length === 1 ? "" : "es"}` +
      (d.garages.length > 1 ? ` · ${d.garages.map((g, i) => `${g} ${["circles", "squares", "diamonds"][Math.min(i, 2)]}`).join(", ")}` : "") +
      (d.missingPaths.length ? ` · ${d.missingPaths.length} moves without a path (skipped)` : "");
  } catch (e) {
    if (ticket === anim.loading) $("animStatus").textContent = `Couldn't load the animation: ${e.message}`;
  }
}
function syncAnimation() {
  if (anim.route && anim.route !== state.route) { // another route: start fresh
    anim.route = null; anim.key = null; anim.player?.pause();
    $("animPlayer").classList.add("hidden"); $("animStatus").textContent = ""; $("animGo").textContent = "Generate animation";
  } else if (anim.key && anim.key !== animKey()) generateAnimation(); // same route, new day / garage / period
}
$("animGo").addEventListener("click", generateAnimation);

// --- trip origins (statistics.tripStartsByRoute) ---
// Categorical colors (the same palette steps as the garages); the table names each part.
// counts of each trip-start kind among some departures: { pullout: n, ..., total }
function originCounts(deps) {
  const c = Object.fromEntries(ORIGINS.map(([k]) => [k, 0]));
  let total = 0;
  for (const d of deps) if (d.start && d.start in c) { c[d.start]++; total++; }
  return { ...c, total };
}
const pctText = (n, total) => (total ? `${Math.round((1000 * n) / total) / 10}%` : "—");
function originBar(c, label, cls = "") {
  const parts = ORIGINS.map(([k, name, , bg, ink]) => ({ k, name, bg, ink, n: c[k] })).filter((p) => p.n > 0);
  const aria = `${label}: ` + parts.map((p) => `${p.name} ${p.n} (${pctText(p.n, c.total)})`).join(", ");
  return `<div class="origin-row ${cls}"><div class="lab">${label}</div>
    <div class="segbar" role="img" aria-label="${esc(aria)}">${parts.map((p) =>
      // "From another route" gets a hover breakdown by route (fromRouteTip); the others a plain title
      p.k === "fromOtherRoute"
        ? `<div style="flex:${p.n} 1 0;background:${p.bg};color:${p.ink};cursor:default" data-from-other><span>${pctText(p.n, c.total)}</span></div>`
        : `<div style="flex:${p.n} 1 0;background:${p.bg};color:${p.ink}" title="${esc(p.name)}: ${p.n} trips, ${pctText(p.n, c.total)}"><span>${pctText(p.n, c.total)}</span></div>`).join("")}</div>
    <div class="n">${c.total} trips</div></div>`;
}
// Tooltip for the "From another route" part of a direction's bar: how many trips came from each route.
function fromRouteTip(r, route) {
  const deps = r.departures.filter((d) => d.start === "fromOtherRoute");
  const by = new Map();
  for (const d of deps) { const k = d.fromRoute ?? "?"; by.set(k, (by.get(k) ?? 0) + 1); }
  const list = [...by.entries()].sort((a, b) => b[1] - a[1] || routeOrder(a[0], b[0]));
  const pct = (n) => `${Math.round((100 * n) / deps.length)}%`;
  return `
    <div class="t">Route ${esc(route)} ${esc(dirName(r))}: ${deps.length} trip${deps.length === 1 ? "" : "s"} from another route</div>
    <dl>${list.map(([k, n]) => `<dt>From ${esc(k)}</dt><dd>${n} trip${n === 1 ? "" : "s"} <span class="small">${pct(n)}</span></dd>`).join("")}</dl>`;
}
function renderOrigins(P, rows) {
  P.part("originLegend").innerHTML = ORIGINS.map(([, name, , bg]) => `<span><span class="swatch" style="background:${bg}"></span>${name}</span>`).join("");
  const perDir = rows.map((r) => ({ r, all: originCounts(r.departures) }));
  P.part("originBars").innerHTML = perDir.map(({ r, all }) => {
    let html = `<div class="origin-dir"><h3 style="margin-bottom:6px">${esc(dirName(r))}</h3>`;
    const p = PERIODS.find((q) => q.key === state.period);
    html += originBar(all, p ? `${p.short}<div class="small">${p.span}</div>` : "All day", "all");
    return html + "</div>";
  }).join("");
  // hide a percentage that doesn't fit its block
  for (const d of P.part("originBars").querySelectorAll(".segbar > div")) { const sp = d.firstChild; if (sp.offsetWidth + 16 > d.clientWidth) sp.style.visibility = "hidden"; }
  // hover "From another route": which routes the buses came from, and the runs
  P.part("originBars").querySelectorAll(".origin-dir").forEach((el, i) => {
    const seg = el.querySelector("[data-from-other]");
    if (!seg) return;
    const html = fromRouteTip(perDir[i].r, P.route);
    seg.addEventListener("mousemove", (ev) => showTip(ev, html));
    seg.addEventListener("mouseleave", hideTip);
  });
  const dirHead = (r) => esc(ABBR[r.direction] ?? dirName(r));
  P.part("originTable").innerHTML = `
    <thead><tr><th>Trip starts</th>${perDir.map(({ r }) => `<th class="num">${dirHead(r)}</th>`).join("")}<th>Meaning</th></tr></thead>
    <tbody>${ORIGINS.map(([k, name, what, bg]) => `<tr><td><span class="swatch" style="background:${bg}"></span>${name}</td>
      ${perDir.map(({ all }) => `<td class="num">${all[k]} <span class="small">${pctText(all[k], all.total)}</span></td>`).join("")}
      <td class="small">${what}</td></tr>`).join("")}
      <tr><td><strong>All trips</strong></td>${perDir.map(({ all }) => `<td class="num"><strong>${all.total}</strong></td>`).join("")}<td></td></tr></tbody>`;
}

// --- average headway by hour, per direction ---
function renderHours(P, rows, m) {
  const byDir = rows.map((r) => {
    const c = {}, gaps = {};
    // gaps are measured against the whole day's departures (so the last trip in a period still
    // has its next departure); only departures in the period are counted
    const fullRow = state.rows.find((x) => x.route === r.route && x.from === r.from) ?? r;
    const deps = [...fullRow.departures].sort((a, b) => a.sec - b.sec);
    deps.forEach((d, i) => {
      if (!inPeriod(d.sec)) return;
      const h = Math.floor(pos(d.sec) / 3600);
      c[h] = (c[h] ?? 0) + 1;
      if (i + 1 < deps.length) (gaps[h] ??= []).push(deps[i + 1].sec - d.sec);
    });
    const avg = {};
    for (const [h, g] of Object.entries(gaps)) avg[h] = Math.round(g.reduce((a, b) => a + b, 0) / g.length / 60);
    return { r, c, avg };
  });
  const peak = m.stats.peakBusesByRouteByHour?.[P.route] ?? {};
  const hours = new Set();
  for (const { c } of byDir) for (const h of Object.keys(c)) hours.add(Number(h));
  const hs = [...hours].sort((a, b) => a - b);
  if (!hs.length) { P.part("hoursTable").innerHTML = `<tr><td class="small">No departures.</td></tr>`; return; }
  const all = []; for (let h = hs[0]; h <= hs[hs.length - 1]; h++) all.push(h);
  const key = (h) => `${String(h).padStart(2, "0")}:00`;
  // overnight puts early-morning hours after midnight (28:00 = 4 AM): take the busier of both
  const peakAt = (h) => {
    const v = [peak[key(h)], state.period === "overnight" && h >= 24 ? peak[key(h - 24)] : undefined].filter((x) => x != null);
    return v.length ? Math.max(...v) : null;
  };
  P.part("hoursTable").innerHTML = `
    <thead><tr><th>Direction</th>${all.map((h) => `<th>${tickLabel(h)}</th>`).join("")}</tr></thead>
    <tbody>
      ${byDir.map(({ r, c, avg }) => `<tr><td><strong>${esc(dirName(r))}</strong></td>${all.map((h) => c[h]
        ? `<td title="${c[h]} departure${c[h] === 1 ? "" : "s"}">${avg[h] ?? "—"}<span class="small">${c[h]} trip${c[h] === 1 ? "" : "s"}</span></td>`
        : `<td class="small">—</td>`).join("")}</tr>`).join("")}
      <tr><td>Buses on the route <span class="small">most at once</span></td>${all.map((h) => `<td>${peakAt(h) ?? '<span class="small">—</span>'}</td>`).join("")}</tr>
    </tbody>`;
}

// --- string graphs ---
// The stops down a string graph, always the same way round on the map: a route running mostly north–south
// has its north end at the top, one running mostly east–west its west end at the top (so the 49 and X49,
// or two compared routes, read the same way).
function stopsTopToBottom(P, m) {
  if (m.order.length < 2) return m.order;
  const a = coords.get(m.order[0]), b = coords.get(m.order.at(-1));
  if (!a || !b) return m.order;
  const dy = b.lat - a.lat, dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const flip = Math.abs(dy) >= Math.abs(dx) ? dy > 0 : dx < 0; // the end that should be on top is at the bottom
  return flip ? [...m.order].reverse() : m.order;
}
function renderGraphs(P, m, rows) {
  const host = P.part("graphs");
  host.innerHTML = "";
  P.part("graphLegend").innerHTML = garageLegend(m.garages) +
    `<span><span class="ring" style="background:var(--ink-2)"></span>Where a short trip starts or ends mid-route</span>
     <span><span class="ring" style="border:1.5px solid var(--ink-2)"></span>Relief: another run takes over</span>`;
  if (!m.trips.length) return;
  const order = stopsTopToBottom(P, m);
  const cum = [0];
  for (let i = 1; i < order.length; i++) cum.push(cum[i - 1] + Math.max(km(order[i - 1], order[i]), 0.05));
  const total = cum[cum.length - 1] || 1;
  const minGap = Math.min(...cum.slice(1).map((c, i) => c - cum[i]));
  const plotH = Math.max(220, Math.min(440, (16 * total) / minGap));
  const top = 24, tickY = 12, bottom = 10, H = top + plotH + bottom;
  const yOf = new Map(order.map((loc, i) => [loc, top + (cum[i] / total) * plotH]));

  // only trips that leave in the chosen period; a whole trip moves with its departure (overnight)
  const shown = m.trips.filter((t) => inPeriod(t.begin.sec));
  if (!shown.length) return;
  const off = (t) => shiftOf(t.begin.sec);
  const tEnd = Math.max(...shown.map((t) => t.end.sec + off(t)));
  let h0, h1;
  if (state.period === "all") { h0 = Math.floor(Math.min(...shown.map((t) => t.begin.sec)) / 3600); h1 = Math.ceil(tEnd / 3600); }
  else { const [a, b] = WINDOW[state.period]; h0 = Math.floor(a); h1 = Math.max(Math.ceil(b), Math.ceil(tEnd / 3600)); }
  const hostW = host.clientWidth || 900;
  const labelW = hostW < 640 ? 110 : 220;
  const plotW = Math.max(200, (hostW - labelW) * state.zoom);
  const pad = 22;
  const x = (s) => pad + ((s - h0 * 3600) / ((h1 - h0) * 3600)) * (plotW - 2 * pad);
  const every = tickEvery((plotW - 2 * pad) / (h1 - h0));

  for (const r of rows) {
    const trips = shown.filter((t) => t.from === r.from);
    const card = document.createElement("div");
    card.style.marginBottom = "18px";
    const short = trips.filter((t) => t.short).length;
    card.innerHTML = `<h3 style="margin-bottom:6px">${esc(dirName(r))} <span class="small" style="font-weight:400">${trips.length} trips, ${short} short</span></h3>`;
    const g = document.createElement("div");
    g.className = "graph viz";
    card.appendChild(g);
    host.appendChild(card);

    const lab = el("svg", { width: labelW, height: H, class: "labels" }, g);
    let lastY = -Infinity;
    order.forEach((loc, i) => {
      const y = yOf.get(loc), term = i === 0 || i === order.length - 1;
      if (!term && y - lastY < 13) return;
      if (!term && i === order.length - 2 && yOf.get(order[order.length - 1]) - y < 13) return;
      const t = el("text", { x: labelW - 8, y: y + 4, "text-anchor": "end", class: "stop" + (term ? " term" : "") }, lab);
      t.textContent = loc;
      fitText(t, labelW - 12);
      lastY = y;
    });

    const wrap = document.createElement("div");
    wrap.className = "plot";
    g.appendChild(wrap);
    const svg = el("svg", { width: plotW, height: H, role: "img",
      "aria-label": `String graph of route ${P.route} ${dirName(r)} trips` }, wrap);
    for (const loc of order) el("line", { x1: 0, x2: plotW, y1: yOf.get(loc), y2: yOf.get(loc), class: "stopline" }, svg);
    for (let hr = h0; hr <= h1; hr++) {
      const gx = x(hr * 3600);
      el("line", { x1: gx, x2: gx, y1: top - 4, y2: H - bottom, class: hr % 24 === 0 ? "midnight" : "grid" }, svg);
      if (hr % every === 0) el("text", { x: gx, y: tickY, "text-anchor": "middle", class: "tick" }, svg).textContent = tickLabel(hr);
    }
    for (const t of trips) {
      const color = garageColor(t.garage);
      const o = off(t);
      const grp = el("g", { class: "trip" }, svg);
      const pts = t.points.map((p) => `${x(p.sec + o).toFixed(1)},${yOf.get(p.location).toFixed(1)}`).join(" ");
      el("polyline", { points: pts, class: "line", stroke: color }, grp);
      el("polyline", { points: pts, class: "hitline" }, grp);
      if (t.startsShort) el("circle", { cx: x(t.begin.sec + o), cy: yOf.get(t.begin.location), r: 3.5, class: "end", fill: color }, grp);
      if (t.endsShort) el("circle", { cx: x(t.end.sec + o), cy: yOf.get(t.end.location), r: 3.5, class: "end", fill: color }, grp);
      for (const rel of t.reliefs) el("circle", { cx: x(rel.sec + o), cy: yOf.get(rel.location), r: 3, class: "relief", stroke: color }, grp);
      grp.addEventListener("mouseenter", () => { svg.classList.add("focus"); grp.classList.add("hot"); grp.parentNode.appendChild(grp); });
      grp.addEventListener("mouseleave", () => { svg.classList.remove("focus"); grp.classList.remove("hot"); hideTip(); });
      grp.addEventListener("mousemove", (ev) => showTip(ev, tripTip(t)));
    }
  }
  const plots = [...host.querySelectorAll(".plot")];
  let syncing = false;
  for (const p of plots) p.addEventListener("scroll", () => {
    if (syncing) return;
    syncing = true;
    for (const q of plots) if (q !== p) q.scrollLeft = p.scrollLeft;
    requestAnimationFrame(() => { syncing = false; });
  });
}

function tripTip(t) {
  const runs = t.runs.length > 1 ? `Runs ${t.runs.map(esc).join(" → ")}` : `Run ${esc(t.runs[0])}`;
  const notes = [];
  if (t.startsShort) notes.push(`Starts at ${esc(t.begin.location)}, short of ${esc(t.from)}`);
  if (t.endsShort) notes.push(`Ends at ${esc(t.end.location)}, short of ${esc(t.toward)}`);
  for (const r of t.reliefs) notes.push(`Relief at ${esc(r.location)}, ${fmt(r.sec)}: ${esc(r.to)} takes over from ${esc(r.from)}`);
  return `
    <div class="t">${runs}${t.short ? " · short trip" : ""}</div>
    <dl>
      <dt>Garage</dt><dd><span class="swatch" style="background:${garageColor(t.garage)}"></span>${esc(t.garage)}</dd>
      <dt>Departs</dt><dd>${fmtLong(t.begin.sec)} · ${esc(t.begin.location)}</dd>
      <dt>Arrives</dt><dd>${fmtLong(t.end.sec)} · ${esc(t.end.location)}</dd>
      <dt>Running</dt><dd>${Math.round((t.end.sec - t.begin.sec) / 60)} min</dd>
    </dl>
    ${notes.map((n) => `<div class="note" style="margin-top:4px">${n}</div>`).join("")}`;
}

  return { panes, paneFor, routeModel, renderRoute, renderGraphs, routeInput, syncAnimation, fillPickers };
}
