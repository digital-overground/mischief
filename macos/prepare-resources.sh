#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
resources="$1"
identity="$2"
version=v22.16.0
archive="node-$version-darwin-arm64.tar.gz"
mkdir -p .cache "$resources"
if [[ ! -f ".cache/$archive" ]]; then
  curl --fail --location --silent --show-error "https://nodejs.org/dist/$version/$archive" -o ".cache/$archive"
fi
curl --fail --location --silent --show-error "https://nodejs.org/dist/$version/SHASUMS256.txt" -o .cache/SHASUMS256.txt
expected="$(awk -v name="$archive" '$2 == name {print $1}' .cache/SHASUMS256.txt)"
[[ -n "$expected" ]] && echo "$expected  .cache/$archive" | shasum -a 256 -c -
[[ "$(uname -m)" == arm64 ]] || { echo 'arm64 Mac required' >&2; exit 1; }
tar -xOf ".cache/$archive" "node-$version-darwin-arm64/bin/node" > "$resources/node"
chmod +x "$resources/node"
codesign --force --sign "$identity" --options runtime --entitlements node.entitlements "$resources/node"
PATH="$resources:$PATH" ./node_modules/.bin/esbuild page.tsx --bundle --minify --format=iife --outfile="$resources/page.js"
PATH="$resources:$PATH" ./node_modules/.bin/esbuild host.ts --bundle --platform=node --format=esm --outfile="$resources/Host.mjs"
cp index.html app.css "$resources/"
cp ../shared/theme/tokens.css "$resources/theme.css"
cp -R ../shared/theme/fonts "$resources/fonts"
xcrun swift icon.swift ../vscode-extension/media/icon.png "$resources/Mischief.png"
sips -s format icns "$resources/Mischief.png" --out "$resources/Mischief.icns" >/dev/null
rm "$resources/Mischief.png"
