@echo off
where pwsh.exe >nul 2>nul
if %errorlevel%==0 (
  pwsh.exe -NoProfile -File "%~dp0Start-Workroom.ps1"
) else (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe" -NoProfile -File "%~dp0Start-Workroom.ps1"
)
if errorlevel 1 pause
