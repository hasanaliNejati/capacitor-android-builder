#!/bin/sh
set -e
cd "$(dirname "$0")"
mkdir -p scripts && cp ../scripts/*.mjs scripts/
mkdir -p assets && cp ../src/assets/* assets/
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o AppBuilder.exe .
cp AppBuilder.exe ../MenchatBuilder.exe 2>/dev/null || true
echo "built AppBuilder.exe"
