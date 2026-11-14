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
function renderFacts() {
  // per route: its departures in the period, both directions together
  const byRoute = new Map();
  for (const r of viewRows()) { if (!byRoute.has(r.route)) byRoute.set(r.route, []); byRoute.get(r.route).push(r); }
  const routes = [...byRoute.entries()].map(([route, dirs]) => ({ route, dirs, deps: dirs.flatMap((r) => r.departures) }));

  // --- trip origin ---
  if (!$("fOrigin").options.length) $("fOrigin").innerHTML = ORIGINS.map(([k, name]) => `<option value="${k}">${name}</option>`).join("");
  $("fOrigin").value = facts.origin;
  document.querySelectorAll("[data-frank]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.frank === facts.rank)));
  const [, oName, oWhat, oColor] = ORIGINS.find(([k]) => k === facts.origin);
  $("fOriginSub").textContent = `${oWhat}. ` + (facts.rank === "count" ? "Ranked by number of trips." : `Ranked by share of the route's trips (routes with at least ${SHARE_MIN_TRIPS} trips).`);
  const origin = routes.map((x) => { const n = x.deps.filter((d) => d.start === facts.origin).length; return { ...x, n, share: pctOf(n, x.deps.length) }; })
    .filter((x) => x.n > 0 && (facts.rank === "count" || x.deps.length >= SHARE_MIN_TRIPS));
  const oTop = factList("origin", { id: "fOriginTitle", text: `Routes By Trip Origin: ${oName}` }, origin, (x) => (facts.rank === "count" ? x.n : x.share));
  const oMax = Math.max(0, ...oTop.map((x) => (facts.rank === "count" ? x.n : x.share)));
  $("fOriginList").innerHTML = oTop.length ? oTop.map((x, i) => rankRow(i, x.route, facts.rank === "count" ? x.n : x.share, oMax, oColor,
    facts.rank === "count" ? `<strong>${x.n}</strong> trip${x.n === 1 ? "" : "s"} · ${x.share}% of ${x.deps.length}` : `<strong>${x.share}%</strong> · ${x.n} of ${x.deps.length} trips`)).join("") : noneYet;

  // --- short trips ---
  const shorts = routes.map((x) => ({ ...x, n: x.deps.filter((d) => d.short).length })).filter((x) => x.n > 0);
  const sTop = factList("short", { id: "fShortTitle", text: "Routes With The Most Short Trips" }, shorts, (x) => x.n),sMax = Math.max(0, ...sTop.map((x) => x.n));
  $("fShortList").innerHTML = sTop.length ? sTop.map((x, i) => rankRow(i, x.route, x.n, sMax, "var(--g4)",
    `<strong>${x.n}</strong> short · ${pctOf(x.n, x.deps.length)}% of ${x.deps.length} trips`,
    x.dirs.map((r) => `${dirName(r)}: ${r.departures.filter((d) => d.short).length} of ${r.departures.length} short`).join("\n"))).join("") : noneYet;

  // --- busiest hour: most departures in one direction in one clock hour ---
  const busiest = routes.map((x) => {
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
    `<strong>${x.n}</strong> ${esc(ABBR[x.dir.direction] ?? dirName(x.dir))} trips ${fmt(x.h * 3600)}–${fmt((x.h + 1) * 3600)} · every ${Math.round((10 * 60) / x.n) / 10} min`)).join("") : noneYet;

  // --- efficiency: share of platform time in service ---
  document.querySelectorAll("[data-feff]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.feff === facts.eff)));
  $("fNoRush").checked = facts.noRush;
  const rt = facts.rtKey === `${state.day}|${state.garage}|${state.period}` ? facts.rt : null;
  if (!rt) {
    $("fEffList").innerHTML = `<div class="sub">Loading…</div>`;
    loadRouteTime().then(() => { if (state.fview) renderFacts(); });
  } else {
    const rush = new Set(rt.rushOnly);
    const hrs = (s) => (s / 3600).toFixed(1);
    const eff = routes.filter((x) => rt.routes[x.route] && x.deps.length >= SHARE_MIN_TRIPS && !(facts.noRush && rush.has(x.route))).map((x) => {
      const t = rt.routes[x.route], total = t.service + t.recovery + t.deadhead + t.garage;
      return { ...x, t, total, pct: pctOf(t.service, total) };
    }).filter((x) => x.total > 0);
    const most = facts.eff === "most";
    const eTop = factList("eff", { id: "fEffTitle", text: most ? "Most Efficient Routes" : "Least Efficient Routes" }, eff, (x) => (most ? x.pct : -x.pct));
    $("fEffList").innerHTML = eTop.length ? eTop.map((x, i) => rankRow(i, x.route, x.pct, 100, "var(--g2)",
      `<strong>${x.pct}%</strong> in service · ${hrs(x.total)} bus-hours${rush.has(x.route) ? " · rush only" : ""}`,
      `In service: ${hrs(x.t.service)} h\nLayover / recovery: ${hrs(x.t.recovery)} h\nDeadhead: ${hrs(x.t.deadhead)} h\nPullout / pull-in: ${hrs(x.t.garage)} h`)).join("") : noneYet;
    const hidden = facts.noRush ? routes.filter((x) => rush.has(x.route)).length : 0;
    $("fEffNote").textContent = facts.noRush
      ? `${hidden} rush hour only route${hidden === 1 ? "" : "s"} left out (no trips running between noon and 1 PM).`
      : "Rush hour only routes (no trips running between noon and 1 PM) are marked.";
  }
  fillCtx();
}
$("factsView").addEventListener("click", (e) => {
  const more = e.target.closest("[data-fmore-btn]");
  if (more) { const w = more.dataset.fmoreBtn; facts.all[w] = !facts.all[w]; renderFacts(); return; }
  const row = e.target.closest("[data-open-route]"); if (row) openRoute(row.dataset.openRoute); });
$("fOrigin").addEventListener("change", (e) => { facts.origin = e.target.value; renderFacts(); });
for (const b of document.querySelectorAll("[data-frank]")) b.addEventListener("click", () => { facts.rank = b.dataset.frank; renderFacts(); });
for (const b of document.querySelectorAll("[data-feff]")) b.addEventListener("click", () => { facts.eff = b.dataset.feff; renderFacts(); });
$("fNoRush").addEventListener("change", (e) => { facts.noRush = e.target.checked; renderFacts(); });
$("factsBtn").addEventListener("click", () => writeHash({ fview: true, gview: false, route: null, compare: null }));
$("factsBack").addEventListener("click", () => writeHash({ fview: false }));

  return { renderFacts };
}
