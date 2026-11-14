import { core } from "./index-core.js";

export function createFactsView({ writeHash, openRoute }) {
  const {
    $,
    state,
    ORIGINS,
    pctOf,
    viewRows,
    facts,
    routeOrder,
    esc,
    SHARE_MIN_TRIPS,
    ABBR,
    dirName,
    fmt,
    fillCtx,
    WINDOW,
    getJSON,
    loadRouteTime,
  } = core;

// =====================================================================
// Interesting facts: top 10 lists, for the day, garage and time period at the top
// =====================================================================
// each list shows its top 10 unless "Show all" is on; the heading and the button follow
function factList(which, title, list, key) {
  const sorted = list.sort((a, b) => key(b) - key(a) || routeOrder(a.route, b.route));
  const all = facts.all[which];
  $(title.id).textContent = `${all ? "All" : "Top 10"} ${title.text}`;
  const more = document.querySelector(`[data-fmore="${which}"]`);
  more.innerHTML = sorted.length > 10
    ? `<button type="button" data-fmore-btn="${which}">${all ? "Show top 10" : `Show all ${sorted.length} routes`}</button>` : "";
  return all ? sorted : sorted.slice(0, 10);
}
// one ranked row: "1  Route 146" | bar | note; click it to open the route
function rankRow(i, route, value, max, color, note, title = "") {
  return `<div class="gc-row rank" data-open-route="${esc(route)}" title="${esc(title)}">
    <div class="lab">${i + 1}. Route ${esc(route)}</div>
    <div class="gc-track"><div style="width:${max ? (100 * value) / max : 0}%;background:${color}"></div></div>
    <div class="n">${note}</div></div>`;
}
const noneYet = `<div class="sub">No trips in this period.</div>`;
const loading = `<div class="sub">Loading…</div>`;
function renderFacts() {
  // per route: its departures in the period, both directions together
  const byRoute = new Map();
  for (const r of viewRows()) { if (!byRoute.has(r.route)) byRoute.set(r.route, []); byRoute.get(r.route).push(r); }
  const allRoutes = [...byRoute.entries()].map(([route, dirs]) => ({ route, dirs, deps: dirs.flatMap((r) => r.departures) }));

  // rush hour only routes (no trips running 12–1 PM or 2–3 AM) come from api/routetime; each module has its own Include / Exclude switch
  const rt = facts.rtKey === `${state.day}|${state.garage}|${state.period}` ? facts.rt : null;
  if (!rt) loadRouteTime().then(() => { if (state.fview) renderFacts(); });
  const rush = new Set(rt?.rushOnly ?? []);
  const nRush = allRoutes.filter((x) => rush.has(x.route)).length;
  for (const bar of document.querySelectorAll("[data-frush]")) {
    const w = bar.dataset.frush, ex = facts.noRush[w];
    bar.innerHTML = `<strong>Rush hour only routes</strong>
      <div class="seg" role="group" aria-label="Rush hour only routes">
        <button type="button" data-frush-set="${w}" data-v="0" aria-pressed="${!ex}">Include</button>
        <button type="button" data-frush-set="${w}" data-v="1" aria-pressed="${ex}">Exclude</button></div>
      <span class="sub">${!rt ? "Checking which routes run only at rush hour…"
        : `${ex ? `${nRush} left out` : nRush ? `${nRush} included, tagged “rush only”` : "None in this period"}. These have no trips running 12–1 PM or 2–3 AM.`}</span>`;
  }
  const waiting = (w) => facts.noRush[w] && !rt; // can't tell which to leave out yet
  const routesFor = (w) => (facts.noRush[w] ? allRoutes.filter((x) => !rush.has(x.route)) : allRoutes);
  const tag = (r) => (rush.has(r) ? `<span class="rush-tag">rush only</span>` : "");

  // --- trip origin ---
  if (!$("fOrigin").options.length) $("fOrigin").innerHTML = ORIGINS.map(([k, name]) => `<option value="${k}">${name}</option>`).join("");
  $("fOrigin").value = facts.origin;
  document.querySelectorAll("[data-frank]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.frank === facts.rank)));
  const [, oName, oWhat, oColor] = ORIGINS.find(([k]) => k === facts.origin);
  $("fOriginSub").textContent = `${oWhat}. ` + (facts.rank === "count" ? "Ranked by number of trips." : `Ranked by share of the route's trips (routes with at least ${SHARE_MIN_TRIPS} trips).`);
  const origin = routesFor("origin").map((x) => { const n = x.deps.filter((d) => d.start === facts.origin).length; return { ...x, n, share: pctOf(n, x.deps.length) }; })
    .filter((x) => x.n > 0 && (facts.rank === "count" || x.deps.length >= SHARE_MIN_TRIPS));
  const oTop = factList("origin", { id: "fOriginTitle", text: `Routes By Trip Origin: ${oName}` }, origin, (x) => (facts.rank === "count" ? x.n : x.share));
  const oMax = Math.max(0, ...oTop.map((x) => (facts.rank === "count" ? x.n : x.share)));
  $("fOriginList").innerHTML = oTop.length ? oTop.map((x, i) => rankRow(i, x.route, facts.rank === "count" ? x.n : x.share, oMax, oColor,
    (facts.rank === "count" ? `<strong>${x.n}</strong> trip${x.n === 1 ? "" : "s"} · ${x.share}% of ${x.deps.length}` : `<strong>${x.share}%</strong> · ${x.n} of ${x.deps.length} trips`) + tag(x.route))).join("") : noneYet;
  if (waiting("origin")) $("fOriginList").innerHTML = loading;

  // --- short trips ---
  const shorts = routesFor("short").map((x) => ({ ...x, n: x.deps.filter((d) => d.short).length })).filter((x) => x.n > 0);
  const sTop = factList("short", { id: "fShortTitle", text: "Routes With The Most Short Trips" }, shorts, (x) => x.n),sMax = Math.max(0, ...sTop.map((x) => x.n));
  $("fShortList").innerHTML = sTop.length ? sTop.map((x, i) => rankRow(i, x.route, x.n, sMax, "var(--g4)",
    `<strong>${x.n}</strong> short · ${pctOf(x.n, x.deps.length)}% of ${x.deps.length} trips${tag(x.route)}`,
    x.dirs.map((r) => `${dirName(r)}: ${r.departures.filter((d) => d.short).length} of ${r.departures.length} short`).join("\n"))).join("") : noneYet;
  if (waiting("short")) $("fShortList").innerHTML = loading;

  // --- busiest hour: most departures in one direction in one clock hour ---
  const busiest = routesFor("hour").map((x) => {
    let best = null;
    for (const r of x.dirs) {
      const c = new Map();
      for (const d of r.departures) { const h = Math.floor(d.sec / 3600); c.set(h, (c.get(h) ?? 0) + 1); }
      for (const [h, n] of c) if (!best || n > best.n || (n === best.n && h < best.h)) best = { n, h, dir: r };
    }
    return best && { ...x, ...best };
  }).filter(Boolean);
  const hTop = factList("hour", { id: "fHourTitle", text: "Routes By Busiest Hour" }, busiest, (x) => x.n),hMax = Math.max(0, ...hTop.map((x) => x.n));
  $("fHourList").innerHTML = hTop.length ? hTop.map((x, i) => rankRow(i, x.route, x.n, hMax, "var(--g1)",
    `<strong>${x.n}</strong> ${esc(ABBR[x.dir.direction] ?? dirName(x.dir))} trips ${fmt(x.h * 3600)}–${fmt((x.h + 1) * 3600)} · every ${Math.round((10 * 60) / x.n) / 10} min${tag(x.route)}`)).join("") : noneYet;
  if (waiting("hour")) $("fHourList").innerHTML = loading;

  // --- efficiency: share of platform time in service ---
  document.querySelectorAll("[data-feff]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.feff === facts.eff)));
  if (!rt) {
    $("fEffList").innerHTML = loading;
  } else {
    const hrs = (s) => (s / 3600).toFixed(1);
    const eff = routesFor("eff").filter((x) => rt.routes[x.route] && x.deps.length >= SHARE_MIN_TRIPS).map((x) => {
      const t = rt.routes[x.route], total = t.service + t.recovery + t.deadhead + t.garage;
      return { ...x, t, total, pct: pctOf(t.service, total) };
    }).filter((x) => x.total > 0);
    const most = facts.eff === "most";
    const eTop = factList("eff", { id: "fEffTitle", text: most ? "Most Efficient Routes" : "Least Efficient Routes" }, eff, (x) => (most ? x.pct : -x.pct));
    $("fEffList").innerHTML = eTop.length ? eTop.map((x, i) => rankRow(i, x.route, x.pct, 100, "var(--g2)",
      `<strong>${x.pct}%</strong> in service · ${hrs(x.total)} bus-hours${tag(x.route)}`,
      `In service: ${hrs(x.t.service)} h\nLayover / recovery: ${hrs(x.t.recovery)} h\nDeadhead: ${hrs(x.t.deadhead)} h\nPullout / pull-in: ${hrs(x.t.garage)} h`)).join("") : noneYet;
  }
  fillCtx();
}
$("factsView").addEventListener("click", (e) => {
  const more = e.target.closest("[data-fmore-btn]");
  if (more) { const w = more.dataset.fmoreBtn; facts.all[w] = !facts.all[w]; renderFacts(); return; }
  const rb = e.target.closest("[data-frush-set]");
  if (rb) { facts.noRush[rb.dataset.frushSet] = rb.dataset.v === "1"; renderFacts(); return; }
  const row = e.target.closest("[data-open-route]"); if (row) openRoute(row.dataset.openRoute); });
$("fOrigin").addEventListener("change", (e) => { facts.origin = e.target.value; renderFacts(); });
for (const b of document.querySelectorAll("[data-frank]")) b.addEventListener("click", () => { facts.rank = b.dataset.frank; renderFacts(); });
for (const b of document.querySelectorAll("[data-feff]")) b.addEventListener("click", () => { facts.eff = b.dataset.feff; renderFacts(); });
$("factsBtn").addEventListener("click", () => writeHash({ fview: true, gview: false, route: null, compare: null }));
$("factsBack").addEventListener("click", () => writeHash({ fview: false }));

  return { renderFacts };
}
