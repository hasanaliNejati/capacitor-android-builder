@echo off
REM Rebuilds AppBuilder.exe and MenchatBuilder.exe (needs Go: https://go.dev/dl/)
cd /d "%~dp0"
if not exist scripts mkdir scripts
copy /y ..\scripts\*.mjs scripts\ >nul
if not exist assets mkdir assets
copy /y ..\src\assets\* assets\ >nul
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -ldflags "-H=windowsgui -s -w" -o AppBuilder.exe .
if %ERRORLEVEL% EQU 0 (
    copy /y AppBuilder.exe ..\MenchatBuilder.exe >nul 2>&1
    echo Successfully built AppBuilder.exe
) else (
    echo Build failed!
)
