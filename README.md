# viewer/ — public settlement-change web map

The deployable static site, exactly as GitHub Pages serves it. It uses vanilla
JavaScript, MapLibre GL and the vendored PMTiles client; there is no bundler or
application server.

## Run locally

```bash
python3 -m http.server -d viewer 8000
```

Then open `http://localhost:8000/`. `file://` is unsupported because the map
loads JSON and PMTiles with HTTP requests.

## Current data

The viewer reads the immutable national South Sudan release, including a
50 km border buffer for nearby refugee settlements, directly from:

```text
https://storage.googleapis.com/south-sudan-buildings-tiles/
  releases/2026-07-ssd-obt-buffer50-z14-v2/tiles/war.pmtiles
  releases/2026-07-ssd-obt-buffer50-z14-v2/tiles/post.pmtiles
```

The bucket permits anonymous reads and cross-origin `GET`/`HEAD` range
requests. Its policy is reproduced by `config/viewer_bucket_cors.json`.

Each lossless WebP tile contains data channels rather than final colours:

- R: significant building-presence loss evidence;
- G: significant gain evidence;
- B: unchanged/stable building evidence.

The z14 annual rasters are mean-pooled from the native 4 m Open Buildings
grid onto 9.5546 m cells. The 30% analytic threshold is therefore rescaled by
pixel area to 5% before loss/gain/stable classification; applying 30% directly
to the coarser mean raster incorrectly fragments building evidence.

`app.js` retrieves sparse tiles through the PMTiles client, decodes the WebP,
applies the active light/dark palette and hands a transparent styled PNG to
MapLibre. At z3–14 the channels are saturating aggregates that preserve sparse
change. Below z13, the saturation count doubles per coarser zoom so dense loss
and gain remain distinguishable instead of both clipping to 255; at z14 it
scales with pixel area to retain detail. The browser raises the minimum opacity
of nonzero change toward detail. Weak aggregate change density at z3–8 is
progressively suppressed instead of colouring almost every settlement red or
green. The z8–10 floors taper from regional density filtering into full detail
at z11, so scattered rural cells do not form a city-like texture around Wau
and Aweil. Display opacity rises at every zoom, so accepted change remains
legible as aggregates split into finer pixels. The stable channel has its own
overview density threshold, so brown context marks credible settlement
concentrations rather than scattered isolated source cells. At z12–14 a small
screen-space halo expands red/green evidence without changing the underlying
measurements.

The current aggregate-only z3–14 archives cover all of South Sudan and its
50 km buffer. War has 124,119 addressed tiles (38.94 MiB) and post-agreement
has 132,142 (42.92 MiB); empty tiles are absent. Stable evidence has a
browser-side opacity floor at every zoom so unchanged settlement remains
visible.

Both period sources are attached when the map loads. PMTiles still transfers
only the byte ranges for tiles in the current viewport—not either complete
archive—but an effectively invisible layer warms the inactive period in
parallel. One display layer is recreated against the selected period's
uniquely named source, avoiding MapLibre's same-z/x/y raster-cache collision
while retaining both source caches.

The map has no persistent title card: the legend carries the product identity.
Selecting a labelled area opens a top-left information card with the period,
context statement, verification status, and linked area-specific sources.

## Publishing the website

The source site remains in this private repository. GitHub Pages is served from
the separate public repository
[`angusmcb/south_sudan`](https://github.com/angusmcb/south_sudan), at
[`https://angusmcb.com/south_sudan/`](https://angusmcb.com/south_sudan/).
Only the contents of `viewer/` are exported; no other source files or private
repository history are published.

After committing viewer changes in this repository, publish them with:

```bash
git subtree push --prefix=viewer viewer-pages main
```

`viewer-pages` is the Git remote for `angusmcb/south_sudan`. The exported
repository includes `viewer/.github/workflows/pages.yml` as its root Pages
workflow, which serves the static files from the repository root. Do not edit
the public repository directly; make changes here and republish them.

## Building and publishing a period

First produce a three-band evidence COG with `scripts/export_viewer_ee.py`
(Open Buildings) or `scripts/prepare_viewer_evidence.py` (model presence COGs).
On the CPU tile VM run, for example:

```bash
python scripts/build_viewer_tiles.py evidence-war.tif war.pmtiles \
  --pmtiles-bin "$HOME/bin/pmtiles" \
  --publish-release next-release-id --publish-period war
```

The builder verifies the archive before publishing. `--public-bucket` defaults
to `south-sudan-buildings-tiles`; publication uses immutable cache headers and
refuses to overwrite an existing release object. Update `TILE_RELEASE_URL` in
`app.js` only after all periods and manifests for the release are present.
