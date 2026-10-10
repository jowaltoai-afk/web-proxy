@echo off
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js nahi mila! Pehle https://nodejs.org se LTS version install karo,
  echo  phir ye file dobara chalao.
  echo.
  start https://nodejs.org
  pause
  exit /b
)
cd /d "%~dp0"
if not exist node_modules (
  echo Pehli bar setup ho raha hai, thora wait karo...
  call npm install
  echo.
)
echo.
echo  ============================================
echo   Browser me kholo:  http://localhost:8080
echo   Band karne ke liye ye window close kar do.
echo  ============================================
echo.
node server.js
pause
