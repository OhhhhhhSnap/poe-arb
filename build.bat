@echo off
title PoE Arb — Build Installer
color 0E

:: Auto-elevate to Administrator if not already running as admin
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -Command "Start-Process -FilePath '%~dpnx0' -WorkingDirectory '%~dp0' -Verb RunAs"
    exit /b
)

echo.
echo ============================================
echo   PoE Arb — Build Windows Installer
echo ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ERROR: Node.js not found.
    echo Please install it from https://nodejs.org ^(LTS version^)
    pause
    exit /b 1
)

echo [1/3] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)

echo.
echo [2/3] Building Windows installer...
call npm run dist > build-log.txt 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Build failed. Here is the error:
    echo ----------------------------------------
    type build-log.txt
    echo ----------------------------------------
    echo.
    echo Full log saved to: build-log.txt
    echo.
    pause
    exit /b 1
)
type build-log.txt

echo.
echo [3/3] Done!
echo.
echo The installer is in the "release" folder:
echo   PoE Arb Setup 1.0.0.exe
echo.
echo Double-click it to install. The app will appear in your system tray.
echo.
explorer release
pause
