#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
identity="${SIGN_IDENTITY:-Apple Development}"
app="$PWD/dist/Mischief.app"
rm -rf "$app"
resources="$app/Contents/Resources"
mkdir -p "$app/Contents/MacOS" "$resources"
bash prepare-resources.sh "$resources" "$identity"
xcrun swiftc -swift-version 5 -target arm64-apple-macosx13.0 -framework AppKit -framework WebKit -framework UserNotifications main.swift -o "$app/Contents/MacOS/Mischief"
cp Info.plist "$app/Contents/Info.plist"
codesign --force --sign "$identity" --options runtime "$app"
codesign --verify --strict --deep --verbose=2 "$app"
file "$app/Contents/MacOS/Mischief" "$resources/node"
echo "Built $app"
