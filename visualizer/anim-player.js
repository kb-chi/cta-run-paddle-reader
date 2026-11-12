// Route animation player, drawn in the browser (used by animate.html and each route page in index.html).
//
//   const player = AnimPlayer.create(containerElement);
//   await player.load({ day, route, garage, from, to });   // seconds, paddle time (25:00 = 1 AM next day)
//   player.exportGif({ size: 800 })                         // → Blob, made in the browser
//
// The server (/api/anim) only supplies what each bus does and the lines it follows; positions, the map,
// labels and the GIF are all made here. Rules:
//   - buses move evenly between time points, 3× as fast on expressways (the server's `eff` distances);
//   - in-service buses: run number, colored by direction (blue NB/EB, orange SB/WB), arrow when moving;
//   - pullouts / pull-ins: dark grey "G"; deadheads: light grey with the run number;
//   - "From 22" when a bus comes off another route, "To 151" when it leaves for one (about 3 s of watching);
//   - when the route is run by more than one garage, the second garage's buses are squares (third: diamonds).
(function () {
  "use strict";
  const COS = Math.cos((41.85 * Math.PI) / 180);
  const GARAGE_ORDER = ["North Park", "Kedzie", "Forest Glen", "Chicago", "74th", "77th", "103rd"];
  const SHAPES = ["circle", "square", "diamond"];
  const SPEEDS = [[30, "30×"], [60, "1 min / s"], [120, "2 min / s"], [300, "5 min / s"], [600, "10 min / s"]];

  const CSS = `
  .ap { --ap-land:#f4f3ef; --ap-water:#cfe0ee; --ap-park:#e3eedc; --ap-rail:#d3d1ca; --ap-res:#ebe8e1; --ap-street:#e2dfd7; --ap-major:#d2cec3; --ap-xway:#c2bcae;
    --ap-route:rgba(11,11,11,.28); --ap-a:#2a78d6; --ap-b:#eb6834; --ap-garage:#6f6e69; --ap-dead:#b9b7b0; --ap-pill:#fcfcfb; --ap-pill-ink:#0b0b0b;
    --ap-ring:#fff; --ap-callout:#0b0b0b; --ap-callout-ink:#fff; --ap-label:#52514e; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .ap { --ap-land:#161615; --ap-water:#1b2833; --ap-park:#18221a; --ap-rail:#2b2b29; --ap-res:#1e1e1d;
    --ap-street:#252523; --ap-major:#31302d; --ap-xway:#44423d; --ap-route:rgba(255,255,255,.30); --ap-a:#3987e5; --ap-b:#d95926; --ap-garage:#8a8984; --ap-dead:#55544f;
    --ap-pill:#1a1a19; --ap-pill-ink:#f0efec; --ap-ring:#0d0d0d; --ap-callout:#f0efec; --ap-callout-ink:#0b0b0b; --ap-label:#c3c2b7; } }
  :root[data-theme="dark"] .ap { --ap-land:#161615; --ap-water:#1b2833; --ap-park:#18221a; --ap-rail:#2b2b29; --ap-res:#1e1e1d;
    --ap-street:#252523; --ap-major:#31302d; --ap-xway:#44423d; --ap-route:rgba(255,255,255,.30); --ap-a:#3987e5; --ap-b:#d95926; --ap-garage:#8a8984; --ap-dead:#55544f;
    --ap-pill:#1a1a19; --ap-pill-ink:#f0efec; --ap-ring:#0d0d0d; --ap-callout:#f0efec; --ap-callout-ink:#0b0b0b; --ap-label:#c3c2b7; }
  .ap-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px 14px; margin-bottom:8px; }
  .ap-clock { font-size:24px; font-weight:600; font-variant-numeric:tabular-nums; min-width:6.2em; }
  .ap-scrub { flex:1; min-width:200px; accent-color:var(--accent); }
  .ap-play { min-width:5.5em; font-weight:600; }
  .ap-dim { color:var(--ink-2); font-variant-numeric:tabular-nums; }
  .ap-map { position:relative; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
  .ap-map canvas { display:block; width:100%; height:min(68vh,760px); min-height:340px; cursor:grab; touch-action:none; }
  .ap-map canvas.ap-drag { cursor:grabbing; }
  .ap-zoom { position:absolute; right:10px; top:10px; display:flex; flex-direction:column; gap:4px; }
  .ap-zoom button { width:34px; height:34px; padding:0; font-size:18px; line-height:1; box-shadow:var(--shadow); }
  .ap-tip { position:absolute; pointer-events:none; background:var(--surface); border:1px solid var(--border); border-radius:8px; box-shadow:var(--shadow);
    padding:8px 10px; font-size:13px; display:none; max-width:300px; z-index:2; }
  .ap-legend { display:flex; flex-wrap:wrap; gap:6px 18px; color:var(--ink-2); margin:10px 2px 0; align-items:center; }
  .ap-legend span { display:inline-flex; align-items:center; gap:6px; }
  .ap-legend svg { flex:none; }
  .ap-gif { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; margin-top:12px; }
  .ap-gif progress { width:160px; }
  .ap-note { color:var(--muted); margin:6px 2px 0; }
  @media (max-width:640px) { .ap-clock { font-size:20px; } }`;

  const fmtClock = (sec) => { const h = Math.floor(sec / 3600) % 24, m = Math.floor((sec % 3600) / 60); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`; };
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const garageRank = (g) => { const i = GARAGE_ORDER.indexOf(g); return i === -1 ? 99 : i; };

  // ------------------------------------------------------------ positions
  function pointAt(l, e) {
    const eff = l.eff, n = l.coords.length;
    if (e <= 0) return { p: l.coords[0], i: 0 };
    if (e >= eff[n - 1]) return { p: l.coords[n - 1], i: Math.max(0, n - 2) };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (eff[mid] <= e) lo = mid; else hi = mid; }
    const f = eff[hi] === eff[lo] ? 0 : (e - eff[lo]) / (eff[hi] - eff[lo]);
    const a = l.coords[lo], b = l.coords[hi];
    return { p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], i: lo };
  }
  const effAtTp = (l, k) => l.eff[l.ti[Math.min(k, l.ti.length - 1)]];
  function segPosition(s, t) {
    const kf = s.kf, l = s.line;
    if (t <= kf[0][0]) return pointAt(l, effAtTp(l, kf[0][1]));
    for (let j = 1; j < kf.length; j++) if (t <= kf[j][0]) {
      const [ta, ka] = kf[j - 1], [tb, kb] = kf[j], ea = effAtTp(l, ka), eb = effAtTp(l, kb);
      return pointAt(l, ea + (eb - ea) * (tb === ta ? 1 : (t - ta) / (tb - ta)));
    }
    return pointAt(l, effAtTp(l, kf.at(-1)[1]));
  }
  // where a bus is at time t and what it's doing (between moves it waits where the last one ended, styled as the next)
  function busState(b, t) {
    if (t < b.start || t > b.end) return null;
    const i = b.segs.findIndex((s) => t <= s.t1);
    const s = i === -1 ? b.segs.at(-1) : b.segs[i], moving = i !== -1 && t >= s.t0;
    const pos = segPosition(s, t), l = s.line, a = l.coords[pos.i], c = l.coords[Math.min(pos.i + 1, l.coords.length - 1)];
    return { s, moving, pos: pos.p, heading: Math.atan2(-(c[1] - a[1]), (c[0] - a[0]) * COS) };
  }

  // ------------------------------------------------------------ drawing (shared by the player and the GIF)
  function readColors(el) {
    const cs = getComputedStyle(el), v = (n) => cs.getPropertyValue(`--ap-${n}`).trim();
    return { land: v("land"), water: v("water"), park: v("park"), rail: v("rail"), res: v("res"), street: v("street"), major: v("major"), xway: v("xway"),
      route: v("route"), a: v("a"), b: v("b"), garage: v("garage"), dead: v("dead"), pill: v("pill"), pillInk: v("pill-ink"), ring: v("ring"),
      callout: v("callout"), calloutInk: v("callout-ink"), label: v("label") };
  }
  // view = { cx, cy, scale (px per degree latitude), w, h }
  const projector = (view) => ({ X: (lon) => (lon - view.cx) * COS * view.scale + view.w / 2, Y: (lat) => -(lat - view.cy) * view.scale + view.h / 2 });
  function drawBase(c, data, view, C, { residential = false } = {}) {
    const { X, Y } = projector(view), m = data.map;
    const trace = (pts) => { c.beginPath(); for (let i = 0; i < pts.length; i++) { const x = X(pts[i][0]), y = Y(pts[i][1]); if (i) c.lineTo(x, y); else c.moveTo(x, y); } };
    c.fillStyle = C.land; c.fillRect(0, 0, view.w, view.h);
    c.lineJoin = c.lineCap = "round";
    c.fillStyle = C.park; for (const p of m.parks) if (!p.inner) { trace(p.c); c.fill(); }
    c.fillStyle = C.land; for (const p of m.parks) if (p.inner) { trace(p.c); c.fill(); }
    c.fillStyle = C.water; for (const p of m.water) if (!p.inner) { trace(p.c); c.fill(); }
    c.fillStyle = C.land; for (const p of m.water) if (p.inner) { trace(p.c); c.fill(); }
    c.strokeStyle = C.rail; c.lineWidth = 1; c.setLineDash([4, 3]); for (const p of m.rail) { trace(p); c.stroke(); } c.setLineDash([]);
    const z = view.scale / 4000;
    const layers = [["tertiary", C.street, 1], ["secondary", C.major, 1.4], ["primary", C.major, 1.8], ["trunk", C.xway, 2.6], ["motorway", C.xway, 3]];
    if (residential || z > 3) layers.unshift(["minor", C.res, 0.8]);
    for (const [cls, color, w] of layers) {
      if (cls === "tertiary" && z < 0.9) continue;
      c.strokeStyle = color; c.lineWidth = w * Math.min(1.6, Math.max(0.7, z));
      for (const s of m.streets) if (s.h === cls) { trace(s.c); c.stroke(); }
    }
    c.strokeStyle = C.route; c.lineWidth = 3; for (const r of m.route) { trace(r); c.stroke(); }
    if (z > 2.2) { // main street names, skipping any that would overlap
      c.font = "11px system-ui, sans-serif"; c.fillStyle = C.label; c.textAlign = "center"; c.textBaseline = "alphabetic";
      const done = new Set(), boxes = [];
      for (const s of m.streets) {
        if (!/^(primary|secondary)$/.test(s.h) || !s.n || done.has(s.n) || s.c.length < 2) continue;
        const mid = s.c[Math.floor(s.c.length / 2)], x = X(mid[0]), y = Y(mid[1]);
        if (x < 30 || y < 30 || x > view.w - 30 || y > view.h - 30) continue;
        const text = s.n.replace(/^(North|South|East|West) /, "").replace(/^Jean Baptiste Point /, "");
        const w = c.measureText(text).width, b = { x: x - w / 2 - 6, y: y - 16, w: w + 12, h: 16 };
        if (boxes.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y)) continue;
        boxes.push(b); done.add(s.n); c.fillText(text, x, y - 4);
      }
    }
  }
  function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
  function marker(c, shape, x, y, r) {
    c.beginPath();
    if (shape === "square") c.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8);
    else if (shape === "diamond") { c.moveTo(x, y - r * 1.2); c.lineTo(x + r * 1.2, y); c.lineTo(x, y + r * 1.2); c.lineTo(x - r * 1.2, y); c.closePath(); }
    else c.arc(x, y, r, 0, Math.PI * 2);
  }
  // draws every bus at time T; returns what was drawn (for hover) and the counts
  function drawBuses(c, data, view, C, T, speed) {
    const { X, Y } = projector(view);
    const brief = Math.max(150, 3 * speed);
    const placed = [], drawn = [];
    const overlaps = (r) => placed.some((q) => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    const counts = { a: 0, b: 0, wait: 0, dead: 0, garage: 0 };
    const states = data.buses.map((b) => ({ b, st: busState(b, T) })).filter((x) => x.st).sort((p, q) => (p.st.s.kind === "trip") - (q.st.s.kind === "trip"));
    c.textBaseline = "middle"; c.textAlign = "center";
    const garageMode = data.mode === "garage";
    for (const { b, st } of states) {
      const k = st.s.kind;
      // second colour: southbound (or westbound); for a whole garage, any SB or WB trip
      const second = garageMode ? st.s.dir === "SB" || st.s.dir === "WB" : st.s.dir === data.dirPair[1];
      if (k === "trip") { if (st.moving) (second ? counts.b++ : counts.a++); else counts.wait++; } else if (k === "deadhead") counts.dead++; else counts.garage++;
      const x = X(st.pos[0]), y = Y(st.pos[1]);
      if (x < -60 || y < -60 || x > view.w + 60 || y > view.h + 60) continue;
      const garageMove = k === "pullout" || k === "pullin";
      const fill = garageMove ? C.garage : k === "deadhead" ? C.dead : second ? C.b : C.a;
      // label: G for the garage; otherwise the run number (for a whole garage, just its last 3 characters)
      const text = garageMove ? "G" : garageMode ? b.run.slice(-3) : b.run;
      const shape = data.shapeOf[b.garage] ?? "circle", r = k === "trip" ? 7 : 6;
      marker(c, shape, x, y, r + 2); c.fillStyle = C.ring; c.fill();
      marker(c, shape, x, y, r); c.fillStyle = fill; c.fill();
      if (st.moving) {
        c.save(); c.translate(x, y); c.rotate(st.heading);
        c.beginPath(); c.moveTo(r + 7, 0); c.lineTo(r + 2, -4); c.lineTo(r + 2, 4); c.closePath(); c.fillStyle = fill; c.fill(); c.restore();
      }
      c.font = "600 11px system-ui, sans-serif";
      const tw = c.measureText(text).width + 10, th = 17;
      const spots = [[r + 7, -th / 2], [-r - 7 - tw, -th / 2], [-tw / 2, -r - 7 - th], [-tw / 2, r + 7], [r + 7, -th * 1.5], [r + 7, th * 0.5]];
      let box = null;
      for (const [dx, dy] of spots) { const q = { x: x + dx, y: y + dy, w: tw, h: th }; if (!overlaps(q)) { box = q; break; } }
      box ??= { x: x + spots[0][0], y: y + spots[0][1], w: tw, h: th };
      placed.push(box);
      rrect(c, box.x, box.y, box.w, box.h, 4); c.fillStyle = C.pill; c.globalAlpha = 0.94; c.fill(); c.globalAlpha = 1;
      c.strokeStyle = fill; c.lineWidth = 1.5; c.stroke();
      c.fillStyle = C.pillInk; c.fillText(text, box.x + box.w / 2, box.y + box.h / 2 + 0.5);
      drawn.push({ b, st, x, y });
      const notes = [];
      if (b.fromRoute && T - b.start <= brief) notes.push(`From ${b.fromRoute}`);
      if (b.toRoute && b.lastTripEnd != null && T >= b.lastTripEnd && T - b.lastTripEnd <= brief) notes.push(`To ${b.toRoute}`);
      c.font = "600 12px system-ui, sans-serif";
      for (const n of notes) {
        const w = c.measureText(n).width + 14, h = 20;
        let q = { x: box.x, y: box.y - h - 4, w, h };
        if (overlaps(q)) q = { x: box.x, y: box.y + box.h + 4, w, h };
        placed.push(q);
        rrect(c, q.x, q.y, q.w, q.h, 10); c.fillStyle = C.callout; c.fill();
        c.fillStyle = C.calloutInk; c.fillText(n, q.x + q.w / 2, q.y + q.h / 2 + 0.5);
      }
    }
    return { drawn, counts };
  }
  // title, clock and legend drawn into GIF frames (the page has its own HTML ones)
  function drawFrameOverlay(c, data, view, C, T) {
    c.textBaseline = "alphabetic"; c.textAlign = "left";
    rrect(c, 12, 12, 210, 60, 8); c.fillStyle = C.pill; c.globalAlpha = 0.94; c.fill(); c.globalAlpha = 1;
    c.fillStyle = C.label; c.font = "12px system-ui, sans-serif";
    c.fillText(data.mode === "garage" ? `${data.title} · ${data.day}` : `Route ${data.route} · ${data.day}${data.garage && data.garage !== "All" ? " · " + data.garage : ""}`, 24, 30);
    c.fillStyle = C.pillInk; c.font = "600 24px system-ui, sans-serif"; c.fillText(fmtClock(T), 24, 56);
    const name = data.mode === "garage" ? { NB: "North / eastbound", SB: "South / westbound" } : { NB: "Northbound", SB: "Southbound", EB: "Eastbound", WB: "Westbound" };
    const items = [["circle", C.a, name[data.dirPair[0]]], ["circle", C.b, name[data.dirPair[1]]], ["circle", C.dead, "Deadhead"], ["circle", C.garage, "G  Garage"],
      ...data.garages.length > 1 ? data.garages.map((g) => [data.shapeOf[g], C.label, g]) : []];
    c.font = "12px system-ui, sans-serif";
    const lw = 16 + items.reduce((n, [, , t]) => n + c.measureText(t).width + 30, 0);
    rrect(c, 12, view.h - 40, lw, 28, 8); c.fillStyle = C.pill; c.globalAlpha = 0.94; c.fill(); c.globalAlpha = 1;
    let lx = 24;
    for (const [shape, col, t] of items) { marker(c, shape, lx + 5, view.h - 26, 5); c.fillStyle = col; c.fill(); c.fillStyle = C.label; c.fillText(t, lx + 14, view.h - 22); lx += c.measureText(t).width + 30; }
    c.textAlign = "right"; c.font = "10px system-ui, sans-serif"; c.fillStyle = C.label;
    c.fillText("© OpenStreetMap contributors · CTA GTFS", view.w - 8, view.h - 8);
  }

  // ------------------------------------------------------------ data
  function prepare(raw) {
    const data = raw;
    for (const b of data.buses) for (const s of b.segs) { s.t0 = s.kf[0][0]; s.t1 = s.kf.at(-1)[0]; s.line = data.lines[s.path]; }
    data.buses = data.buses.filter((b) => b.segs.every((s) => s.line));
    const dirs = new Set(data.buses.flatMap((b) => b.segs.filter((s) => s.dir).map((s) => s.dir)));
    data.dirPair = data.mode === "garage" ? ["NB", "SB"] : (dirs.has("NB") || dirs.has("SB")) ? ["NB", "SB"] : (dirs.has("EB") || dirs.has("WB")) ? ["EB", "WB"] : ["NB", "SB"];
    data.garages = [...new Set(data.buses.map((b) => b.garage))].sort((a, b) => garageRank(a) - garageRank(b));
    data.shapeOf = Object.fromEntries(data.garages.map((g, i) => [g, SHAPES[Math.min(i, SHAPES.length - 1)]]));
    // when there are trips: from the first bus on screen to the last one leaving
    data.first = Math.max(data.from, Math.min(...data.buses.map((b) => b.start)));
    data.last = Math.min(data.to, Math.max(...data.buses.map((b) => b.end)));
    return data;
  }

  // ------------------------------------------------------------ GIF (made in the browser with gifenc)
  let gifencP = null;
  const gifenc = () => (gifencP ??= import("./vendor/gifenc.esm.js"));
  async function makeGif(data, root, { view, from, to, speed, fps = 10, onProgress, signal, residential = true }) {
    const { GIFEncoder, quantize, applyPalette } = await gifenc();
    const C = readColors(root);
    const W = view.w, H = view.h;
    const bg = document.createElement("canvas"); bg.width = W; bg.height = H;
    drawBase(bg.getContext("2d"), data, view, C, { residential });
    const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    const c = cv.getContext("2d", { willReadFrequently: true });
    const frame = (T) => { c.drawImage(bg, 0, 0); drawBuses(c, data, view, C, T, speed); drawFrameOverlay(c, data, view, C, T); return c.getImageData(0, 0, W, H).data; };
    const step = speed / fps, delay = Math.round(1000 / fps);
    const times = []; for (let t = from; t <= to + 1e-6; t += step) times.push(t);
    // one palette from a few frames, then each frame stores only the pixels that changed
    const sample = new Uint8ClampedArray(W * H * 4 * 3);
    [0.1, 0.5, 0.85].forEach((f, i) => sample.set(frame(from + (to - from) * f), i * W * H * 4));
    const palette = quantize(sample, 255, { format: "rgb565" });
    const pal = palette.slice(), TRANSPARENT = palette.length; palette.push([255, 0, 255]);
    const gif = GIFEncoder();
    let prev = null;
    for (let n = 0; n < times.length; n++) {
      if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
      const idx = applyPalette(frame(times[n]), pal, "rgb565");
      let out = idx;
      if (prev) { out = new Uint8Array(idx.length); for (let i = 0; i < idx.length; i++) out[i] = idx[i] === prev[i] ? TRANSPARENT : idx[i]; }
      gif.writeFrame(out, W, H, { palette: n === 0 ? palette : undefined, delay: n === times.length - 1 ? 3000 : delay, transparent: n > 0, transparentIndex: TRANSPARENT, dispose: 1, repeat: 0 });
      prev = idx;
      onProgress?.((n + 1) / times.length);
      if (n % 4 === 0) await new Promise((r) => setTimeout(r, 0)); // let the page breathe
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: "image/gif" });
  }

  // ------------------------------------------------------------ player
  function create(container, { api = "api/anim" } = {}) {
    if (!document.getElementById("ap-style")) { const s = document.createElement("style"); s.id = "ap-style"; s.textContent = CSS; document.head.appendChild(s); }
    container.classList.add("ap");
    container.innerHTML = `
      <div class="ap-row">
        <button type="button" class="ap-play">▶ Play</button>
        <label class="ap-dim">Speed <select class="ap-speed">${SPEEDS.map(([v, t]) => `<option value="${v}" ${v === 60 ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <span class="ap-clock">--:--</span>
        <input type="range" class="ap-scrub" min="0" max="1" step="10" value="0" aria-label="Time">
      </div>
      <div class="ap-dim ap-counts" style="margin-bottom:8px">&nbsp;</div>
      <div class="ap-map"><canvas></canvas>
        <div class="ap-zoom"><button type="button" data-z="in" aria-label="Zoom in">+</button><button type="button" data-z="out" aria-label="Zoom out">−</button><button type="button" data-z="fit" aria-label="Fit route" style="font-size:13px">⤢</button></div>
        <div class="ap-tip"></div></div>
      <div class="ap-legend"></div>
      <div class="ap-gif">
        <label class="ap-dim">Framing <select class="ap-gif-frame"><option value="shown" selected>As shown on screen</option><option value="square">Square</option></select></label>
        <label class="ap-dim">GIF width <select class="ap-gif-size"><option value="600">600 px</option><option value="800" selected>800 px</option><option value="1000">1000 px</option></select></label>
        <label class="ap-dim">GIF speed <select class="ap-gif-speed">${SPEEDS.map(([v, t]) => `<option value="${v}" ${v === 300 ? "selected" : ""}>${t}</option>`).join("")}</select></label>
        <button type="button" class="ap-gif-go">Make GIF</button>
        <span class="ap-dim ap-gif-length"></span>
        <progress class="ap-gif-progress" max="1" value="0" hidden></progress>
        <span class="ap-dim ap-gif-status"></span>
      </div>
      <p class="ap-note">The GIF covers the whole time on the slider at its own speed. "As shown on screen" keeps exactly what the map shows now (where you've panned and zoomed, and its shape); "Square" takes a square around the middle of the map, top to bottom. Buses move evenly between time points, three times as fast on expressways. Map data © OpenStreetMap contributors; route lines from CTA GTFS.</p>`;
    const q = (s) => container.querySelector(s);
    const canvas = q("canvas"), ctx = canvas.getContext("2d");
    const st = { data: null, T: 0, playing: false, last: 0, view: { cx: -87.63, cy: 41.9, scale: 4000, w: 1, h: 1 }, base: null, C: null, drawn: [], gifAbort: null };
    const speed = () => +q(".ap-speed").value;

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      st.view.w = canvas.clientWidth; st.view.h = canvas.clientHeight;
      canvas.width = Math.round(st.view.w * dpr); canvas.height = Math.round(st.view.h * dpr);
      st.base = null; draw();
    }
    function fit() {
      if (!st.data) return;
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      const pts = st.data.map.route.length ? st.data.map.route.flat() : Object.values(st.data.lines).flatMap((l) => l.coords);
      for (const [x, y] of pts) { x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y); }
      st.view.cx = (x1 + x2) / 2; st.view.cy = (y1 + y2) / 2;
      st.view.scale = Math.min((st.view.w - 60) / (((x2 - x1) || 0.01) * COS), (st.view.h - 60) / ((y2 - y1) || 0.01));
      st.base = null; draw();
    }
    function draw() {
      if (!st.view.w) return;
      st.C ??= readColors(container);
      const dpr = window.devicePixelRatio || 1;
      if (!st.base) {
        st.base = document.createElement("canvas"); st.base.width = canvas.width; st.base.height = canvas.height;
        const b = st.base.getContext("2d"); b.scale(dpr, dpr);
        if (st.data) drawBase(b, st.data, st.view, st.C); else { b.fillStyle = st.C.land; b.fillRect(0, 0, st.view.w, st.view.h); }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(st.base, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      q(".ap-clock").textContent = st.data ? fmtClock(st.T) : "--:--";
      if (!st.data) return;
      const { drawn, counts } = drawBuses(ctx, st.data, st.view, st.C, st.T, speed());
      st.drawn = drawn;
      const [A, B] = st.data.mode === "garage" ? ["NB/EB", "SB/WB"] : st.data.dirPair;
      q(".ap-counts").textContent = `In service: ${counts.a + counts.b} (${counts.a} ${A}, ${counts.b} ${B}) · at a terminal: ${counts.wait} · deadheading: ${counts.dead} · to/from garage: ${counts.garage}`;
    }
    function legend() {
      const d = st.data, name = { NB: "Northbound", SB: "Southbound", EB: "Eastbound", WB: "Westbound" };
      const sw = (shape, color) => `<svg width="14" height="14" viewBox="-7 -7 14 14">${shape === "square" ? `<rect x="-5.4" y="-5.4" width="10.8" height="10.8" fill="${color}"/>` : shape === "diamond" ? `<path d="M0 -6.5 L6.5 0 L0 6.5 L-6.5 0Z" fill="${color}"/>` : `<circle r="6" fill="${color}"/>`}</svg>`;
      let html;
      if (d.mode === "garage") {
        html = `<span>${sw("circle", "var(--ap-a)")}Northbound or eastbound</span><span>${sw("circle", "var(--ap-b)")}Southbound or westbound</span>` +
          `<span>${sw("circle", "var(--ap-dead)")}Deadhead</span><span>${sw("circle", "var(--ap-garage)")}G: to / from the garage</span>` +
          `<span>Labels: last 3 characters of the run number (P530 → 530); hover a bus for its route and what it's doing</span>`;
      } else {
        html = `<span>${sw("circle", "var(--ap-a)")}${name[d.dirPair[0]]} (run number)</span><span>${sw("circle", "var(--ap-b)")}${name[d.dirPair[1]]} (run number)</span>` +
          `<span>${sw("circle", "var(--ap-dead)")}Deadhead (run number)</span><span>${sw("circle", "var(--ap-garage)")}G: to / from the garage</span>`;
        if (d.garages.length > 1) html += d.garages.map((g) => `<span>${sw(d.shapeOf[g], "var(--ink-2)")}${esc(g)}</span>`).join("");
        html += `<span>“From 22” / “To 151”: comes off / goes on to another route</span>`;
      }
      q(".ap-legend").innerHTML = html;
    }
    function setPlaying(on) { st.playing = on; q(".ap-play").textContent = on ? "❚❚ Pause" : "▶ Play"; if (on) { st.last = performance.now(); requestAnimationFrame(tick); } }
    function tick(now) {
      if (!st.playing || !st.data) return;
      st.T += Math.min(0.25, (now - st.last) / 1000) * speed(); st.last = now;
      const end = +q(".ap-scrub").max;
      if (st.T >= end) { st.T = end; setPlaying(false); }
      q(".ap-scrub").value = st.T; draw();
      if (st.playing) requestAnimationFrame(tick);
    }
    q(".ap-play").onclick = () => { if (!st.data) return; if (st.T >= +q(".ap-scrub").max) st.T = +q(".ap-scrub").min; setPlaying(!st.playing); };
    q(".ap-scrub").oninput = () => { st.T = +q(".ap-scrub").value; draw(); };
    q(".ap-speed").onchange = draw;
    function zoomAt(f, px, py) {
      const v = st.view, lon = v.cx + (px - v.w / 2) / (COS * v.scale), lat = v.cy - (py - v.h / 2) / v.scale;
      v.scale = Math.max(800, Math.min(400000, v.scale * f));
      v.cx = lon - (px - v.w / 2) / (COS * v.scale); v.cy = lat + (py - v.h / 2) / v.scale;
      st.base = null; draw();
    }
    canvas.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.25 : 0.8, e.offsetX, e.offsetY); }, { passive: false });
    container.querySelectorAll("[data-z]").forEach((b) => b.onclick = () => b.dataset.z === "fit" ? fit() : zoomAt(b.dataset.z === "in" ? 1.5 : 1 / 1.5, st.view.w / 2, st.view.h / 2));
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, cx: st.view.cx, cy: st.view.cy }; canvas.setPointerCapture(e.pointerId); canvas.classList.add("ap-drag"); });
    canvas.addEventListener("pointermove", (e) => {
      if (drag) { st.view.cx = drag.cx - (e.clientX - drag.x) / (COS * st.view.scale); st.view.cy = drag.cy + (e.clientY - drag.y) / st.view.scale; st.base = null; draw(); q(".ap-tip").style.display = "none"; return; }
      hover(e.offsetX, e.offsetY);
    });
    canvas.addEventListener("pointerup", () => { drag = null; canvas.classList.remove("ap-drag"); });
    canvas.addEventListener("pointerleave", () => { q(".ap-tip").style.display = "none"; });
    function hover(px, py) {
      let best = null, bd = 14;
      for (const d of st.drawn) { const dd = Math.hypot(d.x - px, d.y - py); if (dd < bd) { bd = dd; best = d; } }
      const tip = q(".ap-tip");
      if (!best) { tip.style.display = "none"; return; }
      const { b, st: s } = best, k = s.s.kind;
      const what = k === "trip" ? `Route ${s.s.route ?? st.data.route} ${s.s.dir}${s.moving ? "" : s.s.wait ? ` (waiting at terminal: ${esc(s.s.wait)})` : " (waiting at terminal)"}`
        : k === "pullout" ? "Pulling out of the garage" : k === "pullin" ? "Pulling in to the garage" : `Deadhead (out of service)${s.s.label ? ": " + esc(s.s.label) : ""}`;
      const from = b.fromRoute ? `from route ${b.fromRoute}` : b.startsByRelief ? "starts by relief" : "", to = b.toRoute ? `then route ${b.toRoute}` : b.endsByRelief ? "ends by relief" : "";
      tip.innerHTML = `<b>Run ${esc(b.run)}</b> <span class="ap-dim">${esc(b.garage)}, half ${b.half}</span><br>${what}<br><span class="ap-dim">On screen ${fmtClock(b.start)}–${fmtClock(b.end)}${from || to ? " · " + [from, to].filter(Boolean).join(", ") : ""}</span>`;
      tip.style.display = "block";
      tip.style.left = Math.min(px + 14, st.view.w - tip.offsetWidth - 8) + "px"; tip.style.top = (py + 14) + "px";
    }
    // GIF
    q(".ap-gif-go").onclick = async () => {
      if (!st.data) return;
      if (st.gifAbort) { st.gifAbort.abort(); return; }
      const size = +q(".ap-gif-size").value;
      // "as shown": exactly the map's current extent and shape, scaled to the chosen width;
      // "square": a square around the map's middle, as tall as the map view
      const view = q(".ap-gif-frame").value === "shown"
        ? { cx: st.view.cx, cy: st.view.cy, scale: st.view.scale * (size / st.view.w), w: size, h: Math.round(size * st.view.h / st.view.w / 2) * 2 }
        : { cx: st.view.cx, cy: st.view.cy, scale: st.view.scale * (size / st.view.h), w: size, h: size };
      const from = +q(".ap-scrub").min, to = +q(".ap-scrub").max, gifSpeed = +q(".ap-gif-speed").value;
      const prog = q(".ap-gif-progress"), status = q(".ap-gif-status"), btn = q(".ap-gif-go");
      st.gifAbort = new AbortController();
      setPlaying(false);
      prog.hidden = false; prog.value = 0; btn.textContent = "Stop"; status.textContent = "Making GIF…";
      try {
        const blob = await makeGif(st.data, container, { view, from, to, speed: gifSpeed, residential: q(".ap-gif-frame").value !== "shown" || st.view.scale / 4000 > 3, signal: st.gifAbort.signal, onProgress: (f) => { prog.value = f; } });
        const url = URL.createObjectURL(blob);
        const who = st.data.mode === "garage" ? `${st.data.garage.toLowerCase().replace(/\s+/g, "-")}-garage` : `route-${st.data.route}`;
        const name = `${who}-${st.data.day.toLowerCase()}-${fmtFile(from)}-${fmtFile(to)}.gif`;
        status.innerHTML = `<a href="${url}" download="${esc(name)}">Download ${esc(name)}</a> (${view.w} × ${view.h}, ${(blob.size / 1e6).toFixed(1)} MB, ${Math.round((to - from) / gifSpeed)} s)`;
        const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
      } catch (e) {
        status.textContent = e.name === "AbortError" ? "Stopped." : `Couldn't make the GIF: ${e.message}`;
      } finally { st.gifAbort = null; prog.hidden = true; btn.textContent = "Make GIF"; }
    };
    const gifLength = () => {
      if (!st.data) { q(".ap-gif-length").textContent = ""; return; }
      const s = Math.round((+q(".ap-scrub").max - +q(".ap-scrub").min) / +q(".ap-gif-speed").value);
      q(".ap-gif-length").textContent = `${s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`} long, ${s * 10} frames`;
    };
    q(".ap-gif-speed").onchange = gifLength;
    const fmtFile = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;

    new ResizeObserver(() => { if (canvas.clientWidth && (canvas.clientWidth !== st.view.w || canvas.clientHeight !== st.view.h)) resize(); }).observe(canvas);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { st.C = null; st.base = null; draw(); });

    return {
      // load one route for a time window; returns the data (with .buses) or throws
      // night: true = one night on one clock (like the visualizer's Overnight period): runs that start before
      // 6 AM at the start of the service day are moved 24 hours later, next to the late-night ones (23:00 → 30:00).
      // route omitted = every bus from `garage` on every route
      async load({ day, route = null, garage = "All", from, to, night = false }) {
        setPlaying(false);
        const url = route
          ? `${api}?day=${encodeURIComponent(day)}&route=${encodeURIComponent(route)}&garage=${encodeURIComponent(garage)}&from=${night ? 0 : from}&to=${to}`
          : `${api}-garage?day=${encodeURIComponent(day)}&garage=${encodeURIComponent(garage)}&from=${night ? 0 : from}&to=${to}`;
        const r = await fetch(url, { cache: "no-store" });
        const raw = await r.json();
        if (!r.ok || raw.error) throw new Error(raw.error || r.statusText);
        if (night) {
          const D = 24 * 3600, early = 6 * 3600;
          for (const b of raw.buses) if (b.start < early) {
            b.start += D; b.end += D; if (b.lastTripEnd != null) b.lastTripEnd += D;
            for (const s of b.segs) for (const k of s.kf) k[0] += D;
          }
          raw.buses = raw.buses.filter((b) => b.end >= from && b.start <= to);
          raw.from = from; raw.to = to;
        }
        raw.garage = garage;
        st.data = prepare(raw);
        const lo = st.data.buses.length ? st.data.first : from, hi = st.data.buses.length ? st.data.last : to;
        Object.assign(q(".ap-scrub"), { min: lo, max: hi, value: lo });
        st.T = lo;
        if (!st.view.w || st.view.w < 2) resize();
        legend(); fit(); draw(); gifLength();
        q(".ap-gif-status").textContent = "";
        return st.data;
      },
      play: () => setPlaying(true), pause: () => setPlaying(false),
      setTime(t) { st.T = t; q(".ap-scrub").value = t; draw(); },
      get data() { return st.data; },
      get view() { return st.view; },
      redraw() { st.C = null; st.base = null; draw(); },
    };
  }

  window.AnimPlayer = { create, makeGif, busState };
})();
