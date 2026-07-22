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

The first data run is a **Yei-only presence pilot**.  Once generated with the
command below, `data/yei_presence_v0.geojson` supplies 4 m thresholded
building-presence coverage, aggregated to 1200 m patches and 12 km blocks.
It is intentionally not a national map or a building-count product.

```bash
uv run python scripts/build_viewer.py
```

That command also writes the reproducible private source copy to
`gs://humanitarian_buildings/viewer/pilots/yei_presence_v0.geojson`. Use
`--upload-blob ''` only for a local, non-published test.

## Wiring in data when it lands

`app.js`, top of file:

- **Yei v0 (single GeoJSON)** — `DATA_URL = "data/yei_presence_v0.geojson"`.
  Features carry fixed-point annual thresholded coverage (`p2016`, `p2018`,
  `p2019`, `p2023`); the period switch differences them.
- **National PMTiles (release asset on the public bucket)** — set `DATA_URL` to
  the release URL and `DATA_IS_PMTILES = true`, then add the vector layers with
  their `source-layer` name (printed by the build).

The colour ramp is deliberately provisional and lives in one place
(`changeColor` / `RAMP_CLAMP` in `app.js`); `100` equals one percentage point
of built-pixel coverage.

Build inputs (thresholded per-year presence → GeoJSON/PMTiles) are produced by
`scripts/build_viewer.py` over `src/ssd_rs/viewer/`. Generated tiles are release
assets and are **not** committed here.
