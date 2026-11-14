import { core } from "./index-core.js";

export function createGarageView({ writeHash }) {
  const {
    $,
    state,
    viewRows,
    DUTY_ORDER,
    routeOrder,
    ORIGINS,
    pos,
    garageSort,
    esc,
    garageColor,
    showEnds,
    fmtLong,
    periodLabel,
    dirName,
    WINDOW,
    getJSON,
    TIME_PARTS,
    hrs,
    pctOf,
    legendOf,
    dutyName,
    RUN_TYPE_COLORS,
    fillCtx,
    animWindow,
  } = core;

// =====================================================================
// Garage comparison: every garage side by side, for the day and time period at the top
// =====================================================================
// Trips, routes, run types, swings and trip starts come from the all-garages summary (each departure
// knows its garage and run); how buses spend their time from api/timeuse (platform time split by the server).
function gcStack(g, parts, note) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  return `<div class="gc-row"><div class="lab"><span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}</div>
    <div class="segbar" role="img" aria-label="${esc(g)}: ${esc(parts.map((p) => `${p.name} ${pctOf(p.n, total)}%`).join(", "))}">${parts.filter((p) => p.n > 0).map((p) =>
      `<div style="flex:${p.n} 1 0;background:${p.bg};color:${p.ink}" title="${esc(g)} · ${esc(p.name)}: ${esc(p.label ?? p.n.toLocaleString())} (${pctOf(p.n, total)}%)"><span>${pctOf(p.n, total)}%</span></div>`).join("")}</div>
    <div class="n">${note}</div></div>`;
}
// a single value bar (0 … max) for one garage
function gcValue(g, value, max, note, title) {
  return `<div class="gc-row" title="${esc(title ?? "")}"><div class="lab"><span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}</div>
    <div class="gc-track"><div style="width:${max ? (100 * value) / max : 0}%;background:${garageColor(g)}"></div></div>
    <div class="n">${note}</div></div>`;
}
// per garage: the departures in the period, the runs, routes, types, swings, trip starts
function garageFacts(g) {
  const deps = [];
  for (const r of viewRows()) for (const d of r.departures) if (d.garage === g) deps.push({ ...d, route: r.route, row: r });
  const runNums = new Set(deps.map((d) => d.run));
  const kinds = (state.summary.runKinds ?? []).filter((k) => k[3] === g && (state.period === "all" || runNums.has(k[0])));
  const types = new Map();
  for (const [, type, swing] of kinds) { const o = types.get(type) ?? { type, runs: 0, swings: 0 }; o.runs++; o.swings += swing; types.set(type, o); }
  const rank = (t) => { const i = DUTY_ORDER.indexOf(t); return i === -1 ? 99 : i; };
  const routes = [...new Set(deps.map((d) => d.route))].sort(routeOrder);
  const others = new Set();
  for (const r of viewRows()) for (const d of r.departures) if (d.garage !== g) others.add(r.route);
  const starts = Object.fromEntries(ORIGINS.map(([k]) => [k, 0]));
  for (const d of deps) if (d.start in starts) starts[d.start]++;
  const first = deps.length ? deps.reduce((a, b) => (pos(b.sec) < pos(a.sec) ? b : a)) : null;
  const last = deps.length ? deps.reduce((a, b) => (pos(b.sec) > pos(a.sec) ? b : a)) : null;
  return { g, deps, runs: kinds.length, swings: kinds.reduce((a, k) => a + k[2], 0),
    types: [...types.values()].sort((a, b) => rank(a.type) - rank(b.type)), routes, shared: routes.filter((r) => others.has(r)), starts, first, last };
}

const gc = { tu: null, key: null, hidden: new Set() }; // tu = api/timeuse result for gc.key (day|period)
async function loadTimeUse() {
  const key = `${state.day}|${state.period}`;
  if (gc.key === key) return gc.tu;
  const w = state.period === "all" ? "" : `&a=${WINDOW[state.period][0]}&b=${WINDOW[state.period][1]}`;
  gc.tu = await getJSON(`api/timeuse?day=${encodeURIComponent(state.day)}${w}`);
  gc.key = key;
  return gc.tu;
}

function renderGarages() {
  const all = state.days.find((d) => d.day === state.day)?.garages ?? [];
  $("gcPick").innerHTML = `<span>Garages:</span>` + all.map((g) => `<label><input type="checkbox" data-gc="${esc(g)}" ${gc.hidden.has(g) ? "" : "checked"}>
    <span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}</label>`).join("");
  const list = all.filter((g) => !gc.hidden.has(g)).map(garageFacts);
  const ends = showEnds();
  const runsOf = (f) => `${f.runs.toLocaleString()} run${f.runs === 1 ? "" : "s"}`;

  // at a glance
  $("gcOverviewSub").textContent = ends ? "Runs, in-service trips, routes, and the first and last trip of the day for each garage."
    : "Runs with a trip leaving in this period, those trips, and the routes they run, for each garage.";
  $("gcOverview").innerHTML = `<thead><tr><th>Garage</th><th class="num">Runs</th><th class="num">In-service trips</th><th class="num">Routes</th>
    ${ends ? `<th>Earliest first trip</th><th>Latest last trip</th>` : ""}</tr></thead>
    <tbody>${list.map((f) => `<tr><td><span class="swatch" style="background:${garageColor(f.g)}"></span>${esc(f.g)}</td>
      <td class="num">${f.runs.toLocaleString()}</td><td class="num">${f.deps.length.toLocaleString()}</td><td class="num">${f.routes.length}</td>
      ${ends ? [f.first, f.last].map((d) => `<td>${d ? `${fmtLong(d.sec)} <span class="small">Route ${esc(d.route)} ${esc(dirName(d.row))} · run ${esc(d.run)}</span>` : "—"}</td>`).join("") : ""}</tr>`).join("")}
    <tr><td><strong>All</strong></td><td class="num"><strong>${list.reduce((a, f) => a + f.runs, 0).toLocaleString()}</strong></td>
      <td class="num"><strong>${list.reduce((a, f) => a + f.deps.length, 0).toLocaleString()}</strong></td>
      <td class="num"><strong>${new Set(list.flatMap((f) => f.routes)).size}</strong></td>${ends ? "<td></td><td></td>" : ""}</tr></tbody>`;

  // run types
  const typeNames = [...new Set(list.flatMap((f) => f.types.map((t) => t.type)))].sort((a, b) => DUTY_ORDER.indexOf(a) - DUTY_ORDER.indexOf(b));
  const typeColor = (t) => RUN_TYPE_COLORS[t] ?? ["var(--muted)", "#fff"];
  $("gcTypesLegend").innerHTML = legendOf(typeNames.map((t) => [dutyName(t), typeColor(t)[0]]));
  $("gcTypes").innerHTML = list.map((f) => gcStack(f.g, f.types.map((t) => ({ name: dutyName(t.type), n: t.runs, label: `${t.runs.toLocaleString()} runs`, bg: typeColor(t.type)[0], ink: typeColor(t.type)[1] })), runsOf(f))).join("");

  // swings
  const maxSw = Math.max(1, ...list.map((f) => pctOf(f.swings, f.runs)));
  $("gcSwings").innerHTML = list.map((f) => gcValue(f.g, pctOf(f.swings, f.runs), maxSw,
    `<strong>${pctOf(f.swings, f.runs)}%</strong> · ${f.swings.toLocaleString()} of ${runsOf(f)}`,
    f.types.map((t) => `${dutyName(t.type)}: ${t.swings} of ${t.runs} (${pctOf(t.swings, t.runs)}%)`).join("\n"))).join("");

  // routes served
  const maxR = Math.max(1, ...list.map((f) => f.routes.length));
  $("gcRoutes").innerHTML = list.map((f) => gcValue(f.g, f.routes.length, maxR,
    `<strong>${f.routes.length}</strong> route${f.routes.length === 1 ? "" : "s"} · ${f.shared.length} shared`,
    `${f.g}: ${f.routes.join(", ")}${f.shared.length ? `\nShared with another garage: ${f.shared.join(", ")}` : ""}`)).join("");

  // trip starts
  $("gcStartsLegend").innerHTML = legendOf(ORIGINS.map(([, name, , bg]) => [name, bg]));
  $("gcStarts").innerHTML = list.map((f) => gcStack(f.g, ORIGINS.map(([k, name, , bg, ink]) => ({ name, n: f.starts[k], label: `${f.starts[k].toLocaleString()} trips`, bg, ink })),
    `<span title="Trips that start with a pullout or after a deadhead on the same route">${f.deps.length.toLocaleString()} trips · <strong>${pctOf(f.starts.pullout + f.starts.deadheadSameRoute, f.deps.length)}%</strong> pullout/deadhead</span>`)).join("");

  // time use
  const tu = gc.tu?.garages ?? {};
  $("gcTimeLegend").innerHTML = legendOf(TIME_PARTS.map(([, name, , bg]) => [name, bg]));
  const plat = (t) => TIME_PARTS.reduce((a, [k]) => a + (t?.[k] ?? 0), 0);

  // efficiency: one bar per garage (0–100%), then the shown garages together
  const effTip = (name, t) => `${name}: ${hrs(t.service ?? 0)} in service of ${hrs(plat(t))} platform time\n` +
    TIME_PARTS.slice(1).map(([k, n]) => `${n}: ${hrs(t[k] ?? 0)} (${pctOf(t[k] ?? 0, plat(t))}%)`).join("\n");
  const together = list.reduce((a, f) => { for (const [k] of TIME_PARTS) a[k] = (a[k] ?? 0) + (tu[f.g]?.[k] ?? 0); return a; }, {});
  const best = Math.max(...list.map((f) => pctOf(tu[f.g]?.service ?? 0, plat(tu[f.g]))));
  $("gcEff").innerHTML = list.map((f) => { const t = tu[f.g] ?? {}, p = pctOf(t.service ?? 0, plat(t));
    return gcValue(f.g, p, 100, `<strong>${p}%</strong>${list.length > 1 && p === best ? " · highest" : ""}`, effTip(f.g, t)); }).join("") +
    (list.length > 1 ? `<div class="gc-row" title="${esc(effTip(list.length === all.length ? "All garages" : "Shown garages", together))}">
      <div class="lab"><strong>${list.length === all.length ? "All garages" : "Shown garages"}</strong></div>
      <div class="gc-track"><div style="width:${pctOf(together.service ?? 0, plat(together))}%;background:var(--ink-2)"></div></div>
      <div class="n"><strong>${pctOf(together.service ?? 0, plat(together))}%</strong></div></div>` : "");
  $("gcTime").innerHTML = list.map((f) => { const t = tu[f.g] ?? {};
    return gcStack(f.g, TIME_PARTS.map(([k, name, , bg, ink]) => ({ name, n: t[k] ?? 0, label: hrs(t[k] ?? 0), bg, ink })),
      `Service efficiency <strong>${pctOf(t.service ?? 0, plat(t))}%</strong>`); }).join("");
  $("gcTimeTable").innerHTML = `<thead><tr><th>Garage</th>${TIME_PARTS.map(([, name, what]) => `<th class="num" title="${esc(what)}">${name}</th>`).join("")}
      <th class="num">Platform</th><th class="num">Service efficiency</th>${ends ? `<th class="num">Paid</th><th class="num" title="In-service hours for every paid hour">In service per paid hour</th>` : ""}</tr></thead>
    <tbody>${list.map((f) => { const t = tu[f.g] ?? {}; const p = plat(t);
      return `<tr><td><span class="swatch" style="background:${garageColor(f.g)}"></span>${esc(f.g)}</td>
        ${TIME_PARTS.map(([k]) => `<td class="num">${hrs(t[k] ?? 0)} <span class="small">${pctOf(t[k] ?? 0, p)}%</span></td>`).join("")}
        <td class="num">${hrs(p)}</td><td class="num"><strong>${pctOf(t.service ?? 0, p)}%</strong></td>
        ${ends ? `<td class="num">${hrs(t.pay ?? 0)}</td><td class="num">${t.pay ? (Math.round((100 * t.service) / t.pay) / 100).toFixed(2) : "—"}</td>` : ""}</tr>`; }).join("")}</tbody>`;
  // hide a percentage that doesn't fit its block
  for (const d of $("garageView").querySelectorAll(".segbar > div")) { const sp = d.firstChild; if (sp.offsetWidth + 16 > d.clientWidth) sp.style.visibility = "hidden"; }
  fillCtx();
}
$("gcPick").addEventListener("change", (e) => {
  const g = e.target.dataset?.gc;
  if (!g) return;
  if (e.target.checked) gc.hidden.delete(g); else gc.hidden.add(g);
  renderGarages();
});
$("gcBtn").addEventListener("click", () => writeHash({ gview: true, fview: false, route: null, compare: null, garage: "All" }));
$("gcBack").addEventListener("click", () => writeHash({ gview: false }));


// --- garage animation (summary screen, one garage picked) ---
// Made when asked for; once made it follows the day / garage / period picked at the top.
const ganim = { player: null, key: null, loading: 0 };
const ganimKey = () => `${state.day}|${state.garage}|${state.period}`;
async function generateGarageAnimation() {
  const ticket = ++ganim.loading, key = ganimKey();
  ganim.player ??= AnimPlayer.create($("garageAnimPlayer"));
  $("garageAnimPlayer").classList.remove("hidden");
  $("garageAnimGo").textContent = "Regenerate";
  $("garageAnimStatus").textContent = `Loading ${state.garage}…`;
  try {
    const d = await ganim.player.load({ day: state.day, garage: state.garage, ...animWindow() });
    if (ticket !== ganim.loading) return;
    ganim.key = key;
    $("garageAnimStatus").textContent = `${state.day} · ${state.garage} · ${periodLabel()} · ${d.buses.length} bus${d.buses.length === 1 ? "" : "es"} on ${d.routes.length} routes` +
      (d.missingPaths.length ? ` · ${d.missingPaths.length} moves without a path (skipped)` : "");
  } catch (e) {
    if (ticket === ganim.loading) $("garageAnimStatus").textContent = `Couldn't load the animation: ${e.message}`;
  }
}
function syncGarageAnimation() {
  const one = state.garage !== "All";
  $("garageAnimCard").classList.toggle("hidden", !one);
  $("garageAnimTitle").textContent = one ? `${state.garage} Garage Animation` : "Garage Animation";
  if (!one) { ganim.player?.pause(); return; }
  if (ganim.key && ganim.key.split("|")[1] !== state.garage) { // another garage: start fresh
    ganim.key = null; ganim.player?.pause();
    $("garageAnimPlayer").classList.add("hidden"); $("garageAnimStatus").textContent = ""; $("garageAnimGo").textContent = "Generate animation";
  } else if (ganim.key && ganim.key !== ganimKey()) generateGarageAnimation(); // same garage, new day / period
}
$("garageAnimGo").addEventListener("click", generateGarageAnimation);

  return { loadTimeUse, renderGarages, generateGarageAnimation, syncGarageAnimation };
}
