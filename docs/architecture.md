# Architecture

OpenWind is three small services around one data directory. The ingest writes complete run folders
atomically (a temporary name, then a rename), and the API and web server only ever read, so readers never
see half-written data and the ingest can stop without taking the site down.

## Services

The ingest and the API run from one image (`openwind-app`, built from the `Dockerfile`); the web server is
Caddy. All three are defined in `compose.yaml`.

| Service | Command | What it does |
|---|---|---|
| `ingest` | `python -m openwind.ingest --loop` | Every 10 minutes, checks each model for a newer run whose last step is published, downloads only the needed GRIB messages (byte ranges from each file's index), converts to SI units, checks bounds and completeness, and publishes a run folder. Writes `health.json` after every pass. |
| `api` | `uvicorn openwind.api:app` | FastAPI: the model list, point forecasts, map frames and health. Read-only on `data/`. |
| `web` | Caddy | Serves the built web app, run files and basemap tiles, proxies `/v1` to the API, and sets the security headers and cache policy (`infra/Caddyfile`). |

## Data directory

```
data/
  runs/<model>/<YYYYMMDDHH>/   one model run: manifest.json + one .npy per variable (time, lat, lon)
  basemap/world/land/          vector tiles of the world's land (OpenStreetMap land polygons)
  basemap/world/coast/         vector tiles of the world's coastline (OpenStreetMap coastlines)
  icon-nearest.npy             DWD ICON's grid-to-grid mapping, built once (openwind/icon.py)
  health.json                  ingest health, read by /v1/health
```

A run folder is never changed after it is published; a new run is a new folder, and the oldest is deleted
once two newer ones exist. The API memory-maps the `.npy` files, so only the cells a request touches are read
from disk. Variables are float16 (float32 for pressure and temperature, which need the precision); grids are
0.25° worldwide. Everything in `data/` can be rebuilt, so it needs no backup.

## Models

| Id | Model | Source | Notes |
|---|---|---|---|
| `gfs` | NOAA GFS | Google Cloud mirror, byte ranges from `.idx` | Hourly to 120 h, then 3-hourly to 240 h |
| `gfs-wave` | NOAA GFS-Wave | Same | Waves and three swell partitions |
| `ecmwf` | ECMWF IFS | Google Cloud mirror of ECMWF open data | 3-hourly; includes ocean surface currents |
| `ecmwf-wave` | ECMWF WAM | Same | Waves |
| `icon` | DWD ICON global | opendata.dwd.de | Icosahedral grid, regridded to 0.25° by nearest cell |
| `icon-wave` | DWD GWAM | opendata.dwd.de | Waves and combined swell |

Each model's variables, units and conversions are declared in `openwind/sources.py`; adding a variable is
one line there.

## Request paths

- **Map frames.** The browser asks for one variable at one time over a fixed chunk of the world
  (`/v1/frame/<model>/<run>/<var>/<index>?b=...&s=<stride>`). The API cuts the chunk from the memory-mapped
  array and quantises it to one byte per cell (lo, hi, then bytes; 255 = no data). Because the run id is in
  the URL, frames are immutable and the browser caches them forever.
- **Point forecasts** (`/v1/point`) interpolate bilinearly in space (vectors as components, directions as
  unit vectors; land cells in wave grids are dropped and the rest re-weighted). They are limited per address
  and share a CPU budget (`openwind/api.py`).
- **Run files** (`/runs/...`) such as each run's `manifest.json` are served by Caddy straight from the data
  directory.

## Frontend

`web/` is a React 19 + TypeScript app built with Vite, drawing on MapLibre GL.

| File | Role |
|---|---|
| `App.tsx` | Page state (layer, model, time, overlays), URL sync, layer menu, timeline, settings, hover card |
| `WeatherMap.tsx` | The MapLibre map: basemap, shaded weather image, particles, isobars, current arrows, satellite |
| `data.ts` | Frame fetching, decoding and caching; the `Field` type with bilinear lookup |
| `layers.ts` | Layer definitions: variables, units, colour ramps, which model provides them, particle choices |
| `shadeCore.ts`, `shadeClient.ts`, `shade.worker.ts` | Shading fields into images, in a worker |
| `particles.ts`, `currentArrows.ts` | Animated particles; arrows on the currents layer |
| `draw.ts`, `pressure.ts` | Isobars and highs and lows from the pressure field |
| `Meteogram.tsx` | Point chart: every model's wind and gusts, waves and currents |
| `layout.ts` | Places floating panels from measured bars and hides anything that would overlap |
| `settings.ts` | Units and time zone, remembered per device |

Weather is shaded on the device from the quantised frames rather than served as images, so changing colour
ramps, units or the time costs no server work. The build splits MapLibre and React into their own
long-cached chunk, so an update only re-downloads the app's own code.

## Design decisions

- **Raw models, never blended.** Each value names its model and run.
- **Files, not a database.** Model data is large, written once and read by position, which suits
  memory-mapped arrays.
- **Everything cacheable is immutable.** Run ids and content hashes are in URLs; pages are `no-cache`.
- **Nothing to configure.** No accounts, keys or secrets: every source is open data.
