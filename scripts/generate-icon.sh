#!/usr/bin/env bash
# Regenerate icons/icon{16,32,48,128}.png from a 1024px master raster.
#
# Requires ImageMagick (`magick`) and the macOS "SignPainter" system font
# (SignPainter-HouseScriptSemibold). If that font isn't available, swap
# FONT below for another script/cursive face (e.g. Snell-Roundhand-Bold).
#
# Usage: scripts/generate-icon.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/icons"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FONT="SignPainter-HouseScriptSemibold"
GRADIENT_FROM="#0ea5e9"   # sky blue
GRADIENT_TO="#10b981"     # emerald green

# Diagonal gradient background, clipped to a rounded square.
magick -size 1600x1600 gradient:"${GRADIENT_FROM}-${GRADIENT_TO}" \
  -rotate 45 -gravity center -extent 1024x1024 "$TMP/grad.png"
magick -size 1024x1024 xc:none -fill white -draw "roundrectangle 0,0 1023,1023 200,200" "$TMP/mask.png"
magick "$TMP/grad.png" "$TMP/mask.png" -compose DstIn -composite "$TMP/bg.png"

# Script "S" centered on top.
magick "$TMP/bg.png" -font "$FONT" -pointsize 860 -fill white \
  -gravity center -annotate -40-30 "S" "$TMP/master.png"

mkdir -p "$OUT"
for size in 16 32 48 128; do
  magick "$TMP/master.png" -filter Lanczos -resize "${size}x${size}" "$OUT/icon${size}.png"
done

echo "Wrote $OUT/icon{16,32,48,128}.png"
