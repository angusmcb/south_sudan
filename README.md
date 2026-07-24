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

`app.js` retrieves sparse tiles through the PMTiles client, decodes each WebP
once, applies the active light/dark palette and hands two transparent styled
PNGs to MapLibre: an unchanged-settlement underlay and a loss/gain overlay. At
z3–14 the channels are saturating aggregates that preserve sparse change.
Below z13, the saturation count doubles per coarser zoom so dense loss and gain
remain distinguishable instead of both clipping to 255; at z14 it scales with
pixel area to retain detail. Weak aggregate change density at z3–10 is
progressively suppressed instead of colouring almost every settlement red or
green.

At z9–14, the change overlay uses decoded source-cell counts and a local
consensus footprint equivalent to
9×9 z14 cells (about 86 m). Because every pyramid level uses a different
nonlinear saturation constant, the browser first inverts that encoding back to
approximate source-cell counts. It then requires at least 12 changed source
cells at z14 density and a 55% directional majority. The window is 1×1 at
z9–11, then 3×3, 5×5 and 9×9 through z14. The minimum changed-cell count scales
with the number of finest-grid cells represented by that window, removing the
easy/hard alternation between successive pyramid levels. Inconclusive
neighbourhoods are transparent, revealing the neutral underlay; no display
halo expands individual red or green cells.

The current aggregate-only z3–14 archives cover all of South Sudan and its
50 km buffer. War has 124,119 addressed tiles (38.94 MiB) and post-agreement
has 132,142 (42.92 MiB); empty tiles are absent. Stable evidence has a
browser-side opacity floor at every zoom so unchanged settlement remains
visible.

Both periods' paired sources are attached when the map loads. PMTiles still
transfers only byte ranges for tiles in the current viewport—not either
complete archive—but effectively invisible layers warm the inactive period in
parallel. The two display layers are recreated against the selected period's
uniquely named sources, avoiding MapLibre's same-z/x/y raster-cache collision
while retaining both source caches.

The small display-settings control can switch from the minimal committed
background to OpenFreeMap (Positron in light mode, Dark in dark mode) or Esri
World Imagery. OpenFreeMap water polygons and linework appear from zoom 8,
while its internal administrative boundaries, protected-area fill and building
fill are omitted. International and disputed-country boundary lines remain.
The two contextual basemaps are mutually exclusive and always remain beneath
the evidence layers.
Boundaries and rivers toggle only this viewer's bundled Natural Earth GeoJSON;
they do not modify OpenFreeMap. Light/dark selection recolours both the viewer
chrome and evidence tiles and is stored locally in the browser.

The map has no persistent title card: the legend carries the product identity.
Selecting a labelled area opens a top-left information card with the period,
context statement, verification status, and linked area-specific sources.

## Experimenting with the change visualisation

Visual styling happens in `app.js` after the lossless WebP data tile is decoded,
so these experiments do **not** require rebuilding or republishing the PMTiles.
Run the local server above, edit `app.js`, then hard-refresh the page. Keep the
same place and zoom in the URL hash when comparing variants.

The main controls are:

| Control | Location | Effect |
| --- | --- | --- |
| Change colours | `THEME.light.rust` / `.teal` and the matching dark values | Endpoint colours for loss and gain. |
| Unchanged colour | `THEME.*.underlay` | Separate neutral settlement underlay. |
| 9×9 footprint | `targetDiameter` in `styleConsensusChange()` | Ground area used to decide the local direction. Increase `9` for smoother, broader evidence; decrease it for more detail/noise. |
| Minimum change support | `12 / 81` in `styleConsensusChange()` | Required changed-cell density. Increase `12` to hide small changes and errors; decrease it to reveal weaker changes. Keep `81` equal to 9×9 if the footprint stays 9. |
| Directional majority | `dominance < 0.55` in `styleConsensusChange()` | How decisive loss or gain must be. Increase toward 1 for only very one-sided change; decrease toward 0.5 for more coverage. |
| Change opacity | `changeAlphaFloor()` and `directionalDensity * 4` | Minimum opacity by zoom and how quickly dense evidence becomes opaque. |
| Overview filtering | `minimumSignedEvidence()` | Suppresses weak red/green evidence at zooms below 9. |
| Unchanged filtering | `minimumStableEvidence()` and `stableAlphaFloor()` | Controls where the neutral settlement layer appears and how strong it is. |
| Consensus transition | `if (zoom >= 9)` in `styleEvidenceTiles()` | Zoom at which the local-window method replaces aggregate overview styling. |

For a useful comparison sequence, test the same edit at Yei (clear loss),
Rumbek (mixed/noisy urban signal), Aweil/Wau (diffuse rural settlement), and a
sparse refugee-camp or border site. Capture each at zooms 8, 9, 10, 11, and
13. A sound setting should add detail as one zooms in without reversing the
dominant colour or turning uninhabited land into settlement.

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
