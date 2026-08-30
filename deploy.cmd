@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\deploy.ps1"
if errorlevel 1 (
  echo.
  echo Deployment stopped. Review the message above.
  pause
  exit /b 1
)
echo.
echo Remote deployment completed.
pause
