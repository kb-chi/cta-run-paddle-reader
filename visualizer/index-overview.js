import { core } from "./index-core.js";

export function createOverview({ openRoute, syncGarageAnimation }) {
  const {
    $,
    state,
    viewRows,
    showEnds,
    pos,
    nextDay,
    fmt,
    fmtSpan,
    runTypesTile,
    esc,
    dirName,
    grouped,
    timeRange,
    el,
    periodLabel,
    tickEvery,
    tickLabel,
    ABBR,
    fitText,
    garageColor,
    runLabel,
    byGarageText,
    fmtLong,
    garageSort,
    garageLegend,
    showTip,
    hideTip,
    fillCtx,
  } = core;

// ---------- overview: tiles ----------
function renderTiles() {
  const rows = viewRows();
  if (!rows.length) { $("tiles").innerHTML = `<div class="card tile"><div class="label" data-ctx>No trips</div><div class="detail">No trips leave in this period.</div></div>`; return; }
  if (!showEnds()) { // a time period: no first / last trip figures
    const trips = rows.reduce((a, r) => a + r.trips, 0), routes = new Set(rows.map((r) => r.route)).size;
    const runs = new Set(rows.flatMap((r) => r.departures.map((d) => d.run))).size;
    const tile = (label, value, detail) => `<div class="card tile"><div class="label" data-ctx>${label}</div><div class="value">${value}</div><div class="detail">${detail}</div></div>`;
    const withFreq = rows.filter((r) => r.freq != null && r.trips >= 2);
    const best = withFreq.length ? withFreq.reduce((a, b) => (b.freq < a.freq ? b : a)) : null;
    $("tiles").innerHTML = tile("Runs with a trip then", runs.toLocaleString(), `${trips.toLocaleString()} in-service trips on ${routes} routes`) +
      runTypesTile(tile, rows.flatMap((r) => r.departures.map((d) => d.run))) +
      (best ? tile("Most frequent", `every ${best.freq} min`, `Route ${esc(best.route)} ${esc(dirName(best))}, ${best.trips} trips`) : "");
    return;
  }
  const earliest = rows.reduce((a, b) => (pos(b.first) < pos(a.first) ? b : a));
  const latest = rows.reduce((a, b) => (pos(b.last) > pos(a.last) ? b : a));
  const span = (r) => pos(r.last) - pos(r.first);
  const shortest = rows.reduce((a, b) => (span(b) < span(a) ? b : a));
  const routes = new Set(rows.map((r) => r.route)).size;
  const tile = (label, value, detail) => `<div class="card tile"><div class="label" data-ctx>${label}</div><div class="value">${value}</div><div class="detail">${detail}</div></div>`;
  const where = (r, t) => `Route ${esc(r.route)} ${esc(dirName(r))} · run ${esc(t.run)}${state.garage === "All" && t.garage ? " (" + esc(t.garage) + ")" : ""}`;
  const trips = rows.reduce((a, r) => a + r.trips, 0);
  const runs = state.period === "all" ? state.summary.runCount : new Set(rows.flatMap((r) => r.departures.map((d) => d.run))).size;
  $("tiles").innerHTML =
    tile(state.period === "all" ? "Runs · trips" : "Runs with a trip then", `${runs.toLocaleString()}`, `${trips.toLocaleString()} in-service trips on ${routes} routes`) +
    runTypesTile(tile, null) +
    tile("Earliest first trip", fmt(earliest.first), where(earliest, earliest.firstTrip)) +
    tile("Latest last trip", fmt(latest.last) + (state.clock === "12" && nextDay(latest.last) ? ' <span class="small">next day</span>' : ""), where(latest, latest.lastTrip)) +
    (state.period === "all"
      ? tile("Shortest service day", fmtSpan(span(shortest)), `Route ${esc(shortest.route)} ${esc(dirName(shortest))}, ${fmt(shortest.first)}–${fmt(shortest.last)}`)
      : (() => {
        const withFreq = rows.filter((r) => r.freq != null && r.trips >= 2);
        if (!withFreq.length) return "";
        const best = withFreq.reduce((a, b) => (b.freq < a.freq ? b : a));
        return tile("Most frequent", `every ${best.freq} min`, `Route ${esc(best.route)} ${esc(dirName(best))}, ${best.trips} trips`);
      })());
}

// ---------- overview: chart ----------
function renderChart() {
  const host = $("chart");
  host.innerHTML = "";
  const groups = grouped();
  if (!groups.length) return;
  const width = host.clientWidth || 900;
  const narrow = width < 640;
  const labelW = narrow ? 64 : 250, rightPad = narrow ? 44 : 56, leftPad = narrow ? 40 : 48;
  const rowH = 24, groupGap = 10, bar = 8, top = 26, tickY = 14;
  const height = top + groups.reduce((s, g) => s + g.rows.length * rowH + groupGap, 0) + 4;

  const [h0, h1] = timeRange(groups.flatMap((g) => g.rows));
  const x0 = labelW + leftPad, x1 = width - rightPad;
  const x = (s) => x0 + ((pos(s) - h0 * 3600) / ((h1 - h0) * 3600)) * (x1 - x0);

  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img",
    "aria-label": showEnds() ? `First and last trip times for each route and direction, ${periodLabel()}` : `Departures for each route and direction, ${periodLabel()}` }, host);

  const every = tickEvery((x1 - x0) / (h1 - h0));
  for (let hr = h0; hr <= h1; hr++) {
    const gx = x(hr * 3600);
    el("line", { x1: gx, x2: gx, y1: top - 6, y2: height - 4, class: hr % 24 === 0 ? "midnight" : "grid" }, svg);
    if (hr % every === 0) el("text", { x: gx, y: tickY, "text-anchor": "middle", class: "tick" }, svg).textContent = tickLabel(hr);
  }

  let y = top;
  groups.forEach((g, gi) => {
    if (gi > 0) el("line", { x1: 0, x2: width, y1: y - groupGap / 2, y2: y - groupGap / 2, class: "sep" }, svg);
    g.rows.forEach((r, ri) => {
      const cy = y + rowH / 2;
      const row = el("g", { class: "row" }, svg);
      el("rect", { x: 0, y, width, height: rowH, class: "hit", rx: 4 }, row);
      if (ri === 0) el("text", { x: 0, y: cy + 4, class: "route" }, row).textContent = g.route;
      const dirText = el("text", { x: narrow ? 34 : 44, y: cy + 4 }, row);
      if (narrow) dirText.textContent = ABBR[r.direction] ?? "";
      else {
        dirText.textContent = ABBR[r.direction] ?? dirName(r);
        fitText(dirText, labelW - 44 - 8);
      }
      const xa = x(r.first), xb = Math.max(x(r.last), xa + bar);
      el("rect", { x: xa, y: cy - bar / 2, width: xb - xa, height: bar, rx: bar / 2, class: "track" }, row);
      for (const dep of r.departures) el("circle", { cx: x(dep.sec), cy, r: 2, fill: garageColor(dep.garage) }, row);
      if (showEnds()) { // first / last trip: bigger dots and their times
        el("circle", { cx: xa, cy, r: 4, class: "dot", fill: garageColor(r.firstTrip.garage) }, row);
        el("circle", { cx: xb, cy, r: 4, class: "dot", fill: garageColor(r.lastTrip.garage) }, row);
        el("text", { x: xa - 8, y: cy + 4, "text-anchor": "end", class: "time" }, row).textContent = fmt(r.first, { short: true });
        el("text", { x: xb + 8, y: cy + 4, class: "time" }, row).textContent = fmt(r.last, { short: true });
      }

      row.addEventListener("mouseenter", () => row.classList.add("hover"));
      row.addEventListener("mouseleave", () => { row.classList.remove("hover"); hideTip(); });
      row.addEventListener("click", () => openRoute(r.route));
      row.addEventListener("mousemove", (ev) => {
        const box = svg.getBoundingClientRect();
        const px = ((ev.clientX - box.left) / box.width) * width;
        const at = h0 * 3600 + ((px - x0) / (x1 - x0)) * (h1 - h0) * 3600;
        let near = null;
        for (const dep of r.departures) if (!near || Math.abs(pos(dep.sec) - at) < Math.abs(pos(near.sec) - at)) near = dep;
        showTip(ev, rowTip(r, px >= xa - 12 && px <= xb + 12 ? near : null));
      });
      y += rowH;
    });
    y += groupGap;
  });
}

function rowTip(r, near) {
  const startNote = (t) => `<div class="note">from ${esc(t.from)}</div>`;
  const split = r.garages.length > 1 ? `<dt>Garages</dt><dd>${byGarageText(r.departures).map(([g, n]) => `<span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)} ${n}`).join(" &nbsp;")}</dd>` : "";
  return `
    <div class="t" style="margin-bottom:6px">Route ${esc(r.route)} · ${esc(dirName(r))}</div>
    <dl>
      ${showEnds() ? `<dt>First trip</dt><dd>${fmtLong(r.first)} · ${runLabel(r.firstTrip.run, r.firstTrip.garage)}${startNote(r.firstTrip)}</dd>
      <dt>Last trip</dt><dd>${fmtLong(r.last)} · ${runLabel(r.lastTrip.run, r.lastTrip.garage)}${startNote(r.lastTrip)}</dd>
      <dt>Span</dt><dd>${fmtSpan(pos(r.last) - pos(r.first))}</dd>` : ""}
      <dt>Trips</dt><dd>${r.trips}${state.period === "all" ? "" : ` <span class="small">${esc(periodLabel())}</span>`}</dd>
      ${split}
      <dt>Every</dt><dd>${r.freq == null ? "—" : r.freq + " min on average"}</dd>
      ${near ? `<dt>Nearest</dt><dd>${fmtLong(near.sec)} · ${runLabel(near.run, near.garage)}</dd>` : ""}
    </dl>
    <div class="note" style="margin-top:6px">Click for a closer look</div>`;
}

// ---------- overview: table ----------
function renderTable() {
  const rows = grouped().flatMap((g) => g.rows);
  const startCell = (sec, t, r) => `${fmtLong(sec)}<div class="small">run ${esc(t.run)}${state.garage === "All" && t.garage ? " · " + esc(t.garage) : ""} · from ${esc(t.from)}</div>`;
  const ends = showEnds();
  $("table").innerHTML = `
    <thead><tr><th>Route</th><th>Direction</th><th>Garage</th>${ends ? `<th>First trip</th><th>Last trip</th>
      <th class="num">Span</th>` : ""}<th class="num">Trips</th><th class="num">Avg. every</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><a href="#" data-route="${esc(r.route)}">${esc(r.route)}</a></td><td>${esc(dirName(r))}</td>
      <td>${byGarageText(r.departures).map(([g, n]) => `<div><span class="swatch" style="background:${garageColor(g)}"></span>${esc(g)}${r.garages.length > 1 ? ` <span class="small">${n}</span>` : ""}</div>`).join("")}</td>
      ${ends ? `<td>${startCell(r.first, r.firstTrip, r)}</td><td>${startCell(r.last, r.lastTrip, r)}</td>
      <td class="num">${fmtSpan(pos(r.last) - pos(r.first))}</td>` : ""}<td class="num">${r.trips}</td>
      <td class="num">${r.freq == null ? "—" : r.freq + " min"}</td></tr>`).join("")}</tbody>`;
  for (const a of $("table").querySelectorAll("a[data-route]")) a.addEventListener("click", (e) => { e.preventDefault(); openRoute(a.dataset.route); });
}


function renderOverview() {
  // first / last trip sorting and headings only for the whole day
  const ends = showEnds();
  for (const o of $("sortSelect").querySelectorAll("option[data-ends]")) { o.hidden = !ends; o.disabled = !ends; }
  $("sortSelect").value = ends ? state.sort : "route";
  $("chartTitle").textContent = ends ? "First and Last Trips By Route" : "Departures By Route";
  $("chartSub").textContent = ends ? "Each bar runs from a terminal's first departure to its last; dots are the departures, colored by garage. One row per direction."
    : "Dots are the departures in this period, colored by garage; the bar runs between them. One row per direction.";
  $("tableTitle").textContent = ends ? "First and Last Trips By Route" : "Trips By Route";
  $("tableSub").textContent = ends ? "Departure times of the first and last trip from each terminal. Click a route for a closer look."
    : "Trips leaving in this period and how often, from each terminal. Click a route for a closer look.";
  renderTiles();
  syncGarageAnimation();
  const garages = [...new Set(state.rows.flatMap((r) => r.garages))].sort(garageSort);
  for (const l of document.querySelectorAll(".garage-legend")) l.innerHTML = garageLegend(garages);
  $("chartCard").classList.toggle("hidden", state.view !== "chart");
  $("tableCard").classList.toggle("hidden", state.view !== "table");
  if (state.view === "chart") renderChart(); else renderTable();
  fillCtx();
}

  return { renderTiles, renderChart, renderTable, renderOverview };
}
