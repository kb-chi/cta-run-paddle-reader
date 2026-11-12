// Read a paddle routing note ("VIA 79th - I-94 EAST exit 95th - MICHIGAN - 99th into STATE") into the
// streets it names, in order, as keys that match OSM street names / refs (see streetKeys).

const TYPES = /\s+(street|st|avenue|ave|av|road|rd|boulevard|blvd|drive|dr|parkway|pkwy|place|pl|court|ct|lane|ln|way|terrace|ter|expressway|expy|highway|hwy)$/;
const DIRS = /^(north|south|east|west|n|s|e|w)\s+/;

// One normalization for both OSM names and note words, so they meet in the middle.
export function normName(s) {
  let x = s.toLowerCase().replace(/[.'’]/g, "").replace(/\bsaint\b/g, "st").replace(/\s+/g, " ").trim();
  x = x.replace(/^(lower|upper)\s+(north|south|east|west)\s+/, "$1 ").replace(/^(north|south|east|west)\s+(lower|upper)\s+/, "$2 ");
  const y = x.replace(TYPES, "");
  if (y) x = y;
  if (x.split(" ").length > 1) x = x.replace(DIRS, "");
  if (/^\d+$/.test(x)) x += ({ 1: "st", 2: "nd", 3: "rd" }[x.slice(-1)] && !/1\d$/.test(x) ? { 1: "st", 2: "nd", 3: "rd" }[x.slice(-1)] : "th");
  return x;
}

// What a street in OSM can be called: its normalized name, plus "i-94" style keys from its ref.
// OSM calls DuSable Lake Shore Drive several things ("North Jean Baptiste Point DuSable Lake Shore Drive",
// and on the south side still "South Lake Shore Drive"); the local street beside it ("North Lake Shore
// Drive", a secondary/tertiary street) is the paddles' INNER LAKE SHORE DR.
export function streetKeys(name, ref, highway = "") {
  const keys = new Set();
  if (name) {
    const n = normName(name);
    keys.add(n);
    const big = /^(motorway|trunk|primary)/.test(highway);
    if (/dusable lake shore/.test(n) || (n === "lake shore" && big)) keys.add(/^lower /.test(n) ? "lower dusable" : "dusable");
    else if (n === "lake shore" || n === "lower lake shore") keys.add(n === "lake shore" ? "inner lake shore" : "lower dusable");
    if (/martin luther king/.test(n)) keys.add("king");
  }
  for (const r of (ref ?? "").split(";")) { const m = r.trim().match(/^I[ -]?(\d+)$/i); if (m) keys.add(`i-${m[1]}`); }
  return [...keys];
}

// Misspellings found on the paddles, and other names for the same street.
const TYPOS = {
  kedize: "kedzie", colombus: "columbus", calirfornia: "california", monterrey: "monterey", haslted: "halsted",
  "conngress plaza": "congress plaza", desplains: "desplaines", dusablr: "dusable", "special olypmics": "special olympics",
  "south shor": "south shore", "midway plaisaince": "midway plaisance", "n midway plaisaince": "midway plaisance",
  "s midway plaisaince": "midway plaisance", "n midway plaisance": "midway plaisance", "s midway plaisance": "midway plaisance",
  "martin luther king": "king", "inner lake shore dr west": "inner lake shore",
};

// Note words → ordered street keys. Unknown words (landmarks, "stay right", "TERMINAL") are kept here;
// the caller drops the ones that match no street.
export function viaStreets(note) {
  if (!note) return [];
  const m = note.match(/\bVIA\b([\s\S]*)/i);
  if (!m) return [];
  let s = m[1]
    .split(/\\n|\n/)[0]
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(take recovery|first stop|stage on|allow any|enter route|do not)\b.*$/i, " ")
    .replace(/\bto\s+#?\d+.*$/i, " ");
  const parts = s.split(/\s+[-–]\s*|\s*[-–]\s+|\s+into\s+|\s+exit\s+|\s+enter\s+|\s+at\s+|\s+to\s+|\s+and\s+|\/|,|\s+-(?=[A-Za-z])/i);
  const out = [];
  for (let p of parts) {
    p = p.trim().replace(/^(immediate (left|right) onto|(north|south|east|west) on|at|exit|on|to|into|enter)\s+/i, "")
      .replace(/^(\d+)\s+(east|west|north|south)$/i, "I-$1") // "I-90/94 EAST" → I-90, I-94
      .replace(/\s+(into|to|exit)$/i, "")
      .replace(/\b(stay|keep)\s+(left|right)\b.*$/i, "").replace(/\bcontinue\b.*$/i, "").replace(/\b(take ramp down|immediately merge).*$/i, "")
      .replace(/\b(gate|terminal|loop road|loop|transit center|bus only lane)\b.*$/i, "").replace(/\b(eastbound|westbound|northbound|southbound)\b/i, "").trim();
    if (!p) continue;
    const ix = p.match(/^I-?\s?(\d+)/i);
    let key = ix ? `i-${ix[1]}` : normName(p);
    key = TYPOS[key] ?? key;
    if (key === "dusable" || key === "lake shore" || key === "dusable lake shore") key = "dusable";
    if (key === "lower dusable" || key === "lower dusable lake shore") key = "lower dusable";
    if (key === "inner lake shore") key = "inner lake shore";
    if (key === "wacker" || key === "upper wacker") key = "wacker";
    if (key === "95") key = "95th";
    if (out.at(-1) !== key) out.push(key);
  }
  return out;
}
