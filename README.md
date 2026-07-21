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

The settlement-change layer is **not published yet**. `app.js` has
`DATA_URL = null`, so the `aggregates` source is empty and the map shows only
reference boundaries and town labels; the period switch, legend, places drawer,
URL-hash deep links and About panel all work against the empty source. A
data-status banner says so in the UI.

## Wiring in data when it lands

`app.js`, top of file:

- **v0 (single GeoJSON, docs §7 shortcut)** — set
  `DATA_URL = "data/counts_v0.geojson"`. Features carry per-year building counts
  (`c2016`, `c2018`, `c2019`, `c2023`, …); the period switch differences them.
- **National PMTiles (release asset on the public bucket)** — set `DATA_URL` to
  the release URL and `DATA_IS_PMTILES = true`, then add the vector layers with
  their `source-layer` name (printed by the build).

The colour ramp is deliberately provisional and lives in one place
(`changeColor` / `RAMP_CLAMP` in `app.js`); the counts-vs-presence question is
still open (docs §5).

Build inputs (per-year counts → GeoJSON/PMTiles) are produced by
`scripts/build_viewer.py` over `src/ssd_rs/viewer/`. Generated tiles are release
assets and are **not** committed here.
