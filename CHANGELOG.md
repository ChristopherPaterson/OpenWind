# Changelog

## Unreleased

- Highs and lows no longer pile up when zoomed out: they are map symbols now, and where they crowd only the
  strongest shows; the rest come back as the map zooms in.

## 1.0.0

First release.

- Map of wind (with isobars and highs and lows), gusts, rain, rain over 24 hours, temperature, cloud,
  visibility, storms (CAPE), jet stream, waves, swell and ECMWF ocean currents, shaded on the device with
  animated particles; particles can show a second field.
- Models: NOAA GFS and GFS-Wave, ECMWF IFS and WAM, DWD ICON and GWAM, fetched as they are published.
- Point chart with every model's wind and gusts on one set of axes, plus waves and currents; hover values on
  computers.
- Satellite infrared overlay from NASA GIBS.
- Units, temperature scale and time zone settings.
- Docker Compose deployment: ingest, API and Caddy web server, hardened containers, OpenStreetMap basemap
  build.
