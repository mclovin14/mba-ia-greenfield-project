#!/usr/bin/env bash
# Generates .large-fixtures/video-10gib.mp4: a valid MP4 of exactly 10 GiB
# (h264 1920x1080 + aac) for test/videos-10gib.large-spec.ts.
#
# Random-noise frames barely compress, so libx264 ultrafast -qp 1 (Constrained
# Baseline 4:2:0, browser-decodable) fills the volume in ~25 s. ffmpeg stops
# 64 MiB short of the target and a top-level `free` atom pads the file to the
# exact size, which keeps it a valid MP4. Idempotent: an existing file with
# the exact size is kept.
set -euo pipefail

cd "$(dirname "$0")/.."

readonly TARGET_BYTES=10737418240
readonly ENCODE_LIMIT_BYTES=$((TARGET_BYTES - 64 * 1024 * 1024))
readonly OUT_DIR=.large-fixtures
readonly OUT="$OUT_DIR/video-10gib.mp4"
readonly TMP="$OUT.partial"

if [[ -f "$OUT" && "$(stat -c %s "$OUT")" -eq "$TARGET_BYTES" ]]; then
  echo "$OUT already exists with $TARGET_BYTES bytes; skipping."
  exit 0
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT" "$TMP"

echo "Encoding $OUT (this writes ~10 GiB)..."
ffmpeg -hide_banner -loglevel error -y \
  -f rawvideo -pix_fmt yuv420p -s 1920x1080 -r 30 -i /dev/urandom \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -map 0:v -map 1:a \
  -c:v libx264 -preset ultrafast -qp 1 \
  -c:a aac \
  -fs "$ENCODE_LIMIT_BYTES" \
  -f mp4 "$TMP"

encoded=$(stat -c %s "$TMP")
pad=$((TARGET_BYTES - encoded))
if ((pad < 8 || pad > 0xFFFFFFFF)); then
  echo "Unexpected encoded size $encoded: cannot pad with a single free atom." >&2
  exit 1
fi

# Top-level `free` atom: 32-bit big-endian size + 'free', then zeros.
hex=$(printf '%08x' "$pad")
printf "\\x${hex:0:2}\\x${hex:2:2}\\x${hex:4:2}\\x${hex:6:2}free" >>"$TMP"
truncate -s "$TARGET_BYTES" "$TMP"

streams=$(ffprobe -v error -show_entries stream=codec_name,width,height \
  -of csv=p=0 "$TMP")
if ! grep -qx 'h264,1920,1080' <<<"$streams" || ! grep -qx 'aac' <<<"$streams"; then
  echo "ffprobe did not find h264 1920x1080 + aac streams:" >&2
  echo "$streams" >&2
  exit 1
fi
if [[ "$(stat -c %s "$TMP")" -ne "$TARGET_BYTES" ]]; then
  echo "Final size differs from $TARGET_BYTES bytes." >&2
  exit 1
fi

mv "$TMP" "$OUT"
echo "Generated $OUT ($TARGET_BYTES bytes): $(tr '\n' ' ' <<<"$streams")"
