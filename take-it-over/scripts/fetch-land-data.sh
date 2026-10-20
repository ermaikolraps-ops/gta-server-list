#!/usr/bin/env bash
# Downloads the default land mask: Natural Earth 1:10m land + lakes (public domain).
# For production-grade coastlines use OSM land polygons instead (see docs/land-data.md).
set -euo pipefail
cd "$(dirname "$0")/../data"
BASE=https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson
for f in ne_10m_land ne_10m_lakes; do
  if [ ! -s "$f.geojson" ]; then
    echo "downloading $f..."
    curl -fsSL --retry 3 -o "$f.geojson.tmp" "$BASE/$f.geojson"
    mv "$f.geojson.tmp" "$f.geojson"
  fi
done
echo "land data ready in $(pwd)"
