#!/usr/bin/env bash
# Package the extension into a Chrome Web Store-ready zip (dist/trueweb-<version>.zip).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -e "console.log(require('./manifest.json').version)")
OUT="dist/trueweb-${VERSION}.zip"

mkdir -p dist
rm -f "$OUT"

zip -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  content.css \
  popup.html \
  popup.js \
  icons \
  -x '*.DS_Store'

echo "Packaged $OUT"
