@echo off
setlocal
title Validate Wan2GP MCP Launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Wan2GP-MCP-Launcher.ps1" -Action Validate

if errorlevel 1 (
  echo.
  echo Validation failed. Review the results above.
  pause
)
endlocal
