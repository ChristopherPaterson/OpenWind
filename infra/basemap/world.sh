#!/bin/sh
# The world's land and coastline from OpenStreetMap (ODbL), as vector tiles for the map:
#   data/basemap/world/land   layer `land`  (zoom 0 to 11), from OSM land polygons
#   data/basemap/world/coast  layer `coast` (zoom 0 to 11), from OSM coastlines
# Needs land.zip and coast.zip in data/basemap-work (refresh.sh downloads them). Run from the repository root:
#   docker run --rm -v "$PWD/data:/data" -v "$PWD/infra/basemap:/build:ro" debian:trixie-slim sh /build/world.sh
set -eu
apt-get update -qq && apt-get install -y -qq --no-install-recommends tippecanoe gdal-bin unzip >/dev/null
W=/data/basemap-work
cd "$W"
build() { # build <zip> <folder in the zip> <shapefile> <layer> <output>
  rm -rf "$2" && unzip -q "$1"
  ogr2ogr -f GeoJSONSeq "$4.geojsonseq" "$2/$3"
  rm -rf "$2"
  tippecanoe -q -f -e "$5" -l "$4" -Z0 -z11 --no-tile-compression --simplification=4 \
    --detect-shared-borders --drop-smallest-as-needed --coalesce-densest-as-needed --read-parallel \
    --attribution "© OpenStreetMap contributors" "$4.geojsonseq"
  rm -f "$4.geojsonseq"
}
build land.zip land-polygons-split-4326 land_polygons.shp land world-land
build coast.zip coastlines-split-4326 lines.shp coast world-coast
mkdir -p /data/basemap/world
for t in land coast; do
  rm -rf "/data/basemap/world/$t" && mv "world-$t" "/data/basemap/world/$t"
done
echo "{\"built\":\"$(date -u +%Y-%m-%dT%H:%MZ)\",\"source\":\"osmdata.openstreetmap.de land polygons and coastlines, ODbL\"}" > /data/basemap/world/meta.json
du -sh /data/basemap/world/*
