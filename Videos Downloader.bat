@echo off
rem Double-click to open Videos Downloader (run "npm install" once first).
cd /d "%~dp0"
start "" "node_modules\electron\dist\electron.exe" .
