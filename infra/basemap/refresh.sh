#!/bin/sh
# Download fresh OpenStreetMap land polygons and coastlines and rebuild the basemap tiles (world.sh).
# Run from the repository root, by hand or monthly from cron; the map keeps working while it runs, and the
# new tiles replace the old ones only when the build finishes.
#   infra/basemap/refresh.sh
set -eu
cd "$(dirname "$0")/../.."
W=data/basemap-work
mkdir -p "$W" data/basemap
for f in land-polygons-split-4326:land.zip coastlines-split-4326:coast.zip; do
  url="https://osmdata.openstreetmap.de/download/${f%%:*}.zip"
  echo "-- $url"
  curl -fsSL --retry 3 -o "$W/${f#*:}.part" "$url"
  mv "$W/${f#*:}.part" "$W/${f#*:}"
done
docker run --rm -v "$PWD/data:/data" -v "$PWD/infra/basemap:/build:ro" debian:trixie-slim sh /build/world.sh
# The web server reads the tiles as uid 1000.
docker run --rm -v "$PWD/data:/d" alpine chown -R 1000:1000 /d/basemap
rm -f "$W/land.zip" "$W/coast.zip"
