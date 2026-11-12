# CTA Run Paddle Reader

See how CTA bus service is actually scheduled to operate, built from the CTA's own operator schedules rather than the public timetable.

CTA's public GTFS feed tells you when and where buses stop. It doesn't tell you how the service is put together: which bus does which trip, when one operator hands a bus off to another, or how buses get to and from the garage and between routes. That information is in the **run paddles**: the schedule sheets each bus operator works from, one per run. This project reads those paddles and turns them into data and visualizations, showing:

- **Reliefs (operator hand-offs).** When and where one operator takes a bus over from another, at a terminal or mid-route, and which run takes over.
- **Deadheads, pullouts and pull-ins.** When buses run out of service, between the garage and the route or from the end of one route to the start of another, and which streets they take. The streets come from the paddles' own "VIA" notes.
- **How each trip begins.** Leaving the garage, coming off another route, turning around at a terminal, or deadheading back to the start.
- **Buses actually in service.** How many buses are on each route by hour, counting a bus handed between operators only once, plus first and last trips, headways and frequency for each route and direction.
- **Runs and pay.** Each run's halves, swings, report times and pay, with pay recalculated from its parts rather than copied from the paddle.

## What's included

This repository comes loaded with the **Summer 2026** paddles for all seven CTA bus garages: North Park, Kedzie, Forest Glen, Chicago, 74th, 77th and 103rd. That covers Weekday, Saturday and Sunday service. The paddles were obtained through a FOIA request. They're included both as the original PDFs (`Summer 2026 Runs/`) and already parsed (`Weekday Parsed/`, `Saturday Parsed/`, `Sunday Parsed/`). The map data and animation paths are also pre-built, so everything works right after `npm install`, with no build step.

The reader works on any CTA run paddles in the same format (HASTUS "cscr60", one run per page). To look at another pick (another season's service), parse its PDFs into those folders and rebuild the animation paths. Both steps are described below.

## What you can do with it

- **Browse summary statistics.** A local web page shows the first and last trips, departures and frequency for every route, for any day type and time period. You can look at all garages together or one at a time.
- **Explore a route.** For each route: where its trips come from, headways by hour, the most buses on the route at once, and string graphs of every trip. Mid-route reliefs are marked, and lines are colored by garage. Two routes can be compared side by side.
- **Animate scheduled service.** Watch buses move on a map, either for one route or for every bus from one garage, over any time window. Pullouts and pull-ins, deadheads and moves to other routes are all shown. Animations can be exported as GIFs.
- **Get the data itself.** Every run is saved as structured JSON with its trips, time points (with coordinates), reliefs, notes and statistics, ready for your own analysis.

Everything can be filtered **route by route** or **garage by garage**.

## Install and run (with the Summer 2026 data)

1. Install **Node.js 22.13 or newer** from <https://nodejs.org> (the LTS version is fine), and [Git](https://git-scm.com) if you don't already have it.
2. Download the project and install its two packages:

   ```
   git clone https://github.com/kb-chi/cta-run-paddle-reader.git
   cd cta-run-paddle-reader
   npm install
   ```

   (Or use **Code → Download ZIP** on GitHub, unzip it, and run `npm install` in that folder.)
3. Start the visualizer:

   ```
   npm run viz
   ```

4. Open <http://localhost:5280> in your browser. The page opens on all weekday runs from every garage. Use the controls at the top to pick the day, garage and time period. Click a route for its details and animation, or pick one garage to animate that garage's buses. The route animation page is at <http://localhost:5280/animate.html>.

Stop the server with Ctrl+C in the terminal. Nothing is sent anywhere: the server runs only on your computer.

## Adding new paddles

To load a different pick (another season), or to replace a garage's paddles:

1. **Parse each PDF.** Do one garage and one day type at a time, writing the output into that day's folder:

   ```
   node read-paddles.js "path/to/North_Park_Weekday.pdf" -o "Weekday Parsed/North Park Weekday Runs Parsed.json"
   ```

   - Without `-o`, the file is named from the garage and day printed on the paddles and saved in the current folder; move it into `Weekday Parsed/`, `Saturday Parsed/` or `Sunday Parsed/`.
   - A garage's paddles split across several PDFs can be given together, as long as they're all the same garage and day type.
   - The PDFs must be the originals with real text. A scanned paddle, or one saved with "Print to PDF", is a picture and can't be read.
   - The visualizer reads **every** `... Runs Parsed.json` file in those folders. When loading a new pick, delete or move the old season's files first, or the two will be combined.

2. **Check the problems list.** Each output file ends with a `problems` list: anything the reader couldn't understand, printed pay that doesn't match the calculated pay, and time-point names it doesn't know.
   - For an unknown time point (`Location "XYZ" is not in locations.js`), add it to `LOCATIONS` in `locations.js`, e.g. `"FOSTER WESTRN": X("Foster Ave", "Western Ave")`. Add its coordinates to `COORDS` in the same file, e.g. `"FOSTER WESTRN": { lat: 41.9759, lon: -87.6891, gtfsStopIds: [] }`.
   - Then parse the PDF again. A time point without coordinates is still listed, but it can't be placed on the map or in the animations.

3. **Update the route lines (if routes changed).** `CTA GTFS/route-shapes.json` holds the summer 2026 route lines. If the new pick reroutes or adds routes:
   - Download [CTA's GTFS feed](https://www.transitchicago.com/downloads/sch_data/google_transit.zip).
   - Put its `shapes.txt`, `trips.txt` and `routes.txt` into `CTA GTFS/`.
   - Run `node "CTA GTFS/make-route-shapes.mjs"`.

   Routes missing from the feed (summer-only service, for example) fall back to OpenStreetMap lines and streets.

4. **Update the street map (optional).** If streets have changed, run `node osm/fetch.mjs .` (about 3 minutes) and then `node osm/compact.mjs .`.

5. **Rebuild the animation paths.** This is needed whenever the parsed runs change:

   ```
   node animation/build-paths.mjs
   ```

   This takes a few minutes. It works out the line every trip and out-of-service move follows, using the paddles' "VIA" notes. If a note names a street the matcher doesn't recognize (often a misspelling on the paddle), add the correction to `animation/via.js`.

6. **Restart the visualizer** (Ctrl+C, then `npm run viz`). A re-parsed file is picked up on the next page load, but new animation paths are only read when the server starts.

Data sources: CTA run paddles (Summer 2026, via FOIA); CTA GTFS (route lines and stop locations); map data © OpenStreetMap contributors, ODbL.

---

# Reference

## Setup (once)

1. Install **Node.js 22.13 or newer** from <https://nodejs.org> (the "LTS" version is fine).
2. Open a terminal in this folder and run:

   ```
   npm install
   ```

## Read paddles

Read one day type at a time (Weekday, Saturday or Sunday):

```
node read-paddles.js North_Park_Saturday.pdf
```

This saves **"North Park Saturday Runs Parsed.json"**, named from the garage and day on the paddles. Use `-o other-name.json` to pick a different name. If you give several PDFs, they must all be the same garage and day type; mixing them is refused.

The PDFs must contain real text (the original files). A paddle saved with "Print to PDF" is a picture and can't be read.

## See the results (visualizer)

```
npm run viz
```

Then open <http://localhost:5280>. It opens on **all weekday runs from every garage**. At the top, pick **Weekday / Saturday / Sunday** and a **Garage** (or All garages). The data comes from the **Weekday Parsed**, **Saturday Parsed** and **Sunday Parsed** folders: the server joins every garage's file for that day and recomputes the statistics with `run.js`, so a route run by more than one garage (like the 49: North Park and 74th) is one route. Each garage has its own color (North Park blue, Kedzie orange, Forest Glen aqua, Chicago yellow, 74th pink, 77th green, 103rd violet), used for departures, trips and run labels. Re-reading a paddle into one of those folders is picked up on the next page load.

The summary shows **first and last trips by route**: one bar per direction, from the first departure to the last, with a dot for each departure in its garage's color, and the run count, earliest first trip, latest last trip and shortest service day at the top. Sort by route, earliest first trip, latest last trip or longest span; switch between 24-hour paddle time (25:01 = 1:01 AM next day) and 12-hour time; hover a bar for the runs, trips per garage and average frequency, or switch to **Table**. Directions (NB / SB / EB / WB) are worked out from the terminals' coordinates.

**Click a route** (or pick one from the Route list) for a closer look:
- first and last trip (a route whose last trip leaves after 2 AM and whose first leaves before 4 AM — e.g. the 22, 49, 79 — shows "24/7 route" instead). The N5 is marked "Overnight circulator" instead and keeps its first and last trips (night-only routes like it are listed in `OVERNIGHT_CIRCULATORS` in `visualizer/index.html`), trip count (and trips per garage when it's shared), short trips and all-day frequency in each direction
- where trips start from (pullout, deadhead on the same route, from another route, turn around), one bar per direction (from each departure's `start`)
- average headway by hour in each direction (average minutes from each departure that hour to the next), with the most buses on the route at once
- two string graphs, one per direction: one line per trip, time left to right, stops top to bottom spaced by distance. Short trips (starting or ending short of a terminal, like 146s from Montrose & Marine) are drawn like any other trip, with a dot where they start or end. A trip split by a mid-route relief (RN / RS / RE / RW) is joined back into one line, with a ring where the relief happens. Lines are colored by garage. Zoom 1×–8× and scroll sideways; both graphs scroll together. Hover a line for its runs, garage and times.

**Time period** (top of the page) filters everything to the trips that leave in one period: All day (the default), Overnight 11 PM–6 AM, AM rush 6–9 AM, Midday 9 AM–3 PM, PM rush 3–6:30 PM or Evening 6:30–11 PM. The charts zoom to that period's hours, and trip counts, average headway, trip starts, headway by hour and the string graphs only count those trips. First and last trip figures are shown only for All day: with a period picked, the summary tiles, the chart's first/last times and end dots, the tooltip and table's First trip / Last trip / Span, the first/last/span sort options and the route page's First trip / Last trip are left out, and the timelines show just that period's departures. Average headway is still measured to the next departure even if that one falls in the next period. Overnight shows one night on one axis (11 PM → 6 AM), with trips before 6 AM placed after midnight.

**Garage animation:** on the summary screen, picking one garage shows a **Garage animation** section: **Generate animation** shows every bus from that garage, on every route, for the day and time period picked at the top (and follows them when they change). To keep it readable, buses are labelled only with the last 3 characters of the run number (P530 → "530"), or "G" when pulling out or in; in service they're blue northbound / eastbound, orange southbound / westbound, and grey when deadheading. Hovering a bus shows its run, route and direction, and for a deadhead or a route change at a terminal, where it's coming from and going to (e.g. "NB 151 → NB 147"). Same player, speeds and GIF export as the route animations. The map shows main streets only (a garage covers a big area).

**Compare two routes:** on a route's page, **Compare with another route** splits the page into two halves side by side (stacked on a narrow screen), each with its own **Route** picker at the top of its half; the day, garage, time period, clock and string-graph zoom at the top apply to both. The right half starts with the next route in the list. The animation is hidden while comparing; **← Single route view** goes back to one route (the left one). The address keeps both routes (e.g. `#day=Weekday&garage=All&route=49&compare=147`).

**Animation on each route page:** at the bottom of a route's page, **Generate animation** shows that route's buses on a map for the day, garage and Time period picked at the top (All day = the whole service day; Overnight = one night, 11 PM → 6 AM, with the early-morning runs placed after midnight). Once generated it follows those choices: changing the period, day or garage reloads it. **Make GIF** saves the whole animation (the whole period, at its own speed — 5 min / s by default) as a GIF 600, 800 or 1000 px wide. Framing **As shown on screen** (the default) keeps exactly what the map shows when you press it — where you've panned and zoomed, and the map's shape; **Square** takes a square around the middle of the map. Everything is drawn and the GIF is made in the browser (`visualizer/anim-player.js`, with the `gifenc` package); the server only sends what each bus does.

**Route animation page** (<http://localhost:5280/animate.html>, or the link at the top of the visualizer): the same player with its own pickers for day, garage, route and any time window (or a period such as PM rush 3–6:30 PM), then Show and Play. Every bus that runs the route in that window moves on a map along the paths from `animation/paths.json` (build them first with `node animation/build-paths.mjs`):
- in-service buses are labelled with their run number and colored by direction (blue northbound / eastbound, orange southbound / westbound), with an arrow for the way they're heading;
- pullouts and pull-ins are dark grey, labelled **G**; deadheads are light grey with the run number;
- when a route is run by more than one garage, the first garage's buses (in the order North Park, Kedzie, Forest Glen, Chicago, 74th, 77th, 103rd) are circles and the second's are squares (a third's would be diamonds) — e.g. the 49: North Park circles, 74th squares;
- a bus that comes off another route shows "From 22" briefly when it appears, and "To 151" when it finishes its last trip on this route and leaves for another one; the deadhead to or from that route is shown too;
- between time points buses move evenly, three times as fast on expressways (OSM motorway / trunk, e.g. DuSable Lake Shore Dr) as on streets.

Speed (30× to 10 min per second), a time slider, pan and zoom, and hover for a bus's run, garage and what it's doing. The address keeps the day, route and window (e.g. `animate.html#day=Weekday&route=147&from=15:00&to=18:30`).

The page's address includes the day, garage and route (e.g. `#day=Weekday&garage=All&route=49`), so the browser's back button and bookmarks work.

## Map data (OpenStreetMap)

The `osm` folder holds OpenStreetMap data for the service area (every paddle location plus about 1 km: 41.637–42.074 N, 87.895–87.515 W), for the animations. © OpenStreetMap contributors, ODbL.
- `streets.json` — every drivable street (motorway down to residential, busways, and service roads other than alleys, driveways and parking aisles): class, name, one-way, bus-only, OSM node ids (ways that share a node id connect) and coordinates.
- `bus-routes.json` — CTA bus routes mapped in OSM (route relations): one ordered line per route variant (e.g. 28 Olive-Harvey → Union Station), with its stops.
- `basemap.json` — the lakefront, water, rivers, named parks, rail and L lines, and city limits.
- `raw/` — the Overpass downloads these were made from (not in the repository; `fetch.mjs` makes them).

To download fresh data: `node osm/fetch.mjs .` (about 3 minutes), then `node osm/compact.mjs .`.

**Route lines from CTA GTFS.** `CTA GTFS/route-shapes.json` has every bus route's shapes from the CTA GTFS feed (`shapes.txt`, `trips.txt`, `routes.txt` in that folder): for each shape its direction, headsign, how many scheduled trips use it, and its points as `[lon, lat, feet along the line]`. The raw feed files aren't in the repository; to rebuild, put `shapes.txt`, `trips.txt` and `routes.txt` from [CTA's GTFS feed](https://www.transitchicago.com/downloads/sch_data/google_transit.zip) in that folder and run `node "CTA GTFS/make-route-shapes.mjs"` (a newer feed will have newer route lines than summer 2026's). The feed is the regular schedule, so summer-only pieces (route 130, beach extensions of the 35, 63, 72 and 78) and some 2026 changes (9 / X9 to 95th & Beverly and Ravenswood Metra, 31 to Lake Meadows, 135 to Wilson & Clarendon) aren't in it; OSM's `bus-routes.json` has the 35, 63, 78 and 130 versions.

## Bus paths for the animations

```
node animation/build-paths.mjs
```

This reads every parsed run (all three days) and writes `animation/paths.json`: one line for each distinct movement a bus makes, plus how far along it each time point is (`at`, in meters), so a bus can be placed by time between its time points.
- **In-service trips** (key `route|time point>time point>…`) use a CTA GTFS shape of the route that passes every time point in order; if none does, an OSM route line. If neither fits the whole trip (summer extensions like the 9 to Ravenswood Metra or the 72 to North Avenue Beach), each hop between time points uses a route line if one fits that hop, and otherwise OSM streets.
- **Pullouts, pull-ins and deadheads** (key `deadhead|from>to|note`) follow the streets in their paddle note: "VIA 79th - I-94 EAST exit 95th - MICHIGAN - 99th into STATE" goes along 79th, then I-94, then 95th, Michigan, 99th and State, in that order, choosing the best place to turn from each street onto the next. `via` lists the streets it matched. Words that aren't streets (gates, terminals, "stay right", landmarks) are skipped, and common misspellings on the paddles (KEDIZE, COLOMBUS, HASLTED…) are corrected (`animation/via.js`). A move printed with no note takes the route most often noted for the same start and end (e.g. a Howard → North Park Garage pull-in with no note still goes Howard - Western - Foster; `borrowedNote` shows which); only a move no paddle notes at all takes the quickest street route, preferring main streets. One-way streets are obeyed. After rebuilding, restart the visualizer server so it picks up the new paths.

## What's in the output file

At the top, `statistics` totals the day's runs. For the first trip after taking over a bus by relief, it depends on the relief: a plain "R" relief (at a terminal) counts like any other trip; a directional relief (RN / RS / RE / RW, mid-route) is left out of the trip totals and trip starts (the trip is already counted on the run that started it). `inServiceTrips`, `inServiceTripsByRoute` (count per route), `pullouts` (halves that start with a pullout), `swings` (swing runs), `blocks` (Duty Type Block) and `pto` (Duty Type PTO). By route:
- `tripStartsByRoute` — how each in-service trip starts, as a count and percent: `pullout` (first trip after leaving the garage), `deadheadSameRoute` (after an out-of-service move, previous trip on the same route), `fromOtherRoute` (previous trip on a different route), `turnAround` (right after another trip on the same route, or the first trip after taking over a bus by a plain "R" relief at a terminal).
- `busesInServiceByRouteByHour` — for each hour ("05:00" … "25:00"), how many buses have an in-service trip on that route during that hour (any part of the hour). A bus is followed through its reliefs, so a bus handed from one run to another counts once. A bus that does several trips in the hour also counts once. A bus finishing its last trip and another starting its first in the same hour both count.
- `peakBusesByRouteByHour` — for each hour, the most buses on that route at the same moment. A bus is on the route from the start of a trip to the end of its last trip in a row on that route, so layovers between back-to-back trips count; time before it moves to another route, or after its last trip, doesn't. Never more than `busesInServiceByRouteByHour` for the same hour.
- `directionsByRoute` — for each terminal the route runs from: `toward` (the other terminal), `trips`, `firstTrip` and `lastTrip` (`time`, `run`, and `from`, where that trip actually starts) and `averageFrequency` (minutes between departures: first to last departure ÷ (trips − 1)). The terminals are the route's two most common trip start points among places that are really ends of the line: a place other trips pass through (a middle time point on at least 20% as many trips as start or end there) is a short-line point, not a terminal — so the 28's terminals are Olive-Harvey and Union Station, not the busy 47th & Lake Park short line. A trip that starts short of a terminal (a pullout or short turn) goes in the direction it travels, so `from` can name a mid-route point. Uses the same trips as `inServiceTripsByRoute`.

```js
{
  createdAt: "...",
  sources: [ { file: "North_Park_Saturday.pdf", pages: 291, runs: 291 } ],
  runCount: 291,
  runs: [ /* one run object per run, plus source: "<pdf file name>" */ ],
  duplicatePages: [ /* pages that repeat the page before them exactly, skipped: { source, page, sameAsPage, run } */ ],
  discardedPages: [ /* a page with a relief that has no run number, left out because the same run is on another page: { source, page, run, keptPage, reason } */ ],
  locations: { /* every time-point name used, with type, readable name, geocoder query, lat/lon and CTA stop IDs */ },
  problems: [ /* anything the reader couldn't understand: { source, page, run, message } */ ]
}
```

A blank Duty Type is stored as "Regular".

Each run follows the shape described at the top of `run.js`: number, swing yes/no (a double line between the halves on the paddle), garage (from the run number's first letter: P North Park, K Kedzie, 5 Chicago, 1 103rd, 6 74th, 7 77th), day, day tag (e.g. "Wed Only", "M-U-T-F" — M Mon, U Tue, W Wed, T Thu, F Fri) and the operating days it gives, effective date, report time, pay boxes, notes legend, and two halves (or one, for straight runs). Each half has how it starts (pullout or relief), its trips, and how it ends (relief or pull-in). Each trip has in-service yes/no, route, leader/follower, headway (`headwayAhead` / `headwayBehind`, in minutes), and its time points. A leader or follower marked "*" on the paddle changes mid-run: its `changesMidRun` is the run that takes it over (found from that run's relief), otherwise `false`. If that number isn't one of these paddles' runs on the same route at that time (most likely another garage's run), it is `"error"`.

**Pay is calculated, not copied from the paddle** (the printed Pay can be wrong): first half + second half + allowance + spread + Sunday pay. Sunday pay isn't printed anywhere; it is 0h30 for Sunday runs whose Duty Type is Regular (printed blank) or Block, and 0h00 for everything else — including any run with a fallback (X), whatever its Duty Type. The printed Pay is kept as `printedPay` for reference, and runs where it differs from the calculated Pay are listed under `problems`.

Relief direction comes from RN / RS / RE / RW (Northbound, Southbound, Eastbound, Westbound); a plain "R" is stored as "Terminal".

A relief printed with no run number (e.g. "R 06:11") is likely a printing error. If the same run is printed on another page, that version is left out (see `discardedPages`); if it is the only copy, it is kept and listed under `problems`.

Each half has a `thruWorkTime`: Half End minus Plat End (usually a minute or two). "THRU WORK", "THRU WORK 1st HALF" and "THRU WORK 2nd HALF" lines are checked against Half End.

Each time point shows the readable location from `locations.js`, e.g. `{ "time": "06:27:00", "location": "Belmont Ave & California Ave", "type": "intersection", "lat": …, "lon": … }`. Half start/end points and relief "headed to" names are converted the same way. The top-level `locations` section lists the table itself, keyed by the paddle's original names.

In the output file, every duration (pay boxes, Working, in-service / out-of-service travel, recovery, thru work) is written as "H:MM:SS", e.g. `"recoveryTime": "1:19:30"`.

Times are 24-hour "HH:MM:SS". A "+" on the paddle means 30 seconds, so 04:30 is stored as 04:30:00 and 04:30+ as 04:30:30. Times after midnight keep counting past 24:00, so 00:01 is stored as 24:01:00 and 01:01 as 25:01:00.

Each half's platform time is split three ways (hours, minutes, seconds), and each run has the totals:
- `inServiceTravel` — length of the in-service trips
- `outOfServiceTravel` — length of pullouts, pull-ins and deadheads
- `recoveryTime` — every gap between trips, plus the wait between a starting relief and the first trip and between the last trip and an ending relief

The three add up exactly to Plat Start → Plat End. The printed Plat Time rounds Plat Start down and Plat End up to whole minutes, so it can be up to a minute more.

## Files

| File | What it does |
|---|---|
| `run.js` | The run object structure and helper functions (durations, times, headway, relief) |
| `pdf-text.js` | Pulls text and its position on the page out of a PDF |
| `paddle-parser.js` | Turns one paddle page into a run object |
| `read-paddles.js` | The command you run: reads PDFs, writes "[Garage] [Day] Runs Parsed.json" |
| `locations.js`, `locations-gtfs.js` | What each time-point name means (street names, station, landmark) and its coordinates from CTA's GTFS stops |
| `example-p001.js` | Run P001 entered by hand, used to check the reader |
| `tests/` | Tests — run with `npm test` |
| `Summer 2026 Runs/` | The original paddle PDFs |
| `Weekday Parsed/`, `Saturday Parsed/`, `Sunday Parsed/` | The parsed runs, one file per garage, which the visualizer reads |
| `visualizer/` | The visualizer page (`index.html`), the animation player (`anim-player.js`, `animate.html`) and the server that combines the parsed files and serves them (`serve.js`, `anim.js`; run with `npm run viz`) |
| `animation/` | Builds `paths.json`, the line each bus movement follows (`build-paths.mjs`, `via.js`) |
| `osm/` | OpenStreetMap streets, route lines and base map, and the scripts that download and compact them |
| `CTA GTFS/` | Route lines from CTA's GTFS feed (`route-shapes.json`) and the script that makes them |
