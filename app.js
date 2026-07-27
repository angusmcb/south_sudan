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
// the same OS signal, so the two stay in step. Stable/balanced evidence is a
// neutral warm grey, visually separate from empty land and the endpoints.
const THEME = {
  light: {
    land: "#EFEDE3", admin: "#B7BAAC", rust: "#BC4F25", neutral: "#918E82", teal: "#2E7E72", underlay: "#918E82", mixed: "#918E82",
    water: "#D9DCD6", coast: "#C4C7BC", river: "#8FB4BE", box: "#646A60",
    analysisMask: "#8F928A", analysisEdge: "#858A81"
  },
  dark: {
    land: "#141714", admin: "#3A3F38", rust: "#E06B3B", neutral: "#9C9A8F", teal: "#4AA894", underlay: "#9C9A8F", mixed: "#9C9A8F",
    water: "#0E1512", coast: "#2C332E", river: "#3E5A61", box: "#9BA294",
    analysisMask: "#070907", analysisEdge: "#6F756D"
  },
};
const themeQuery = matchMedia("(prefers-color-scheme: dark)");
const SETTINGS_KEY = "ssd-viewer-settings-v1";
const displaySettings = {
  theme: null,
  basemap: "minimal",
  boundaries: true,
  rivers: true,
};
try {
  const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
  if (saved.theme === "light" || saved.theme === "dark") displaySettings.theme = saved.theme;
  if (["minimal", "openfreemap", "satellite"].includes(saved.basemap))
    displaySettings.basemap = saved.basemap;
  if (typeof saved.boundaries === "boolean") displaySettings.boundaries = saved.boundaries;
  if (typeof saved.rivers === "boolean") displaySettings.rivers = saved.rivers;
} catch (_) {
  // A blocked or malformed local setting should never prevent the map loading.
}
const themeName = () => displaySettings.theme || (themeQuery.matches ? "dark" : "light");
const theme = () => THEME[themeName()];

function saveDisplaySettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(displaySettings));
  } catch (_) {
    // Storage is an optional convenience; the controls still work for this session.
  }
}

function applyDocumentTheme() {
  document.documentElement.dataset.theme = themeName();
}
applyDocumentTheme();

// ---- data source: immutable public release, raw evidence styled below ----
const TILE_RELEASE_URL =
  "https://storage.googleapis.com/south-sudan-buildings-tiles/releases/2026-07-ssd-obt-buffer50-z14-v2/tiles";

// ---- periods: each immutable archive shares the same RGB evidence contract ----
const PERIODS = {
  war: { label: "War 2016→18", from: "p2016", to: "p2018", archive: "war.pmtiles" },
  post: { label: "Post-agreement 2019→23", from: "p2019", to: "p2023", archive: "post.pmtiles" },
};
const DEFAULT_PERIOD = "war";

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const HOME = { center: [29.7, 7.9], zoom: 5.2 };
const HOME_BOUNDS = [[22.9863167, 3.0423830], [36.3971901, 12.6861457]];
const CONTEXT_ASSET_VERSION = "20260727-19";

const state = { period: DEFAULT_PERIOD, example: null };
let evidenceState = null;
let mapReady = false;
let openFreeMapLayerIds = [];
let openFreeMapTheme = null;
let basemapRequest = 0;

// Begin fetching page data immediately, in parallel with MapLibre's style and
// source work. The map only consumes these promises once it is ready to add
// markers or layers, so data latency never sits on the map's load event.
const examplesData = fetch(`data/examples.json?v=${CONTEXT_ASSET_VERSION}`)
  .then((response) => response.json());
const townsData = fetch(`data/towns.geojson?v=${CONTEXT_ASSET_VERSION}`)
  .then((response) => response.json());

/* -------------------------------------------------------------------------- */
/* Map                                                                        */
/* -------------------------------------------------------------------------- */
if (window.pmtiles && window.maplibregl) {
  const archives = new Map(Object.entries(PERIODS).map(([period, spec]) => [
    period, new pmtiles.PMTiles(`${TILE_RELEASE_URL}/${spec.archive}`),
  ]));
  const styledCache = new Map();

  async function getStyledPair(period, z, x, y) {
    const activeTheme = themeName();
    const cacheKey = `${period}/${z}/${x}/${y}/${activeTheme}`;
    if (!styledCache.has(cacheKey)) {
      const pending = (async () => {
        const response = await archives.get(period).getZxy(
          Number(z), Number(x), Number(y));
        if (!response) return null;
        const tiles = await styleEvidenceTiles(response.data, Number(z));
        return {
          ...tiles,
          cacheControl: response.cacheControl,
          expires: response.expires,
        };
      })().catch((error) => {
        styledCache.delete(cacheKey);
        throw error;
      });
      styledCache.set(cacheKey, pending);
      if (styledCache.size > 256) styledCache.delete(styledCache.keys().next().value);
    }
    return styledCache.get(cacheKey);
  }

  Object.keys(PERIODS).forEach((period) => {
    ["unchanged", "change"].forEach((kind) => {
      maplibregl.addProtocol(`${kind}-${period}`, async (params, abortController) => {
        const match = params.url.match(
          /^(?:unchanged|change)-(?:war|post):\/\/tiles\/(\d+)\/(\d+)\/(\d+)/);
        if (!match) throw new Error(`invalid evidence URL: ${params.url}`);
        const [, z, x, y] = match;
        const pair = await getStyledPair(period, z, x, y);
        if (!pair) return { data: null };
        return {
          data: pair[kind],
          cacheControl: pair.cacheControl,
          expires: pair.expires,
        };
      });
    });
  });
}

const fromHash = readHash();
if (fromHash && PERIODS[fromHash.period]) state.period = fromHash.period;
if (fromHash && fromHash.example) state.example = fromHash.example;

const map = new maplibregl.Map({
  container: "map",
  style: `style.json?v=${CONTEXT_ASSET_VERSION}`,
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
    "Context © OpenFreeMap · © OpenStreetMap contributors",
    "Africa silhouette © Natural Earth (public domain)",
    "Analysis extent © geoBoundaries (CC BY 4.0)",
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
  applyBasemap();
  loadTowns();
  ensurePlaceBoxes();           // examples.json may already be in (fetch races the style)
  if (state.example) selectExample(state.example, { instant: true });
  writeHash();
});

map.on("moveend", writeHash);
map.on("zoomend", () => {
  if (displaySettings.basemap === "openfreemap") applyBasemap();
});
map.on("error", (e) => console.warn("map error:", e && e.error ? e.error.message : e));

// Follow the OS light/dark preference at runtime (matches the CSS chrome).
themeQuery.addEventListener("change", () => {
  if (!displaySettings.theme && mapReady) applyTheme();
});

function applyTheme() {
  applyDocumentTheme();
  const t = theme();
  if (map.getLayer("background")) map.setPaintProperty("background", "background-color", t.land);
  if (map.getLayer("africa-mask")) map.setPaintProperty("africa-mask", "fill-color", t.water);
  if (map.getLayer("africa-coast")) map.setPaintProperty("africa-coast", "line-color", t.coast);
  if (map.getLayer("admin-land")) map.setPaintProperty("admin-land", "line-color", t.admin);
  if (map.getLayer("admin-disputed")) map.setPaintProperty("admin-disputed", "line-color", t.admin);
  if (map.getLayer("rivers")) map.setPaintProperty("rivers", "line-color", t.river);
  if (map.getLayer("analysis-mask"))
    map.setPaintProperty("analysis-mask", "fill-color", t.analysisMask);
  if (map.getLayer("analysis-edge"))
    map.setPaintProperty("analysis-edge", "line-color", t.analysisEdge);
  if (map.getLayer("place-box-glow")) map.setPaintProperty("place-box-glow", "line-color", t.box);
  if (map.getLayer("place-box-line")) map.setPaintProperty("place-box-line", "line-color", t.box);
  applyContextVisibility();
  applyPeriod(state.period, { silent: true });   // ramp endpoints are theme-dependent
  loadEvidence(state.period);                     // recolour cached raw evidence for the new theme
  if (displaySettings.basemap === "openfreemap") applyBasemap();
  map.triggerRepaint();                          // force a full redraw (avoid partial repaint on slow first paint)
}

/* -------------------------------------------------------------------------- */
/* Optional context basemaps                                                  */
/* -------------------------------------------------------------------------- */
const OPENFREEMAP_STYLES = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const CONTEXT_HANDOFF = { load: 7.15, start: 7.25, end: 7.75 };
const OPENFREEMAP_WATER_MIN_ZOOM = 8;
const OPENFREEMAP_COUNTRY_BOUNDARY_LAYERS =
  new Set(["boundary_2", "boundary_disputed"]);
const OPENFREEMAP_EXCLUDED_SOURCE_LAYERS =
  new Set(["building", "landcover", "landuse", "natural", "park"]);
const openFreeMapStyleCache = new Map();

function evidenceAnchor() {
  const layer = map.getStyle().layers.find((candidate) =>
    candidate.id.startsWith("building-"));
  return layer ? layer.id : "rivers";
}

function removeOpenFreeMap() {
  openFreeMapLayerIds.slice().reverse().forEach((id) => {
    if (map.getLayer(id)) map.removeLayer(id);
  });
  openFreeMapLayerIds = [];
  if (map.getSource("openfreemap")) map.removeSource("openfreemap");
  openFreeMapTheme = null;
}

function openFreeMapSourceLayer(layer) {
  return layer["source-layer"] || "";
}

function contextBoundaryWidth() {
  return ["interpolate", ["linear"], ["zoom"], 4, 0.6, 8, 1.0, 12, 1.6];
}

function contextRiverWidth() {
  return ["interpolate", ["linear"], ["zoom"], 6, 1.0, 9, 1.8, 12, 3.0];
}

function contextFadeIn() {
  return ["interpolate", ["linear"], ["zoom"],
    CONTEXT_HANDOFF.start, 0, CONTEXT_HANDOFF.end, 1];
}

function bundledBoundaryOpacity() {
  // Keep the instant GeoJSON fallback fully visible until the hosted layers
  // have actually been installed; a slow network must not create a blank gap.
  if (displaySettings.basemap !== "openfreemap" || !openFreeMapLayerIds.length) return 1;
  return ["interpolate", ["linear"], ["zoom"],
    CONTEXT_HANDOFF.start, 1, CONTEXT_HANDOFF.end, 0];
}

function bundledRiverOpacity() {
  if (displaySettings.basemap !== "openfreemap" || !openFreeMapLayerIds.length) {
    return ["interpolate", ["linear"], ["zoom"], 5, 0, 6, 0.85];
  }
  return ["interpolate", ["linear"], ["zoom"],
    5, 0, 6, 0.85, CONTEXT_HANDOFF.start, 0.85, CONTEXT_HANDOFF.end, 0];
}

function includeOpenFreeMapLayer(layer) {
  const sourceLayer = openFreeMapSourceLayer(layer);
  if (layer.source !== "openmaptiles" || layer.type === "symbol") return false;
  if (OPENFREEMAP_EXCLUDED_SOURCE_LAYERS.has(sourceLayer)) return false;
  if (sourceLayer === "boundary"
      && !OPENFREEMAP_COUNTRY_BOUNDARY_LAYERS.has(layer.id)) return false;
  return !Object.keys(layer.paint || {}).some((key) => key.endsWith("-pattern"));
}

function harmonizeOpenFreeMapLayer(layer) {
  const sourceLayer = openFreeMapSourceLayer(layer);
  const t = theme();
  layer.paint = layer.paint || {};
  if (sourceLayer === "boundary") {
    layer.paint["line-color"] = t.admin;
    layer.paint["line-width"] = contextBoundaryWidth();
    layer.paint["line-opacity"] = contextFadeIn();
  } else if (sourceLayer === "waterway") {
    layer.paint["line-color"] = t.river;
    layer.paint["line-width"] = contextRiverWidth();
    layer.paint["line-opacity"] = contextFadeIn();
  } else if (sourceLayer === "water") {
    layer.paint["fill-color"] = t.river;
    layer.paint["fill-opacity"] = 0.48;
  }
}

function placeAnalysisMask() {
  const anchor = evidenceAnchor();
  ["analysis-mask", "analysis-edge"].forEach((id) => {
    if (map.getLayer(id)) map.moveLayer(id, anchor);
  });
}

async function loadOpenFreeMap(activeTheme, request) {
  if (openFreeMapTheme === activeTheme && openFreeMapLayerIds.length) return;
  removeOpenFreeMap();
  let pending = openFreeMapStyleCache.get(activeTheme);
  if (!pending) {
    pending = fetch(OPENFREEMAP_STYLES[activeTheme]).then((response) => {
      if (!response.ok) throw new Error(`OpenFreeMap style request failed (${response.status})`);
      return response.json();
    }).catch((error) => {
      openFreeMapStyleCache.delete(activeTheme);
      throw error;
    });
    openFreeMapStyleCache.set(activeTheme, pending);
  }
  const style = await pending;
  if (request !== basemapRequest || displaySettings.basemap !== "openfreemap") return;
  const source = { ...style.sources.openmaptiles };
  source.attribution =
    'OpenFreeMap © OpenMapTiles · Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>';
  map.addSource("openfreemap", source);
  const anchor = evidenceAnchor();
  style.layers
    .filter(includeOpenFreeMapLayer)
    .forEach((layer) => {
      const copy = structuredClone(layer);
      copy.id = `openfreemap-${layer.id}`;
      copy.source = "openfreemap";
      copy.minzoom = Math.max(copy.minzoom || 0, CONTEXT_HANDOFF.start);
      if (openFreeMapSourceLayer(copy) === "water") {
        copy.minzoom = Math.max(copy.minzoom || 0, OPENFREEMAP_WATER_MIN_ZOOM);
      }
      harmonizeOpenFreeMapLayer(copy);
      map.addLayer(copy, anchor);
      openFreeMapLayerIds.push(copy.id);
    });
  openFreeMapTheme = activeTheme;
  placeAnalysisMask();
  applyContextVisibility();
}

function ensureSatellite() {
  if (!map.getSource("satellite")) {
    map.addSource("satellite", {
      type: "raster",
      tileSize: 256,
      maxzoom: 19,
      tiles: [
        "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      ],
      attribution: "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community",
    });
  }
  if (!map.getLayer("satellite")) {
    map.addLayer({
      id: "satellite",
      type: "raster",
      source: "satellite",
      layout: { visibility: "none" },
      paint: { "raster-opacity": 0.9, "raster-fade-duration": 180 },
    }, evidenceAnchor());
  }
}

function syncSettingsControls() {
  const openFreeMap = document.getElementById("setting-openfreemap");
  const satellite = document.getElementById("setting-satellite");
  const boundaries = document.getElementById("setting-boundaries");
  const rivers = document.getElementById("setting-rivers");
  if (openFreeMap) openFreeMap.checked = displaySettings.basemap === "openfreemap";
  if (satellite) satellite.checked = displaySettings.basemap === "satellite";
  if (boundaries) boundaries.checked = displaySettings.boundaries;
  if (rivers) rivers.checked = displaySettings.rivers;
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.themeChoice === themeName()));
  });
}

function applyContextVisibility() {
  ["admin-land", "admin-disputed"].forEach((id) => {
    if (map.getLayer(id)) map.setLayoutProperty(
      id, "visibility", displaySettings.boundaries ? "visible" : "none");
  });
  if (map.getLayer("rivers")) map.setLayoutProperty(
    "rivers", "visibility", displaySettings.rivers ? "visible" : "none");
  ["admin-land", "admin-disputed"].forEach((id) => {
    if (map.getLayer(id))
      map.setPaintProperty(id, "line-opacity", bundledBoundaryOpacity());
  });
  if (map.getLayer("rivers"))
    map.setPaintProperty("rivers", "line-opacity", bundledRiverOpacity());
}

function applyBasemap() {
  if (!mapReady) return;
  const request = ++basemapRequest;
  ensureSatellite();
  map.setLayoutProperty(
    "satellite", "visibility",
    displaySettings.basemap === "satellite" ? "visible" : "none");
  if (displaySettings.basemap === "openfreemap"
      && map.getZoom() >= CONTEXT_HANDOFF.load) {
    loadOpenFreeMap(themeName(), request)
      .catch((error) => console.warn("could not load OpenFreeMap background", error));
  } else {
    removeOpenFreeMap();
  }
  placeAnalysisMask();
  applyContextVisibility();
  syncSettingsControls();
}

function chooseBasemap(mode) {
  displaySettings.basemap =
    displaySettings.basemap === mode ? "minimal" : mode;
  saveDisplaySettings();
  applyBasemap();
}

function chooseTheme(nextTheme) {
  if (nextTheme !== "light" && nextTheme !== "dark") return;
  if (displaySettings.theme === nextTheme) return;
  displaySettings.theme = nextTheme;
  saveDisplaySettings();
  applyTheme();
  syncSettingsControls();
}

function chooseContextLayer(key) {
  if (key !== "boundaries" && key !== "rivers") return;
  displaySettings[key] = !displaySettings[key];
  saveDisplaySettings();
  applyContextVisibility();
  syncSettingsControls();
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
  if (zoom <= 5) return 60;
  return ({
    6: 70, 7: 80, 8: 90, 9: 105, 10: 125,
    11: 150, 12: 180, 13: 210, 14: 255,
  }[zoom] || 255);
}

// Overview pixels aggregate many z14 cells. At national zooms, tiny nonzero
// aggregate values otherwise turn nearly every settlement red or green. Treat
// weak overview density as neutral context; detail zooms retain every changed
// cell from the evidence archive.
function minimumSignedEvidence(zoom) {
  if (zoom <= 5) return 30;
  if (zoom <= 6) return 24;
  if (zoom <= 8) return 24;
  if (zoom <= 9) return 12;
  if (zoom <= 10) return 6;
  return 1;
}

function stableAlphaFloor(zoom) {
  if (zoom <= 10) return 45;
  return ({ 11: 70, 12: 90, 13: 115, 14: 145 }[zoom] || 145);
}

// The B channel also contains scattered low-density building evidence. Hide
// that noise at overview zooms so neutral context means a credible settlement
// concentration, not simply "at least one source cell somewhere in this
// aggregate".
function minimumStableEvidence(zoom) {
  if (zoom <= 5) return 16;
  if (zoom <= 6) return 12;
  if (zoom <= 7) return 12;
  if (zoom <= 8) return 10;
  if (zoom <= 9) return 8;
  if (zoom <= 10) return 4;
  return 1;
}

function changeSaturationForZoom(zoom) {
  if (zoom < 13) return 16 * (2 ** (13 - zoom));
  return 16 / (4 ** (zoom - 13));
}

function decodedEvidence(value, saturation) {
  if (!value) return 0;
  // Tiles encode count as 255 * (1 - exp(-count / saturation)).
  // Half a byte below 255 gives saturated values a finite conservative
  // lower bound while matching the inverse transform elsewhere.
  const encoded = Math.min(value, 254.5);
  return -saturation * Math.log1p(-encoded / 255);
}

function integralImages(image, zoom) {
  const { width, height } = image;
  const stride = width + 1;
  const size = stride * (height + 1);
  const loss = new Float64Array(size);
  const gain = new Float64Array(size);
  const saturation = changeSaturationForZoom(zoom);
  for (let y = 0; y < height; y += 1) {
    let rowLoss = 0, rowGain = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * 4;
      const l = decodedEvidence(image.data[source], saturation);
      const g = decodedEvidence(image.data[source + 1], saturation);
      rowLoss += l;
      rowGain += g;
      const target = (y + 1) * stride + x + 1;
      const above = y * stride + x + 1;
      loss[target] = loss[above] + rowLoss;
      gain[target] = gain[above] + rowGain;
    }
  }
  return { loss, gain, stride };
}

function boxSum(integral, stride, x0, y0, x1, y1) {
  return integral[y1 * stride + x1]
    - integral[y0 * stride + x1]
    - integral[y1 * stride + x0]
    + integral[y0 * stride + x0];
}

function styleUnchangedImage(raw, output, zoom, colour) {
  const stableFloor = minimumStableEvidence(zoom);
  const opacityFloor = stableAlphaFloor(zoom);
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    const stable = raw.data[offset + 2];
    if (stable < stableFloor) {
      output.data[offset + 3] = 0;
      continue;
    }
    output.data[offset] = colour[0];
    output.data[offset + 1] = colour[1];
    output.data[offset + 2] = colour[2];
    output.data[offset + 3] = Math.round(
      opacityFloor + (170 - opacityFloor) * stable / 255);
  }
}

function styleOverviewChange(raw, output, zoom, colours) {
  const evidenceFloor = minimumSignedEvidence(zoom);
  const opacityFloor = changeAlphaFloor(zoom);
  for (let offset = 0; offset < raw.data.length; offset += 4) {
    const loss = raw.data[offset], gain = raw.data[offset + 1];
    const strongest = Math.max(loss, gain);
    if (strongest < evidenceFloor || loss === gain) {
      output.data[offset + 3] = 0;
      continue;
    }
    const colour = loss > gain ? colours.rust : colours.teal;
    output.data[offset] = colour[0];
    output.data[offset + 1] = colour[1];
    output.data[offset + 2] = colour[2];
    output.data[offset + 3] = Math.round(
      opacityFloor + (255 - opacityFloor) * strongest / 255);
  }
}

function styleConsensusChange(raw, output, zoom, colours) {
  const { width, height } = raw;
  const integral = integralImages(raw, zoom);
  const opacityFloor = changeAlphaFloor(zoom);
  // Keep the filter footprint close to the selected 9×9 z14 neighbourhood
  // (~86 m at South Sudan's latitude). Applying 9×9 independently to every
  // pyramid level made its ground footprint double at each zoom-out, so the
  // apparent direction could flip rather than merely become coarser.
  const sourceScale = 2 ** Math.max(0, 14 - zoom);
  const targetDiameter = 9 / sourceScale;
  const diameter = Math.max(1, Math.round((targetDiameter - 1) / 2) * 2 + 1);
  const radius = (diameter - 1) / 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const x0 = Math.max(0, x - radius), y0 = Math.max(0, y - radius);
      const x1 = Math.min(width, x + radius + 1), y1 = Math.min(height, y + radius + 1);
      const loss = boxSum(integral.loss, integral.stride, x0, y0, x1, y1);
      const gain = boxSum(integral.gain, integral.stride, x0, y0, x1, y1);
      const total = loss + gain;
      const dominance = total ? Math.abs(gain - loss) / total : 0;
      const strongest = Math.max(loss, gain);
      const coveredSourceCells = (x1 - x0) * (y1 - y0) * sourceScale * sourceScale;
      const minimumChangedCells = coveredSourceCells * (12 / 81);
      if (total < minimumChangedCells || dominance < 0.55) {
        output.data[offset + 3] = 0;
        continue;
      }
      const colour = loss > gain ? colours.rust : colours.teal;
      output.data[offset] = colour[0];
      output.data[offset + 1] = colour[1];
      output.data[offset + 2] = colour[2];
      const directionalDensity = strongest / coveredSourceCells;
      output.data[offset + 3] = Math.round(
        opacityFloor + (255 - opacityFloor) * Math.min(1, directionalDensity * 4));
    }
  }
}

async function styleEvidenceTiles(rawBytes, zoom) {
  const bitmap = await createImageBitmap(new Blob([rawBytes], { type: "image/webp" }));
  const rawCanvas = document.createElement("canvas");
  rawCanvas.width = bitmap.width;
  rawCanvas.height = bitmap.height;
  const rawContext = rawCanvas.getContext("2d", { willReadFrequently: true });
  rawContext.drawImage(bitmap, 0, 0);
  bitmap.close();
  const raw = rawContext.getImageData(0, 0, rawCanvas.width, rawCanvas.height);
  const t = theme();
  const rust = hexRgb(t.rust), teal = hexRgb(t.teal);
  const stableColour = hexRgb(t.underlay);
  const unchangedCanvas = document.createElement("canvas");
  const changeCanvas = document.createElement("canvas");
  [unchangedCanvas, changeCanvas].forEach((canvas) => {
    canvas.width = raw.width;
    canvas.height = raw.height;
  });
  const unchangedContext = unchangedCanvas.getContext("2d");
  const changeContext = changeCanvas.getContext("2d");
  const unchanged = unchangedContext.createImageData(raw.width, raw.height);
  const change = changeContext.createImageData(raw.width, raw.height);
  styleUnchangedImage(raw, unchanged, zoom, stableColour);
  if (zoom >= 9) {
    styleConsensusChange(raw, change, zoom, { rust, teal });
  } else {
    styleOverviewChange(raw, change, zoom, { rust, teal });
  }
  unchangedContext.putImageData(unchanged, 0, 0);
  changeContext.putImageData(change, 0, 0);
  const [unchangedBytes, changeBytes] = await Promise.all([
    canvasPngBytes(unchangedCanvas),
    canvasPngBytes(changeCanvas),
  ]);
  return { unchanged: unchangedBytes, change: changeBytes };
}

function loadEvidence(period) {
  if (!mapReady || !PERIODS[period]) return;
  const activeTheme = themeName();
  const kinds = ["unchanged", "change"];
  if (evidenceState && evidenceState.period === period && evidenceState.theme === activeTheme) return;

  if (evidenceState && evidenceState.theme !== activeTheme) {
    kinds.forEach((kind) => {
      const layerId = `building-${kind}`;
      if (map.getLayer(layerId)) map.removeLayer(layerId);
    });
    Object.keys(PERIODS).forEach((key) => {
      kinds.forEach((kind) => {
        const prewarmId = `building-${kind}-prewarm-${key}`;
        const sourceId = `building-${kind}-source-${key}`;
        if (map.getLayer(prewarmId)) map.removeLayer(prewarmId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
      });
    });
  }

  Object.keys(PERIODS).forEach((key) => {
    kinds.forEach((kind) => {
      const sourceId = `building-${kind}-source-${key}`;
      const prewarmId = `building-${kind}-prewarm-${key}`;
      if (!map.getSource(sourceId)) {
        map.addSource(sourceId, {
          type: "raster", tileSize: 256, minzoom: 3, maxzoom: 14,
          bounds: [22.9863167, 3.0423830, 36.3971901, 12.6861457],
          tiles: [`${kind}-${key}://tiles/{z}/{x}/{y}?theme=${activeTheme}`],
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
  });

  kinds.forEach((kind) => {
    const layerId = `building-${kind}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    map.addLayer({
      id: layerId, type: "raster", source: `building-${kind}-source-${period}`,
      minzoom: 3, maxzoom: 14.5,
      paint: {
        "raster-opacity": 1,
        "raster-fade-duration": 180,
        "raster-resampling": "nearest",
      },
    }, "rivers");
  });
  evidenceState = { period, theme: activeTheme };
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

  const settingsToggle = document.getElementById("settings-toggle");
  const settingsPanel = document.getElementById("settings-panel");
  settingsToggle.addEventListener("click", () => {
    settingsPanel.hidden = !settingsPanel.hidden;
    settingsToggle.setAttribute("aria-expanded", String(!settingsPanel.hidden));
  });
  document.getElementById("setting-openfreemap")
    .addEventListener("change", () => chooseBasemap("openfreemap"));
  document.getElementById("setting-satellite")
    .addEventListener("change", () => chooseBasemap("satellite"));
  document.getElementById("setting-boundaries")
    .addEventListener("change", () => chooseContextLayer("boundaries"));
  document.getElementById("setting-rivers")
    .addEventListener("change", () => chooseContextLayer("rivers"));
  document.querySelectorAll("[data-theme-choice]").forEach((button) => {
    button.addEventListener("click", () => chooseTheme(button.dataset.themeChoice));
  });
  syncSettingsControls();

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      about.hidden = true;
      settingsPanel.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
      setPanel(null);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */
buildSwitch();
loadExamples();
wireChrome();
