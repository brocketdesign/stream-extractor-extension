#!/usr/bin/env bash
# Builds a store-ready zip for the Chrome Web Store and the Opera add-ons
# gallery. Both take the same Chromium MV3 package, so there is one artifact.
#
#   ./tools/package.sh
#
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

version="$(node -p "require('./manifest.json').version")"
out="dist/stream-extractor-${version}.zip"

mkdir -p dist
rm -f "$out"

# Ship only what the extension loads at runtime.
zip -r -q "$out" \
  manifest.json \
  src \
  vendor \
  icons \
  LICENSE \
  -x '*.DS_Store'

echo "built $out ($(du -h "$out" | cut -f1))"
echo
echo "contents:"
unzip -Z1 "$out" | sed 's/^/  /'
