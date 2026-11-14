import { core } from "./index-core.js";
import { createOverview } from "./index-overview.js";
import { createRouteView } from "./index-route.js";
import { createGarageView } from "./index-garages.js";
import { createFactsView } from "./index-facts.js";

const {
  $,
  DAYS,
  state,
  usePeriods,
  PERIODS,
  PERIOD_SWAP,
  getJSON,
  periodLabel,
  routeOrder,
  esc,
  buildRows,
  hideTip,
  viewRows,
  sortDirs,
  loadRouteTime,
} = core;
// =====================================================================
// State, loading, controls
// =====================================================================
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const day = DAYS.includes(params.get("day")) ? params.get("day") : "Weekday";
  const period = params.get("period");
  usePeriods(day);
  const isValidPeriod = (key) => PERIODS.some((item) => item.key === key);
  const route = params.get("route");

  return {
    day,
    garage: params.get("garage") || "All",
    route: route || null,
    compare: route && params.get("compare") || null,
    gview: !route && params.get("view") === "garages",
    fview: !route && params.get("view") === "facts",
    period: isValidPeriod(period)
      ? period
      : isValidPeriod(PERIOD_SWAP[period])
        ? PERIOD_SWAP[period]
        : "all",
  };
}
function writeHash(next) {
  const nextState = {
    day: state.day,
    garage: state.garage,
    route: state.route,
    compare: state.compare,
    period: state.period,
    gview: state.gview,
    fview: state.fview,
    ...next,
  };
  if (nextState.route) nextState.gview = nextState.fview = false;
  if (next.gview) nextState.fview = false;
  if (next.fview) nextState.gview = false;
  if (nextState.gview) nextState.garage = "All";

  const params = new URLSearchParams({
    day: nextState.day,
    garage: nextState.garage,
  });
  if (nextState.gview) params.set("view", "garages");
  else if (nextState.fview) params.set("view", "facts");
  if (nextState.period !== "all") params.set("period", nextState.period);
  if (nextState.route) params.set("route", nextState.route);
  if (nextState.route && nextState.compare) params.set("compare", nextState.compare);

  const hash = `#${params}`;
  if (location.hash !== hash) location.hash = hash;
  else applyState();
}
function openRoute(route) { writeHash({ route }); }

const routeView = createRouteView({ writeHash });
const garageView = createGarageView({ writeHash });
const factsView = createFactsView({ writeHash, openRoute });
const overview = createOverview({ openRoute, syncGarageAnimation: garageView.syncGarageAnimation });

function showEmpty(msg) {
  $("content").classList.add("hidden");
  $("routeView").classList.add("hidden");
  $("garageView").classList.add("hidden");
  $("factsView").classList.add("hidden");
  $("empty").classList.remove("hidden");
  $("emptyMsg").innerHTML = esc(msg);
}

let applyTicket = 0;
async function applyState() {
  const ticket = ++applyTicket;
  const want = readHash();
  const info = state.days.find((d) => d.day === want.day);
  if (info && want.garage !== "All" && !info.garages.includes(want.garage)) want.garage = "All"; // e.g. no Forest Glen on Sunday
  Object.assign(state, want);
  // a period swapped for the day type (PM rush → Afternoon on Saturday): show the real one in the address
  const hp = new URLSearchParams(location.hash.slice(1));
  if ((hp.get("period") ?? "all") !== state.period) {
    if (state.period === "all") hp.delete("period"); else hp.set("period", state.period);
    history.replaceState(null, "", "#" + hp.toString());
  }
  // controls reflect the state
  document.querySelectorAll("[data-day]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.day === state.day)));
  $("garageSelect").innerHTML = `<option value="All">All garages</option>` +
    (info?.garages ?? []).map((g) => `<option ${g === state.garage ? "selected" : ""}>${esc(g)}</option>`).join("");
  $("garageSelect").value = state.garage;
  $("periodSelect").innerHTML = `<option value="all">All day</option>` + PERIODS.map((p) => `<option value="${p.key}">${p.short} (${p.span})</option>`).join("");
  $("periodSelect").value = state.period;
  hideTip();
  try {
    if (!state.summary || state.summary.day !== state.day || state.summary.garage !== state.garage) {
      showEmpty(`Loading ${state.day}${state.garage === "All" ? " for all garages" : " for " + state.garage}…`);
      const s = await getJSON(`api/summary?day=${encodeURIComponent(state.day)}&garage=${encodeURIComponent(state.garage)}`);
      if (ticket !== applyTicket) return;
      state.summary = s;
      state.rows = buildRows(s);
    }
    const s = state.summary;
    $("source").textContent = `${state.day} · ${state.garage === "All" ? "all garages" : state.garage} · ${periodLabel()} · ${s.runCount.toLocaleString()} runs from ${s.sources.length} paddle file${s.sources.length === 1 ? "" : "s"}`;
    const routes = [...new Set(state.rows.map((r) => r.route))].sort(routeOrder);
    if (state.route && !routes.includes(state.route)) state.route = null;
    if (state.compare && (!state.route || !routes.includes(state.compare))) state.compare = state.route ? routes.find((r) => r !== state.route) ?? null : null;
    state.routes = routes;
    $("routeList").innerHTML = routes.map((r) => `<option value="${esc(r)}"></option>`).join("");
    $("gotoSelect").value = state.route ?? "";
    document.querySelectorAll(".overview-only").forEach((e) => e.classList.toggle("hidden", !!state.route || state.gview || state.fview));
    $("garageCtl").classList.toggle("hidden", state.gview); // the comparison shows every garage
    for (const id of ["gcBtn", "factsBtn"]) $(id).classList.toggle("hidden", !!state.route || state.gview || state.fview);
    $("garageView").classList.toggle("hidden", !state.gview);
    $("factsView").classList.toggle("hidden", !state.fview);

    if (state.fview) {
      $("empty").classList.add("hidden"); $("content").classList.add("hidden"); $("routeView").classList.add("hidden");
      factsView.renderFacts();
      return;
    }

    if (state.gview) {
      showEmpty(`Comparing ${state.day} garages…`);
      await garageView.loadTimeUse();
      if (ticket !== applyTicket) return;
      $("empty").classList.add("hidden");
      $("garageView").classList.remove("hidden");
      garageView.renderGarages();
      return;
    }

    if (state.route) {
      // each side's route (data cached per day / garage / route by getJSON; the model per pane)
      const sides = state.compare ? [state.route, state.compare] : [state.route];
      const need = sides.filter((r, i) => { const p = routeView.panes[i]; return !p || p.key !== `${state.day}|${state.garage}|${r}`; });
      if (need.length) showEmpty(`Loading route ${need.join(" and ")}…`);
      const [datas, allSummary] = await Promise.all([
        Promise.all(sides.map((r) => getJSON(`api/route?day=${encodeURIComponent(state.day)}&garage=${encodeURIComponent(state.garage)}&route=${encodeURIComponent(r)}`))),
        // with one garage picked, the all-garages summary tells whether other garages run these routes too
        state.garage === "All" ? null : getJSON(`api/summary?day=${encodeURIComponent(state.day)}&garage=All`),
        // each route's platform time in the period, for the Service Efficiency card (shows its own error)
        loadRouteTime().catch(() => null),
      ]);
      if (ticket !== applyTicket) return;
      state.allSummary = allSummary;
      sides.forEach((r, i) => {
        const p = routeView.paneFor(i), key = `${state.day}|${state.garage}|${r}`;
        if (p.key !== key) { p.key = key; p.route = r; p.model = routeView.routeModel(r, datas[i]); }
      });
      routeView.fillPickers(routes);
      $("empty").classList.add("hidden");
      $("content").classList.add("hidden");
      $("routeView").classList.remove("hidden");
      routeView.renderRoute();
      return;
    }
    $("empty").classList.add("hidden");
    $("routeView").classList.add("hidden");
    $("content").classList.remove("hidden");
    overview.renderOverview();
  } catch (e) {
    if (ticket === applyTicket) showEmpty(`Couldn't load: ${e.message}`);
  }
}

function rerender() {
  if (!state.summary) return;
  hideTip();
  if (state.gview) {
    garageView.renderGarages();
  } else if (state.fview) {
    factsView.renderFacts();
  } else if (state.route && routeView.panes[0]?.model) {
    routeView.renderRoute();
  } else {
    overview.renderOverview();
  }
}

async function init() {
  try {
    state.days = await getJSON("api/days");
  } catch {
    return showEmpty("Start the visualizer with: npm run viz");
  }
  applyState();
}

function bindControls() {
  for (const button of document.querySelectorAll("[data-day]")) {
    button.addEventListener("click", () => writeHash({ day: button.dataset.day }));
  }

  $("garageSelect").addEventListener("change", (event) => writeHash({ garage: event.target.value }));
  $("gotoForm").addEventListener("submit", (event) => event.preventDefault());
  routeView.routeInput($("gotoSelect"), (route) => writeHash({ route }), () => state.route, { allowEmpty: true });
  $("backBtn").addEventListener("click", () => writeHash({ route: null, compare: null }));

  $("compareBtn").addEventListener("click", () => {
    const routes = state.routes ?? [];
    const currentIndex = routes.indexOf(state.route);
    const nextRoute = routes[(currentIndex + 1) % routes.length];
    writeHash({ compare: nextRoute !== state.route ? nextRoute : routes[0] });
  });
  $("singleBtn").addEventListener("click", () => writeHash({ compare: null }));

  $("sortSelect").addEventListener("change", (event) => {
    state.sort = event.target.value;
    rerender();
  });
  bindToggleGroup("data-clock", (button) => { state.clock = button.dataset.clock; });
  bindToggleGroup("data-view", (button) => { state.view = button.dataset.view; });
  $("periodSelect").addEventListener("change", (event) => writeHash({ period: event.target.value }));

  $("panes").addEventListener("click", handleZoomClick);
  window.addEventListener("hashchange", () => {
    applyState();
    window.scrollTo(0, 0);
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rerender, 150);
  });
}

function bindToggleGroup(attribute, updateState) {
  const selector = `[${attribute}]`;
  for (const button of document.querySelectorAll(selector)) {
    button.addEventListener("click", () => {
      updateState(button);
      for (const other of document.querySelectorAll(selector)) {
        other.setAttribute("aria-pressed", String(other === button));
      }
      rerender();
    });
  }
}

function handleZoomClick(event) {
  const button = event.target.closest("[data-zoom]");
  if (!button) return;

  state.zoom = Number(button.dataset.zoom);
  for (const other of $("panes").querySelectorAll("[data-zoom]")) {
    other.setAttribute("aria-pressed", String(Number(other.dataset.zoom) === state.zoom));
  }
  for (const pane of routeView.panes) {
    if (!pane?.model || !pane.el.isConnected) continue;
    const rows = viewRows().filter((row) => row.route === pane.route);
    routeView.renderGraphs(pane, pane.model, sortDirs(rows));
  }
}

bindControls();

init();
