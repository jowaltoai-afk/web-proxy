@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist cloudflared.exe (
  echo.
  echo  cloudflared.exe nahi mila!
  echo  Download karo: https://github.com/cloudflare/cloudflared/releases
  echo  "cloudflared-windows-amd64.exe" wali file lo, is folder me rakh kar
  echo  naam "cloudflared.exe" kar do, phir dobara chalao.
  echo.
  pause
  exit /b
)
echo.
echo  Public link ban raha hai... ye window KHULI rakho.
echo  Jo https link mile, wo phone par kholo.
echo.
cloudflared.exe tunnel --url http://localhost:8080
pause
