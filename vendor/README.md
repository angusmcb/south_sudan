# Vendored front-end libraries

Self-hosted so the site has no third-party runtime dependency and works offline
(`index.html` opened locally must render). Both are BSD-3-Clause.

| File | Package | Version | Source |
|---|---|---|---|
| `maplibre-gl.js`, `maplibre-gl.css` | maplibre-gl | 4.7.1 | https://unpkg.com/maplibre-gl@4.7.1/dist/ |
| `pmtiles.js` | pmtiles | 3.2.1 | https://unpkg.com/pmtiles@3.2.1/dist/pmtiles.js |

To refresh (pin the version, then re-vendor):

```bash
curl -sSL -o maplibre-gl.js  https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js
curl -sSL -o maplibre-gl.css https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css
curl -sSL -o pmtiles.js      https://unpkg.com/pmtiles@3.2.1/dist/pmtiles.js
```
