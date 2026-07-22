# viewer/ — public settlement-change web map

The deployable static site, exactly as GitHub Pages serves it (see
`docs/viewer_design.md`). No build step, no framework: `index.html` + `style.css`
+ `app.js` + a committed MapLibre `style.json`, with MapLibre GL and PMTiles
vendored under `vendor/`.

## Run locally

Any static server (the map fetches `style.json`, `data/*`, so `file://` is
flaky in some browsers — use a server):

```bash
python3 -m http.server -d viewer 8000   # then open http://localhost:8000/
```

## Status

The first data run is a **Yei-only presence pilot**. Once generated with the
command below, `data/yei_change.webp` contains both periods as categorical
loss / none / gain surfaces. Open Buildings presence is first quantized to
uint8 percentage, spatially matched within 4 m, differenced, and subjected to
a 30-percentage-point deadband. The browser styles the result and accumulates
changed-cell evidence into 512 m, 128 m, 64 m and 16 m overview tiers before the
native 4 m tier appears. `data/yei_presence_v0.geojson`
is retained as the reproducible aggregate input for a later national overview.
It is intentionally not a national map or a building-count product.

```bash
uv run python scripts/build_viewer.py
```

That command also writes the reproducible private source copies to
`gs://humanitarian_buildings/viewer/pilots/`. Use
`--upload-blob ''` only for a local, non-published test.

## Wiring in data when it lands

`app.js`, top of file:

- **Yei v0 (packed significant change)** — `DETAIL_URL = "data/yei_change.json"`.
  The manifest records georeferencing, deadband, spatial tolerance and the
  packed WebP encoding. The browser applies the active palette and selects a
  progressively aggregated raster tier as zoom changes.
- **Yei aggregate input** — `DATA_URL = "data/yei_presence_v0.geojson"`.
  Features carry fixed-point annual thresholded coverage (`p2016`, `p2018`,
  `p2019`, `p2023`) for the future overview layer.
- **National PMTiles (release asset on the public bucket)** — set `DATA_URL` to
  the release URL and `DATA_IS_PMTILES = true`, then add the vector layers with
  their `source-layer` name (printed by the build).

The colour ramp is deliberately provisional and lives in one place
(`changeColor` / `RAMP_CLAMP` in `app.js`); `100` equals one percentage point
of built-pixel coverage.

Build inputs (uint8-percent presence → significant signed change) are produced by
`scripts/build_viewer.py` over `src/ssd_rs/viewer/`. Generated tiles are release
assets and are **not** committed here.
