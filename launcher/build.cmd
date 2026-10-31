@echo off
REM Rebuilds ..\MenchatBuilder.exe (needs Go: https://go.dev/dl/)
cd /d "%~dp0"
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H=windowsgui -s -w" -o ..\MenchatBuilder.exe .
pause
