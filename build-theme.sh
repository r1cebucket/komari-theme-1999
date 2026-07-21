#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
OUTPUT="komari-theme-v${VERSION}.zip"

echo "Building $OUTPUT..."

npm run build

rm -f "$OUTPUT"

# Pack root-level files first (flat) so the names sit at zip root.
zip -j -X "$OUTPUT" komari-theme.json
zip -j -X "$OUTPUT" static/cover-image.png

# Pack the compiled output under dist/.
zip -r -X "$OUTPUT" dist

echo "Created: $OUTPUT"
