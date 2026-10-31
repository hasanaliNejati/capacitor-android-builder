#!/bin/sh
# Rebuilds ../MenchatBuilder.exe (needs Go; llvm-windres only if app.rc/app.ico changed).
set -e
cd "$(dirname "$0")"
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o ../MenchatBuilder.exe .
echo "built ../MenchatBuilder.exe"
