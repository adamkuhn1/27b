#!/usr/bin/env bash
# Join the frames from capture.mjs into 27B's promotional video.
#
#   tools/promo/encode.sh <framesDir> <outDir>
#
# Four 7 s pans joined with 0.5 s crossfades: 26.5 s, under the 30 s that Map
# Tiles policy allows for a promotional video. Every frame already carries the
# Google Maps logo, the data attributions and "For promotional purposes only".
set -euo pipefail

FRAMES=${1:?frames dir}
OUT=${2:?output dir}
FPS=30
SHOT_S=7
FADE_S=0.5
mkdir -p "$OUT"

inputs=()
for i in 0 1 2 3; do
  inputs+=(-framerate "$FPS" -i "$FRAMES/$i/%04d.png")
done

o1=$(echo "$SHOT_S - $FADE_S" | bc)
o2=$(echo "2 * $SHOT_S - 2 * $FADE_S" | bc)
o3=$(echo "3 * $SHOT_S - 3 * $FADE_S" | bc)

ffmpeg -loglevel error -y "${inputs[@]}" -filter_complex "
  [0][1]xfade=transition=fade:duration=$FADE_S:offset=$o1[a];
  [a][2]xfade=transition=fade:duration=$FADE_S:offset=$o2[b];
  [b][3]xfade=transition=fade:duration=$FADE_S:offset=$o3,format=yuv420p[v]" \
  -map "[v]" -c:v libx264 -preset slow -crf 20 -movflags +faststart -an "$OUT/27b-promo.mp4"

ffprobe -v error -show_entries format=duration,size -of default=nw=1 "$OUT/27b-promo.mp4"
