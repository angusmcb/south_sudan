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

The viewer reads the public zoom-normalised Yei v3 release directly from:

```text
https://storage.googleapis.com/south-sudan-buildings-tiles/
  releases/yei-v3/tiles/war.pmtiles
  releases/yei-v3/tiles/post.pmtiles
```

The bucket permits anonymous reads and cross-origin `GET`/`HEAD` range
requests. Its policy is reproduced by `config/viewer_bucket_cors.json`.

Each lossless WebP tile contains data channels rather than final colours:

- R: significant building-presence loss evidence;
- G: significant gain evidence;
- B: unchanged/stable building evidence.

`app.js` retrieves sparse tiles through the PMTiles client, decodes the WebP,
applies the active light/dark palette and hands a transparent styled PNG to
MapLibre. At z6–15 the channels are saturating aggregates that preserve sparse
change; z16 is binary building-scale detail. The aggregate saturation is
constant through z13 and scales with pixel area at z14–15, while the browser
raises the minimum opacity of nonzero change toward detail. Dense changed
settlements therefore retain visual strength as their internal gaps appear.
Stable buildings use a quiet grey underlay.

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
  --publish-release yei-v3 --publish-period war
```

The builder verifies the archive before publishing. `--public-bucket` defaults
to `south-sudan-buildings-tiles`; publication uses immutable cache headers and
refuses to overwrite an existing release object. Update `TILE_RELEASE_URL` in
`app.js` only after all periods and manifests for the release are present.
