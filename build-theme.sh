#!/bin/bash
set -e

VERSION=$(node -p "require('./package.json').version")
OUTPUT="komari-theme-v${VERSION}.zip"

echo "Building $OUTPUT..."

npm run build

zip -r "$OUTPUT" komari-theme.json dist/

echo "Created: $OUTPUT"
