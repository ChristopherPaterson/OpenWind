# Data sources

Every dataset OpenWind uses, where it comes from, how often it changes, and the terms it comes with. The
user-facing version is `web/public/credits.html`. When adding a source, add it here and there, and to the map
footer in `web/src/App.tsx` if the map shows it.

## Forecast models

| Model | Provider | Grid | Runs | Fields used | Licence |
|---|---|---|---|---|---|
| GFS | NOAA / NCEP | 0.25°, hourly to 120 h then 3-hourly | 00, 06, 12, 18 UTC | Wind, gust, pressure, rain, temperature, cloud, visibility, CAPE, 250 hPa wind | Public domain |
| GFS-Wave | NOAA / NCEP | 0.25° | 6-hourly | Waves, swell partitions, wind waves | Public domain |
| ECMWF IFS (open data) | ECMWF | 0.25°, 3-hourly | 00, 06, 12, 18 UTC | Wind, gust, pressure, rain, temperature, cloud, CAPE, upper wind, ocean surface currents | CC BY 4.0, "contains modified ECMWF open data" |
| ECMWF WAM | ECMWF | 0.25° | 6-hourly | Waves | CC BY 4.0 |
| ICON (global) | Deutscher Wetterdienst | 13 km, regridded to 0.25° | 00, 12 UTC | Wind, gust, pressure, temperature, cloud, CAPE, rain | CC BY 4.0 |
| GWAM | Deutscher Wetterdienst | 0.25° | 00, 12 UTC | Waves, combined swell | CC BY 4.0 |

GFS and ECMWF come from the Google Cloud public mirrors (`global-forecast-system`, `ecmwf-open-data`) using
byte ranges from each file's index; DWD from opendata.dwd.de. None needs an account.

ECMWF's currents are its ocean model's surface current, without tides. Near coasts and in tidal waters the
real current can be very different.

## Map

| Dataset | Provider | Used for | Licence |
|---|---|---|---|
| Land polygons and coastlines | OpenStreetMap, via osmdata.openstreetmap.de | Basemap tiles (`infra/basemap/`) | ODbL, "© OpenStreetMap contributors" |
| Geostationary infrared imagery | NASA GIBS (NOAA GOES-East and GOES-West, JMA Himawari) | Satellite overlay, loaded by the browser straight from NASA | Free to use with credit |
| Noto Sans | Google | Map labels (`web/public/fonts`) | SIL Open Font Licence |

## Not used

- **Radar:** no free worldwide source with terms that allow it.
