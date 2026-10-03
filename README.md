# Relief Studio – 3D-printable relief maps of the Alps (and beyond)

Relief Studio turns real elevation data into **tiled, 3D-printable relief maps** that you print
on an ordinary FDM printer and assemble into a piece of wall art.

* Pick any area of **the Alps** (or 20 other mountain ranges – or anywhere on Earth with live data)
  on a map, with ready-made presets like *Matterhorn & Monte Rosa*, *Dolomites* or *The whole Alps*.
* Choose your **printer** – the artwork is split into tiles that fit the bed, and you see the tile
  grid on the map and in 3D.
* Preview the piece **as it would hang on your wall**, in your own **filament colours** (colour
  changes at layer heights, silk/matte/marble/wood finishes) and in several **art styles**:
  classic relief, terraced contours, low-poly, ridgelines, hex columns, contour lines and lithophane.
* Get **filament, time and cost estimates** per colour and per tile.
* Export **watertight STL (or 3MF) files** for every tile, plus a printable **print & assembly plan**
  with colour-change layers, labels and a shopping list.

Everything runs locally in your browser; there is no server-side code.

<!-- SCREENSHOT -->

## Quick start

```bash
git clone <this repo> && cd <repo>
npm start            # → http://localhost:4173   (any static file server works)
```

No build step and no runtime dependencies – Node is only used for the tiny static server and the
tests. You can also serve the folder with `python3 -m http.server` or publish it with
GitHub Pages (`.github/workflows/pages.yml`, enable *Settings → Pages → Source: GitHub Actions*).

<!-- USAGE -->

## Elevation data

The repository ships with preprocessed elevation data in `data/` (see
[docs/DATA_FORMAT.md](docs/DATA_FORMAT.md)):

<!-- DATA_TABLE -->

Outside these regions the app can fetch **live data for anywhere on Earth** from the
[AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) open dataset (internet connection
required).

### Adding or upgrading regions

```bash
pip install -r pipeline/requirements.txt
python3 pipeline/build.py tatra                      # rebuild a predefined region (pipeline/regions.py)
python3 pipeline/build.py --custom my-area "My Area" 46 7 47 9 --glo30 all   # any whole-degree box
python3 pipeline/verify.py my-area                   # compare against the source GeoTIFFs
```

Downloads are cached in `.cache/copernicus` (override with `RELIEF_CACHE=/path`).

## Development

* Architecture and module contracts: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
* Unit tests (Node 22, no dependencies): `npm test`
* End-to-end tests (Playwright + Chromium): `npm install && npx playwright install chromium && npm run e2e`

## Licences & attribution

* Code: MIT (see `LICENSE`). Vendored libraries keep their own licences (`app/vendor/*/LICENSE`):
  three.js (MIT), Leaflet (BSD-2-Clause), fflate (MIT), Delatin (ISC).
* Elevation data: *Contains modified Copernicus DEM data (GLO-30/GLO-90) © DLR e.V. 2010-2014 and
  © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and
  ESA; all rights reserved.* Free to use and redistribute under the
  [Copernicus DEM licence](https://spacedata.copernicus.eu/documents/20123/121286/CSCDA_ESA_Mission-specific+Annex_31_Oct_22.pdf).
  Live data: AWS Terrain Tiles (Mapzen; sources include SRTM, GMTED, ETOPO1, NED, EU-DEM and others).
* Base maps: © OpenStreetMap contributors, OpenTopoMap (CC-BY-SA), Esri World Imagery.
