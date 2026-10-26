@echo off
rem "Send To" target: converts the selected .psarc files or folders into synced Guitar Pro files.
setlocal
node "%~dp0..\bin\psarc2gp.js" %*
if errorlevel 1 (
  echo.
  echo Some files could not be converted - see the messages above.
  pause
) else (
  echo.
  echo Done. This window closes in 10 seconds.
  timeout /t 10 >nul
)
