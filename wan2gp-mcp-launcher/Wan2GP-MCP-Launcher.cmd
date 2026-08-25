@echo off
setlocal
title Wan2GP MCP Launcher

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Wan2GP-MCP-Launcher.ps1"

if errorlevel 1 (
  echo.
  echo The launcher reported an error. Review the message above.
  pause
)
endlocal
