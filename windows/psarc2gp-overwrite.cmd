@echo off
rem "Send To" target: like psarc2gp.cmd, but replaces .gp files that already exist.
setlocal
node "%~dp0..\bin\psarc2gp.js" --force %*
if errorlevel 1 (
  echo.
  echo Some files could not be converted - see the messages above.
  pause
) else (
  echo.
  echo Done. This window closes in 10 seconds.
  timeout /t 10 >nul
)
