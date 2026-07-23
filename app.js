/* Settlement-change viewer — vanilla-JS glue over MapLibre GL + PMTiles.
 * Responsibilities (docs/viewer_design.md §6): register the pmtiles protocol,
 * build the map from the committed style.json, drive the period switch by
 * styling signed presence-change surfaces into a zoom-aware pyramid in the browser,
 * fly to example places, keep all
 * view state in the URL hash. No build step, no framework.
 *
 * National evidence, including a 50 km border buffer, is fetched as sparse
 * PMTiles from public GCS. Tile RGB is data (loss/gain/stable), not colour:
 * the custom evidence protocol applies the current browser theme before
 * MapLibre receives each raster tile. */

"use strict";

// ---- palette (mirrors style.css / docs §4), theme-aware ----
// The map background/lines/ramp are set from JS because a MapLibre style is
// static JSON and can't follow prefers-color-scheme; the CSS chrome follows
// the same OS signal, so the two stay in step. Stable/small change is a warm
// brown, visually separate from empty land and from the rust/teal endpoints.
const THEME = {
  light: {
    land: "#EFEDE3", admin: "#B7BAAC", rust: "#BC4F25", neutral: "#78563E", teal: "#2E7E72", underlay: "#60442F", mixed: "#78563E",
    water: "#D9DCD6", coast: "#C4C7BC", river: "#8FB4BE", box: "#646A60"
  },
  dark: {
    land: "#141714", admin: "#3A3F38", rust: "#E06B3B", neutral: "#8A6248", teal: "#4AA894", underlay: "#76533C", mixed: "#8A6248",
    water: "#0E1512", coast: "#2C332E", river: "#3E5A61", box: "#9BA294"
  },
};
const themeQuery = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (themeQuery.matches ? THEME.dark : THEME.light);

// ---- data source: immutable public release, raw evidence styled below ----
const TILE_RELEASE_URL =
  "https://storage.googleapis.com/south-sudan-buildings-tiles/releases/2026-07-ssd-obt-buffer50-z14-v1/tiles";

// ---- periods: each immutable archive shares the same RGB evidence contract ----
const PERIODS = {
  war: { label: "War 2016→18", from: "p2016", to: "p2018", archive: "war.pmtiles" },
  post: { label: "Post-agreement 2019→23", from: "p2019", to: "p2023", archive: "post.pmtiles" },
};
const DEFAULT_PERIOD = "war";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HOME = { center: [29.7, 7.9], zoom: 5.2 };
const HOME_BOUNDS = [[22.9863167, 3.0423830], [36.3971901, 12.6861457]];

const state = { period: DEFAULT_PERIOD, example: null };
let evidenceState = null;
let mapReady = false;

// Begin fetching page data immediately, in parallel with MapLibre's style and
// source work. The map only consumes these promises once it is ready to add
// markers or layers, so data latency never sits on the map's load event.
const examplesData = fetch("data/examples.json").then((response) => response.json());
const townsData = fetch("data/towns.geojson").then((response) => response.json());

/* -------------------------------------------------------------------------- */
/* Map                                                                        */
/* -------------------------------------------------------------------------- */
if (window.pmtiles && window.maplibregl) {
  const archives = new Map(Object.entries(PERIODS).map(([period, spec]) => [
    period, new pmtiles.PMTiles(`${TILE_RELEASE_URL}/${spec.archive}`),
  ]));
  const styledCache = new Map();

  Object.keys(PERIODS).forEach((period) => {
    maplibregl.addProtocol(`evidence-${period}`, async (params, abortController) => {
      const match = params.url.match(/^evidence-(?:war|post):\/\/tiles\/(\d+)\/(\d+)\/(\d+)/);
      if (!match) throw new Error(`invalid evidence URL: ${params.url}`);
      const [, z, x, y] = match;
      const themeName = themeQuery.matches ? "dark" : "light";
      const cacheKey = `${period}/${z}/${x}/${y}/${themeName}`;
      if (styledCache.has(cacheKey)) return { data: styledCache.get(cacheKey) };
      const response = await archives.get(period).getZxy(
        Number(z), Number(x), Number(y), abortController.signal);
      if (!response) return { data: null };
      const data = await styleEvidenceTile(response.data, Number(z));
      styledCache.set(cacheKey, data);
      if (styledCache.size > 256) styledCache.delete(styledCache.keys().next().value);
      return { data, cacheControl: response.cacheControl, expires: response.expires };
    });
  });
}

const fromHash = readHash();
if (fromHash && PERIODS[fromHash.period]) state.period = fromHash.period;
if (fromHash && fromHash.example) state.example = fromHash.example;

const map = new maplibregl.Map({
  container: "map",
  style: "style.json",
  center: fromHash ? fromHash.center : HOME.center,
  zoom: fromHash ? fromHash.zoom : HOME.zoom,
  // Zoom-out stops once Africa fills the frame (context only — where South
  // Sudan sits in the continent; other continents are out of scope). The
  // bounds hug Africa, so maxBounds is what actually halts zoom-out and
  // keeps panning on the continent; minZoom is just a hard floor behind it.
  minZoom: 2.2,
  maxZoom: 14.5,
  maxBounds: [[-26, -36], [57, 38]],
  attributionControl: false,
  hash: false,            // we manage the hash ourselves (it also carries period)
  dragRotate: false,
  pitchWithRotate: false,
});

map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: [
    "Building change © Google Open Buildings Temporal (CC BY 4.0)",
    "Boundaries & rivers © Natural Earth",
  ],
}), "bottom-right");

// Attribution: sit it below the zoom controls, collapsed by default (the ⓘ
// toggles it). MapLibre adds it above the nav group and starts it open, so
// move it to the end of the corner stack and clear the open state.
(() => {
  const corner = map.getContainer().querySelector(".maplibregl-ctrl-bottom-right");
  const attrib = corner && corner.querySelector(".maplibregl-ctrl-attrib");
  if (!attrib) return;
  corner.appendChild(attrib);
  attrib.removeAttribute("open");
  attrib.classList.remove("maplibregl-compact-show");
})();

map.on("load", () => {
  mapReady = true;
  if (!fromHash) map.fitBounds(HOME_BOUNDS, { padding: 32, duration: 0 });
  applyTheme();                 // sets background/lines/underlay + ramp (calls applyPeriod)
  loadEvidence(state.period);
  loadTowns();
  ensurePlaceBoxes();           // examples.json may already be in (fetch races the style)
  if (state.example) selectExample(state.example, { instant: true });
  writeHash();
});

map.on("moveend", writeHash);
map.on("error", (e) => console.warn("map error:", e && e.error ? e.error.message : e));

// Follow the OS light/dark preference at runtime (matches the CSS chrome).
themeQuery.addEventListener("change", () => { if (mapReady) applyTheme(); });

function applyTheme() {
  const t = theme();
  if (map.getLayer("background")) map.setPaintProperty("background", "background-color", t.land);
  if (map.getLayer("africa-mask")) map.setPaintProperty("africa-mask", "fill-color", t.water);
  if (map.getLayer("africa-coast")) map.setPaintProperty("africa-coast", "line-color", t.coast);
  if (map.getLayer("admin-land")) map.setPaintProperty("admin-land", "line-color", t.admin);
  if (map.getLayer("admin-disputed")) map.setPaintProperty("admin-disputed", "line-color", t.admin);
  if (map.getLayer("rivers")) map.setPaintProperty("rivers", "line-color", t.river);
  if (map.getLayer("place-box-glow")) map.setPaintProperty("place-box-glow", "line-color", t.box);
  if (map.getLayer("place-box-line")) map.setPaintProperty("place-box-line", "line-color", t.box);
  applyPeriod(state.period, { silent: true });   // ramp endpoints are theme-dependent
  loadEvidence(state.period);                     // recolour cached raw evidence for the new theme
  map.triggerRepaint();                          // force a full redraw (avoid partial repaint on slow first paint)
}

async function canvasPngBytes(canvas) {
  const blob = await new Promise((resolve, reject) => canvas.toBlob(
    (value) => value ? resolve(value) : reject(new Error("PNG encoding failed")), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

function hexRgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function changeAlphaFloor(zoom) {
  if (zoom <= 5) return 30;
  if (zoom <= 10) return 45;
  return ({ 11: 95, 12: 180, 13: 210, 14: 255 }[zoom] || 255);
}

// Overview pixels aggregate many z14 cells. At national zooms, tiny nonzero
// aggregate values otherwise turn nearly every settlement red or green. Treat
// weak overview density as neutral context; detail zooms retain every changed
// cell from the evidence archive.
function minimumSignedEvidence(zoom) {
  if (zoom <= 5) return 128;
  if (zoom <= 6) return 96;
  if (zoom <= 8) return 72;
  if (zoom <= 10) return 36;
  return 1;
}

function stableAlphaFloor(zoom) {
  if (zoom <= 10) return 45;
  return ({ 11: 70, 12: 90, 13: 115, 14: 145 }[zoom] || 145);
}

// The B channel also contains scattered low-density building evidence. Hide
// that noise at overview zooms so brown means a credible settlement
// concentration, not simply "at least one source cell somewhere in this
// aggregate".
function minimumStableEvidence(zoom) {
  if (zoom <= 5) return 128;
  if (zoom <= 6) return 64;
  if (zoom <= 8) return 32;
  if (zoom <= 10) return 12;
  return 1;
}

function changeHaloStyle(zoom) {
  if (zoom >= 14) return { radius: 2, alpha: 205 };
  if (zoom >= 13) return { radius: 1, alpha: 180 };
  if (zoom >= 12) return { radius: 1, alpha: 155 };
  return null;
}

async function styleEvidenceTile(rawBytes, zoom) {
  const bitmap = await createImageBitmap(new Blob([rawBytes], { type: "image/webp" }));
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const t = theme();
  const rust = hexRgb(t.rust), teal = hexRgb(t.teal);
  const mixed = hexRgb(t.mixed), stableColour = hexRgb(t.underlay);
  const haloStyle = changeHaloStyle(zoom);
  const signedEvidenceFloor = minimumSignedEvidence(zoom);
  const stableEvidenceFloor = minimumStableEvidence(zoom);
  let haloLoss = null, haloGain = null;
  if (haloStyle) {
    const pixelCount = canvas.width * canvas.height;
    haloLoss = new Uint8Array(pixelCount);
    haloGain = new Uint8Array(pixelCount);
    for (let sourcePixel = 0; sourcePixel < pixelCount; sourcePixel += 1) {
      const sourceOffset = sourcePixel * 4;
      const loss = image.data[sourceOffset];
      const gain = image.data[sourceOffset + 1];
      if (!loss && !gain) continue;
      const sourceX = sourcePixel % canvas.width;
      const sourceY = Math.floor(sourcePixel / canvas.width);
      for (let dy = -haloStyle.radius; dy <= haloStyle.radius; dy += 1) {
        const targetY = sourceY + dy;
        if (targetY < 0 || targetY >= canvas.height) continue;
        for (let dx = -haloStyle.radius; dx <= haloStyle.radius; dx += 1) {
          const targetX = sourceX + dx;
          if (targetX < 0 || targetX >= canvas.width) continue;
          const targetPixel = targetY * canvas.width + targetX;
          haloLoss[targetPixel] = Math.max(haloLoss[targetPixel], loss);
          haloGain[targetPixel] = Math.max(haloGain[targetPixel], gain);
        }
      }
    }
  }
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const loss = image.data[offset], gain = image.data[offset + 1];
    const stable = image.data[offset + 2];
    const pixel = offset / 4;
    const shownLoss = loss || (haloLoss && haloLoss[pixel]) || 0;
    const shownGain = gain || (haloGain && haloGain[pixel]) || 0;
    const strongestSignedEvidence = Math.max(shownLoss, shownGain);
    if (strongestSignedEvidence >= signedEvidenceFloor) {
      const colour = shownLoss === shownGain ? mixed : shownLoss > shownGain ? rust : teal;
      const floor = changeAlphaFloor(zoom);
      const evidence = strongestSignedEvidence / 255;
      const isHalo = !loss && !gain;
      image.data[offset] = colour[0];
      image.data[offset + 1] = colour[1];
      image.data[offset + 2] = colour[2];
      image.data[offset + 3] = isHalo
        ? Math.round(haloStyle.alpha + (220 - haloStyle.alpha) * evidence)
        : Math.round(floor + (255 - floor) * evidence);
    } else if (stable >= stableEvidenceFloor) {
      const floor = stableAlphaFloor(zoom);
      const evidence = stable / 255;
      image.data[offset] = stableColour[0];
      image.data[offset + 1] = stableColour[1];
      image.data[offset + 2] = stableColour[2];
      image.data[offset + 3] = Math.round(floor + (170 - floor) * evidence);
    } else {
      image.data[offset + 3] = 0;
    }
  }
  context.putImageData(image, 0, 0);
  return canvasPngBytes(canvas);
}

function loadEvidence(period) {
  if (!mapReady || !PERIODS[period]) return;
  const themeName = themeQuery.matches ? "dark" : "light";
  if (evidenceState && evidenceState.period === period && evidenceState.theme === themeName) return;

  if (evidenceState && evidenceState.theme !== themeName) {
    if (map.getLayer("building-evidence")) map.removeLayer("building-evidence");
    Object.keys(PERIODS).forEach((key) => {
      const prewarmId = `building-evidence-prewarm-${key}`;
      const sourceId = `building-evidence-source-${key}`;
      if (map.getLayer(prewarmId)) map.removeLayer(prewarmId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    });
  }

  Object.keys(PERIODS).forEach((key) => {
    const sourceId = `building-evidence-source-${key}`;
    const prewarmId = `building-evidence-prewarm-${key}`;
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type: "raster", tileSize: 256, minzoom: 3, maxzoom: 14,
        bounds: [22.9863167, 3.0423830, 36.3971901, 12.6861457],
        tiles: [`evidence-${key}://tiles/{z}/{x}/{y}?theme=${themeName}`],
        attribution: "Building change © Google Open Buildings Temporal (CC BY 4.0)",
      });
    }
    if (!map.getLayer(prewarmId)) {
      map.addLayer({
        id: prewarmId, type: "raster", source: sourceId,
        minzoom: 3, maxzoom: 14.5,
        paint: {
          "raster-opacity": 0.001,
          "raster-fade-duration": 0,
          "raster-resampling": "nearest",
        },
      }, "rivers");
    }
  });

  if (map.getLayer("building-evidence")) map.removeLayer("building-evidence");
  map.addLayer({
    id: "building-evidence", type: "raster", source: `building-evidence-source-${period}`,
    minzoom: 3, maxzoom: 14.5,
    paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "nearest" },
  }, "rivers");
  evidenceState = { period, theme: themeName };
}

/* -------------------------------------------------------------------------- */
/* Period switch                                                              */
/* -------------------------------------------------------------------------- */
function buildSwitch() {
  const box = document.getElementById("period-switch");
  Object.entries(PERIODS).forEach(([key, p]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(key === state.period));
    b.dataset.period = key;
    b.textContent = p.label;
    b.addEventListener("click", () => applyPeriod(key));
    box.appendChild(b);
  });
}

function applyPeriod(key, opts = {}) {
  if (!PERIODS[key]) return;
  state.period = key;
  loadEvidence(key);
  applyPlaceFilter();                       // boxes belong to one epoch each
  document.querySelectorAll("#period-switch button").forEach((b) =>
    b.setAttribute("aria-checked", String(b.dataset.period === key)));
  if (!opts.silent) writeHash();
}

/* -------------------------------------------------------------------------- */
/* Example places                                                             */
/* -------------------------------------------------------------------------- */
let EXAMPLES = [];

function loadExamples() {
  examplesData
    .then((data) => {
      EXAMPLES = data.examples || [];
      ensurePlaceBoxes();
      if (state.example) selectExample(state.example, { instant: true });
    })
    .catch((err) => console.warn("could not load examples.json", err));
}

/* Place boxes: a subtle dashed rectangle around each example, shown only when
 * its epoch is selected (the filter is applied in applyPeriod). They invite a
 * click without shouting: label-grey, low opacity, brightening on hover. */
function placeBoxFeatures(period) {
  return EXAMPLES
    .map((ex, i) => ({ ex, i }))
    .filter(({ ex }) => !period || (ex.period || "war") === period)
    .map(({ ex, i }) => {
      const span = ex.span_km || 14;                     // box edge length, km
      const dLat = span / 2 / 110.6;
      const dLon = span / 2 / (111.32 * Math.cos((ex.lat * Math.PI) / 180));
      const [w, e, s, n] = [ex.lon - dLon, ex.lon + dLon, ex.lat - dLat, ex.lat + dLat];
      return {
        type: "Feature",
        id: i,                                           // stable numeric id (EXAMPLES index) for hover
        properties: { id: ex.id },
        geometry: { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
      };
    });
}

function ensurePlaceBoxes() {
  if (!EXAMPLES.length || !map.getLayer("admin-land") || map.getSource("places")) return;
  const t = theme();
  // Only the current epoch's boxes live in the source (swapped in applyPlaceFilter
  // via setData) — a hard re-tile, so switching epochs never ghosts an old box.
  map.addSource("places", {
    type: "geojson",
    data: { type: "FeatureCollection", features: placeBoxFeatures(state.period) }
  });
  // Invisible fill: no tint on the interior (it stays whatever the map shows),
  // but fully transparent fills still register hover/click, so it's the hit area.
  map.addLayer({
    id: "place-box-fill", type: "fill", source: "places", minzoom: 4.0,
    paint: { "fill-color": t.box, "fill-opacity": 0 },
  });
  // Glow: a wide, heavily-blurred halo under a soft core line (no dashes).
  // Both brighten on hover so the box feels lit-up and clickable.
  map.addLayer({
    id: "place-box-glow", type: "line", source: "places", minzoom: 4.0,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": t.box,
      "line-blur": ["interpolate", ["linear"], ["zoom"], 5, 4, 11, 13],
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 7, 11, 18],
      "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.85, 0.45]
    },
  });
  map.addLayer({
    id: "place-box-line", type: "line", source: "places", minzoom: 4.0,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": t.box, "line-blur": 0.6,
      "line-width": ["case", ["boolean", ["feature-state", "hover"], false], 2.0, 1.3],
      "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.95, 0.6]
    },
  });

  let hovered = null;
  map.on("mousemove", "place-box-fill", (e) => {
    const id = e.features.length ? e.features[0].id : null;
    if (hovered !== null && hovered !== id)
      map.setFeatureState({ source: "places", id: hovered }, { hover: false });
    if (id !== null) map.setFeatureState({ source: "places", id }, { hover: true });
    hovered = id;
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "place-box-fill", () => {
    if (hovered !== null) map.setFeatureState({ source: "places", id: hovered }, { hover: false });
    hovered = null;
    map.getCanvas().style.cursor = "";
  });
  map.on("click", "place-box-fill", (e) => {
    if (e.features.length) selectExample(e.features[0].properties.id);
  });
}

function applyPlaceFilter() {
  const src = map.getSource("places");
  if (!src) return;
  src.setData({ type: "FeatureCollection", features: placeBoxFeatures(state.period) });
  map.triggerRepaint();
}

function selectExample(id, opts = {}) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  state.example = id;
  if (ex.period && PERIODS[ex.period]) applyPeriod(ex.period, { silent: true });
  const camera = { center: [ex.lon, ex.lat], zoom: ex.zoom || 12 };
  if (opts.instant || REDUCED) map.jumpTo(camera);
  else map.flyTo({ ...camera, speed: 0.9, essential: true });
  setPanel("example");
  renderAreaCard(ex);
  writeHash();
}

function renderAreaCard(ex) {
  const card = document.getElementById("area-card");
  document.getElementById("area-period").textContent =
    PERIODS[ex.period] ? PERIODS[ex.period].label : "Selected area";
  document.getElementById("area-name").textContent = ex.name;
  document.getElementById("area-caption").textContent = [ex.caption, ex.note].filter(Boolean).join(" ");

  const driver = document.getElementById("area-driver");
  driver.textContent = ex.driver || "context";
  driver.className = `tag ${ex.driver || ""}`.trim();

  const index = EXAMPLES.findIndex((candidate) => candidate.id === ex.id);
  document.getElementById("area-previous").disabled = index <= 0;
  document.getElementById("area-next").disabled = index < 0 || index >= EXAMPLES.length - 1;

  const sources = document.getElementById("area-sources");
  sources.replaceChildren();
  (ex.sources || []).forEach((source) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.link;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title;
    const byline = document.createElement("span");
    byline.className = "source-byline";
    byline.textContent = [source.author, source.year].filter(Boolean).join(", ");
    item.append(link, byline);
    sources.appendChild(item);
  });
  if (!sources.children.length) {
    const item = document.createElement("li");
    item.textContent = "No area-specific sources listed.";
    sources.appendChild(item);
  }
  card.hidden = false;
}

function clearExample() {
  state.example = null;
  setPanel(null);
  writeHash();
}

function selectAdjacentExample(step) {
  const index = EXAMPLES.findIndex((ex) => ex.id === state.example);
  const next = EXAMPLES[index + step];
  if (next) selectExample(next.id);
}

/* -------------------------------------------------------------------------- */
/* Town labels — DOM markers (system fonts, no glyph PBFs required)           */
/* -------------------------------------------------------------------------- */
function loadTowns() {
  townsData
    .then((fc) => {
      const markers = (fc.features || []).map((f) => {
        const el = document.createElement("div");
        el.className = "town";
        el.textContent = f.properties.name;
        new maplibregl.Marker({ element: el, anchor: "left" })
          .setLngLat(f.geometry.coordinates)
          .addTo(map);
        return { el, minzoom: f.properties.minzoom || 0 };
      });
      // Tiered labels: main towns always show; extras fade in when zoomed in.
      const updateTowns = () => {
        const z = map.getZoom();
        markers.forEach((t) => { t.el.style.display = z >= t.minzoom ? "" : "none"; });
      };
      updateTowns();
      map.on("zoom", updateTowns);
    })
    .catch((err) => console.warn("could not load towns.geojson", err));
}

/* -------------------------------------------------------------------------- */
/* URL hash state:  #p/<period>/<zoom>/<lat>/<lng>[/<exampleId>]              */
/* -------------------------------------------------------------------------- */
function readHash() {
  const parts = location.hash.replace(/^#/, "").split("/");
  if (parts[0] !== "p" || parts.length < 5) return null;
  const zoom = parseFloat(parts[2]), lat = parseFloat(parts[3]), lng = parseFloat(parts[4]);
  if ([zoom, lat, lng].some(Number.isNaN)) return null;
  return { period: parts[1], zoom, center: [lng, lat], example: parts[5] || null };
}

function writeHash() {
  const c = map.getCenter();
  const parts = ["p", state.period, map.getZoom().toFixed(2), c.lat.toFixed(4), c.lng.toFixed(4)];
  if (state.example) parts.push(state.example);
  const h = "#" + parts.join("/");
  // replaceState updates the URL WITHOUT firing hashchange, so this never
  // re-enters the listener below (no guard needed). The listener therefore
  // only runs for genuine hash changes: manual URL edits and back/forward.
  if (h !== location.hash) history.replaceState(null, "", h);
}

window.addEventListener("hashchange", () => {
  const h = readHash();
  if (!h) return;
  if (PERIODS[h.period]) applyPeriod(h.period, { silent: true });
  state.example = h.example || null;
  const ex = EXAMPLES.find((candidate) => candidate.id === state.example);
  if (ex) { renderAreaCard(ex); setPanel("example"); }
  else setPanel(null);
  map.jumpTo({ center: h.center, zoom: h.zoom });
});

/* -------------------------------------------------------------------------- */
/* UI chrome: introduction, example card, about dialog                        */
/* -------------------------------------------------------------------------- */
function setPanel(panel) {
  document.getElementById("welcome-card").hidden = panel !== "welcome";
  document.getElementById("area-card").hidden = panel !== "example";
  document.getElementById("menu-toggle").hidden = Boolean(panel);
}

function wireChrome() {
  document.getElementById("menu-toggle").addEventListener("click", () => setPanel("welcome"));
  document.getElementById("welcome-close").addEventListener("click", () => setPanel(null));
  document.getElementById("examples-open").addEventListener("click", () => {
    if (EXAMPLES[0]) selectExample(EXAMPLES[0].id);
    else examplesData.then((data) => {
      const first = (data.examples || [])[0];
      if (first) selectExample(first.id);
    });
  });
  document.getElementById("area-close").addEventListener("click", clearExample);
  document.getElementById("area-previous").addEventListener("click", () => selectAdjacentExample(-1));
  document.getElementById("area-next").addEventListener("click", () => selectAdjacentExample(1));

  const about = document.getElementById("about");
  document.getElementById("about-open").addEventListener("click", () => (about.hidden = false));
  document.getElementById("about-close").addEventListener("click", () => (about.hidden = true));
  about.addEventListener("click", (e) => { if (e.target === about) about.hidden = true; });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { about.hidden = true; setPanel(null); }
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */
buildSwitch();
loadExamples();
wireChrome();
