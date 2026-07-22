/* Settlement-change viewer — vanilla-JS glue over MapLibre GL + PMTiles.
 * Responsibilities (docs/viewer_design.md §6): register the pmtiles protocol,
 * build the map from the committed style.json, drive the period switch by
 * styling signed presence-change surfaces into a zoom-aware pyramid in the browser,
 * fly to example places, keep all
 * view state in the URL hash. No build step, no framework.
 *
 * The settlement-change layer is not published yet, so DATA_URL is null and the
 * 'aggregates' source stays empty; the shell, switch, legend and places all work
 * against it. When tiles land, point DATA_URL at the release (see loadData). */

"use strict";

// ---- palette (mirrors style.css / docs §4), theme-aware ----
// The map background/lines/ramp are set from JS because a MapLibre style is
// static JSON and can't follow prefers-color-scheme; the CSS chrome follows
// the same OS signal, so the two stay in step. dark.neutral == dark.land so
// "no change" dissolves into the map (docs §4 rule) in both themes.
const THEME = {
  light: {
    land: "#EFEDE3", admin: "#B7BAAC", rust: "#BC4F25", neutral: "#E8E6DB", teal: "#2E7E72", underlay: "#C9C4B2", mixed: "#8F8A7B",
    water: "#D9DCD6", coast: "#C4C7BC", river: "#8FB4BE", box: "#646A60"
  },
  dark: {
    land: "#141714", admin: "#3A3F38", rust: "#E06B3B", neutral: "#141714", teal: "#4AA894", underlay: "#2A2E27", mixed: "#7A7F74",
    water: "#0E1512", coast: "#2C332E", river: "#3E5A61", box: "#9BA294"
  },
};
const themeQuery = matchMedia("(prefers-color-scheme: dark)");
const theme = () => (themeQuery.matches ? THEME.dark : THEME.light);

// ---- data source ----
// The first data run is deliberately limited to Yei.  Every pYYYY attribute
// is thresholded 4 m built-pixel coverage in parts per ten thousand, not a
// building count.  The GeoJSON aggregates are retained for the later national
// overview. The Yei pilot downloads two categorical change surfaces packed
// into one lossless WebP;
// no palette is baked into the data files.
const DATA_URL = "data/yei_presence_v0.geojson";
const DETAIL_URL = "data/yei_change.json";
// National builds publish PMTiles as release assets on the public bucket:
//   const DATA_URL = "https://<public-bucket>/releases/<id>/tiles/aggregates.pmtiles";
// For PMTiles, set DATA_IS_PMTILES = true (swaps the source instead of setData).
const DATA_IS_PMTILES = false;

// ---- periods: the switch and every colour read these ----
// Coverage is stored per year; switching periods differences the same source
// in the paint expression, without a tile refetch.
const PERIODS = {
  war: { label: "War 2016→18", from: "p2016", to: "p2018" },
  post: { label: "Post-agreement 2019→23", from: "p2019", to: "p2023" },
};
const DEFAULT_PERIOD = "war";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HOME = { center: [30.68, 4.09], zoom: 10.3 };

const state = { period: DEFAULT_PERIOD, example: null };
const DETAIL_TIERS = [
  { name: "regional", factor: 128, minzoom: 5.5, maxzoom: 8.6,
    opacity: [5.5, 0.88, 8.0, 0.88, 8.6, 0] },
  { name: "local", factor: 32, minzoom: 7.8, maxzoom: 10.0,
    opacity: [7.8, 0, 8.3, 0.9, 9.5, 0.9, 10.0, 0] },
  { name: "settlement", factor: 16, minzoom: 9.3, maxzoom: 12.5,
    opacity: [9.3, 0, 9.8, 0.92, 12.0, 0.92, 12.5, 0] },
  { name: "neighbourhood", factor: 4, minzoom: 11.8, maxzoom: 14.5,
    opacity: [11.8, 0, 12.3, 0.92, 14.0, 0.92, 14.5, 0] },
  { name: "detail", factor: 1, minzoom: 13.8, maxzoom: 16,
    opacity: [13.8, 0, 14.3, 0.92, 16, 0.92] },
];
let detailState = null;

/* -------------------------------------------------------------------------- */
/* Ramp / colour — thresholded built-coverage change in percentage points.     */
/* RAMP_CLAMP is parts per ten thousand: 100 means one percentage point.       */
/* The Yei pilot will set this from the observed coverage-change distribution. */
/* -------------------------------------------------------------------------- */
const RAMP_CLAMP = 100;
const AGGREGATE_LAYERS = {
  underlay: ["underlay", "underlay-block"],
  change: ["change-fill", "change-fill-block"],
};

function deltaExpr(p) {
  return ["-", ["coalesce", ["get", p.to], 0], ["coalesce", ["get", p.from], 0]];
}
function changeColor(p) {
  const t = theme();
  return ["interpolate", ["linear"], deltaExpr(p),
    -RAMP_CLAMP, t.rust, 0, t.neutral, RAMP_CLAMP, t.teal];
}
function underlayOpacity(p, layerId) {
  // faint grey for stable built coverage, capped low
  const coverageOpacity = ["interpolate", ["linear"], ["coalesce", ["get", p.to], 0],
    0, 0, 10, 0.12, 500, 0.35];
  // The Yei-only pilot covers only part of one 12 km global block.  Do not
  // let that partial aggregate read as a giant national-scale pixel.
  return layerId === "underlay-block"
    ? ["interpolate", ["linear"], ["zoom"], 8.5, 0, 9, coverageOpacity]
    : coverageOpacity;
}
function changeOpacity(layerId) {
  return layerId === "change-fill-block"
    ? ["interpolate", ["linear"], ["zoom"], 8.5, 0, 9, 0.92]
    : 0.92;
}

/* -------------------------------------------------------------------------- */
/* Map                                                                        */
/* -------------------------------------------------------------------------- */
if (window.pmtiles && window.maplibregl) {
  const protocol = new pmtiles.Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
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
  maxZoom: 15,
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
  applyTheme();                 // sets background/lines/underlay + ramp (calls applyPeriod)
  loadData();
  loadDetail();
  loadTowns();
  ensurePlaceBoxes();           // examples.json may already be in (fetch races the style)
  if (state.example) selectExample(state.example, { instant: true });
  writeHash();
});

map.on("moveend", writeHash);
map.on("error", (e) => console.warn("map error:", e && e.error ? e.error.message : e));

// Follow the OS light/dark preference at runtime (matches the CSS chrome).
themeQuery.addEventListener("change", () => { if (map.isStyleLoaded()) applyTheme(); });

function applyTheme() {
  const t = theme();
  if (map.getLayer("background")) map.setPaintProperty("background", "background-color", t.land);
  if (map.getLayer("africa-mask")) map.setPaintProperty("africa-mask", "fill-color", t.water);
  if (map.getLayer("africa-coast")) map.setPaintProperty("africa-coast", "line-color", t.coast);
  if (map.getLayer("admin-land")) map.setPaintProperty("admin-land", "line-color", t.admin);
  if (map.getLayer("admin-disputed")) map.setPaintProperty("admin-disputed", "line-color", t.admin);
  AGGREGATE_LAYERS.underlay.forEach((id) => {
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-color", t.underlay);
  });
  if (map.getLayer("rivers")) map.setPaintProperty("rivers", "line-color", t.river);
  if (map.getLayer("place-box-glow")) map.setPaintProperty("place-box-glow", "line-color", t.box);
  if (map.getLayer("place-box-line")) map.setPaintProperty("place-box-line", "line-color", t.box);
  applyPeriod(state.period, { silent: true });   // ramp endpoints are theme-dependent
  if (detailState) renderDetailSources();         // raw change stays unchanged; browser palette changes
  map.triggerRepaint();                          // force a full redraw (avoid partial repaint on slow first paint)
}

/* -------------------------------------------------------------------------- */
/* Data (settlement-change aggregates)                                        */
/* -------------------------------------------------------------------------- */
function loadData() {
  if (!DATA_URL) return;                     // no settlement-change layer published yet
  if (DATA_IS_PMTILES) {
    // Replace the empty placeholder source with the vector tileset.
    [...AGGREGATE_LAYERS.underlay, ...AGGREGATE_LAYERS.change]
      .forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
    if (map.getSource("aggregates")) map.removeSource("aggregates");
    map.addSource("aggregates", { type: "vector", url: "pmtiles://" + DATA_URL });
    // NOTE: a vector tileset needs "source-layer" on each layer; add via
    // addLayer here once the tileset's layer name is known from the build.
    console.warn("PMTiles path: add vector layers with source-layer (see build output).");
  } else {
    fetch(DATA_URL)
      .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then((geojson) => map.getSource("aggregates").setData(geojson))
      .catch((err) => console.warn("could not load", DATA_URL, err));
  }
}

async function readPackedChanges(url, width, height, periods) {
  const image = new Image();
  image.src = url;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const surfaces = Object.fromEntries(Object.keys(periods).map((period) =>
    [period, new Int8Array(width * height)]));
  for (let index = 0; index < width * height; index += 1) {
    const packed = rgba[index * 4];
    for (const [period, spec] of Object.entries(periods)) {
      const category = Math.floor(packed / (3 ** spec.base3_digit)) % 3;
      surfaces[period][index] = category === 1 ? -1 : category === 2 ? 1 : 0;
    }
  }
  return surfaces;
}

function hexRgb(hex) {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

function styledChangeUrl(change, width, height, factor) {
  const outWidth = Math.ceil(width / factor);
  const outHeight = Math.ceil(height / factor);
  const signedSum = new Int32Array(outWidth * outHeight);
  const absoluteSum = new Uint32Array(outWidth * outHeight);
  for (let y = 0; y < height; y += 1) {
    const outRow = Math.floor(y / factor) * outWidth;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const outIndex = outRow + Math.floor(x / factor);
      const delta = change[index];
      if (!delta) continue;
      signedSum[outIndex] += delta;
      absoluteSum[outIndex] += Math.abs(delta);
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = outWidth;
  canvas.height = outHeight;
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(outWidth, outHeight);
  const t = theme();
  const rust = hexRgb(t.rust);
  const teal = hexRgb(t.teal);
  const mixed = hexRgb(t.mixed);
  for (let index = 0; index < absoluteSum.length; index += 1) {
    if (!absoluteSum[index]) continue;
    // Hue is net direction; opacity is changed-building evidence. Crucially,
    // neither is divided by all (mostly empty) land cells in the block.
    // Keep the dominant direction saturated. Interpolating toward the land
    // colour when loss and gain nearly cancel would make abundant sparse
    // change disappear again. An exact tie uses the visible mixed-change grey.
    const rgb = signedSum[index] < 0 ? rust : signedSum[index] > 0 ? teal : mixed;
    const evidence = absoluteSum[index]; // significant changed 4 m cells; never divide by empty land
    const alpha = factor === 1
      ? 225
      : Math.max(45, Math.round(235 * (1 - Math.exp(-evidence / 3))));
    pixels.data.set([...rgb, alpha], index * 4);
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL("image/png");
}

async function loadDetail() {
  try {
    const response = await fetch(DETAIL_URL);
    if (!response.ok) throw new Error(response.status);
    const manifest = await response.json();
    const [width, height] = manifest.dimensions;
    const base = new URL(DETAIL_URL, window.location.href);
    const surfaces = await readPackedChanges(
      new URL(manifest.file, base).href, width, height, manifest.periods);
    detailState = { manifest, surfaces, width, height };
    renderDetailSources();
    applyDetailPeriod(state.period);
  } catch (error) {
    console.warn("could not load", DETAIL_URL, error);
  }
}

function renderDetailSources() {
  const { manifest, surfaces, width, height } = detailState;
  for (const period of Object.keys(manifest.periods)) {
    for (const tier of DETAIL_TIERS) {
      const id = `detail-${period}-${tier.name}`;
      const url = styledChangeUrl(surfaces[period], width, height, tier.factor);
      if (map.getSource(id)) {
        map.getSource(id).updateImage({ url, coordinates: manifest.coordinates });
        continue;
      }
      map.addSource(id, { type: "image", url, coordinates: manifest.coordinates });
      map.addLayer({
        id, type: "raster", source: id, minzoom: tier.minzoom, maxzoom: tier.maxzoom,
        paint: {
          "raster-opacity": ["interpolate", ["linear"], ["zoom"], ...tier.opacity],
          "raster-resampling": tier.factor === 1 ? "nearest" : "linear",
        },
      }, "rivers");
    }
  }
  applyDetailPeriod(state.period);
}

function applyDetailPeriod(period) {
  Object.keys(PERIODS).forEach((key) => DETAIL_TIERS.forEach((tier) => {
    const id = `detail-${key}-${tier.name}`;
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", key === period ? "visible" : "none");
  }));
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
  const p = PERIODS[key];
  AGGREGATE_LAYERS.change.forEach((id) => {
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-color", changeColor(p));
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", changeOpacity(id));
  });
  AGGREGATE_LAYERS.underlay.forEach((id) => {
    if (map.getLayer(id)) map.setPaintProperty(id, "fill-opacity", underlayOpacity(p, id));
  });
  applyDetailPeriod(key);
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
  fetch("data/examples.json")
    .then((r) => r.json())
    .then((data) => { EXAMPLES = data.examples || []; renderCards(); ensurePlaceBoxes(); })
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
    id: "place-box-fill", type: "fill", source: "places", minzoom: 4.4,
    paint: { "fill-color": t.box, "fill-opacity": 0 },
  });
  // Glow: a wide, heavily-blurred halo under a soft core line (no dashes).
  // Both brighten on hover so the box feels lit-up and clickable.
  map.addLayer({
    id: "place-box-glow", type: "line", source: "places", minzoom: 4.4,
    layout: { "line-join": "round", "line-cap": "round" },
    paint: {
      "line-color": t.box,
      "line-blur": ["interpolate", ["linear"], ["zoom"], 5, 4, 11, 13],
      "line-width": ["interpolate", ["linear"], ["zoom"], 5, 7, 11, 18],
      "line-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.85, 0.45]
    },
  });
  map.addLayer({
    id: "place-box-line", type: "line", source: "places", minzoom: 4.4,
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

function renderCards() {
  const box = document.getElementById("cards");
  box.innerHTML = "";
  EXAMPLES.forEach((ex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "place";
    b.dataset.id = ex.id;
    b.setAttribute("aria-current", String(ex.id === state.example));
    const driver = ex.driver ? `<span class="tag ${ex.driver}">${ex.driver}</span>` : "";
    const unver = ex.verified ? "" : `<span class="unverified">unverified</span>`;
    b.innerHTML =
      `<span class="place-name">${ex.name}${unver}</span>` +
      `<span class="place-cap">${ex.caption}</span>${driver}`;
    b.addEventListener("click", () => selectExample(ex.id));
    box.appendChild(b);
  });
}

function selectExample(id, opts = {}) {
  const ex = EXAMPLES.find((e) => e.id === id);
  if (!ex) return;
  state.example = id;
  if (ex.period && PERIODS[ex.period]) applyPeriod(ex.period, { silent: true });
  const camera = { center: [ex.lon, ex.lat], zoom: ex.zoom || 12 };
  if (opts.instant || REDUCED) map.jumpTo(camera);
  else map.flyTo({ ...camera, speed: 0.9, essential: true });
  document.querySelectorAll(".place").forEach((b) =>
    b.setAttribute("aria-current", String(b.dataset.id === id)));
  writeHash();
}

/* -------------------------------------------------------------------------- */
/* Town labels — DOM markers (system fonts, no glyph PBFs required)           */
/* -------------------------------------------------------------------------- */
function loadTowns() {
  fetch("data/towns.geojson")
    .then((r) => r.json())
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
  document.querySelectorAll(".place").forEach((b) =>
    b.setAttribute("aria-current", String(b.dataset.id === state.example)));
  map.jumpTo({ center: h.center, zoom: h.zoom });
});

/* -------------------------------------------------------------------------- */
/* UI chrome: drawer, about dialog                                            */
/* -------------------------------------------------------------------------- */
function wireChrome() {
  const drawer = document.getElementById("drawer");
  const toggle = document.getElementById("drawer-toggle");
  const setDrawer = (open) => {
    drawer.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.hidden = open;
  };
  toggle.addEventListener("click", () => setDrawer(true));
  document.getElementById("drawer-close").addEventListener("click", () => setDrawer(false));

  const about = document.getElementById("about");
  document.getElementById("about-open").addEventListener("click", () => (about.hidden = false));
  document.getElementById("about-close").addEventListener("click", () => (about.hidden = true));
  about.addEventListener("click", (e) => { if (e.target === about) about.hidden = true; });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { about.hidden = true; setDrawer(false); }
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */
buildSwitch();
loadExamples();
wireChrome();
