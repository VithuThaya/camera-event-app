#!/usr/bin/env bash
#
# Wandelt alle .webm-Videos in einem Ordner nach .mp4 (H.264/AAC) um — das
# Format, das jedes Programm und jedes Gerät ohne Murren abspielt.
#
# Die App bleibt unberührt: Slideshow und Galerie spielen weiter webm. Das hier
# läuft NUR auf der ZIP, die der Host heruntergeladen hat, auf dem eigenen Mac.
#
# Benutzung:
#   ./scripts/webm-to-mp4.sh ~/Downloads/event-fotos
#
#   (ohne Argument nimmt es den aktuellen Ordner)
#
# Die Original-.webm bleiben liegen. Wenn alles gut aussieht, kannst du sie
# hinterher von Hand löschen.

set -euo pipefail

DIR="${1:-.}"

if [ ! -d "$DIR" ]; then
  echo "Ordner nicht gefunden: $DIR" >&2
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg fehlt. Installieren mit:  brew install ffmpeg" >&2
  exit 1
fi

# Alle .webm einsammeln (auch in Unterordnern), Leerzeichen-sicher.
count=0
converted=0
while IFS= read -r -d '' file; do
  count=$((count + 1))
  out="${file%.webm}.mp4"

  if [ -f "$out" ]; then
    echo "⏭  überspringe (existiert schon): $out"
    continue
  fi

  echo "🎬 $file  →  $(basename "$out")"
  # -movflags +faststart: das mp4 spielt sofort, ohne erst ganz zu laden.
  # -crf 20: sehr gute Qualität bei vernünftiger Größe.
  if ffmpeg -nostdin -loglevel error -i "$file" \
      -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
      -c:a aac -b:a 160k \
      -movflags +faststart "$out"; then
    converted=$((converted + 1))
  else
    echo "⚠️  Fehler bei: $file" >&2
  fi
done < <(find "$DIR" -type f -iname '*.webm' -print0)

echo ""
if [ "$count" -eq 0 ]; then
  echo "Keine .webm-Dateien in '$DIR' gefunden."
else
  echo "✓ Fertig: $converted von $count konvertiert."
  echo "  Die Original-.webm liegen noch da — bei Bedarf löschen."
fi
