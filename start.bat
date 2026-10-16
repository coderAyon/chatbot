@echo off
setlocal
title Gono Bishwabidyalay AI Chatbot
cd /d "%~dp0"

echo ================================================================
echo   Gono Bishwabidyalay AI Chatbot ^& Helpdesk
echo   Starting Backend API Server (Port 8787)...
echo   Starting Frontend Web App (Port 5173)...
echo ================================================================
echo.

:: Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js is not installed or not found in system PATH!
  echo Please install Node.js from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

:: Check if node_modules exists, install if missing
if not exist "node_modules\" (
  echo [INFO] First time setup: Installing npm packages...
  call npm install
  if %errorlevel% neq 0 (
    echo [ERROR] Failed to install packages.
    pause
    exit /b 1
  )
)

echo [INFO] Launching your browser at http://127.0.0.1:5173 in 3 seconds...
:: Open browser asynchronously after giving servers a few seconds to boot
start "" cmd /c "ping 127.0.0.1 -n 4 >nul & start http://127.0.0.1:5173"

echo [INFO] Chatbot is running! Keep this window open.
echo [INFO] To stop the chatbot, close this window or press Ctrl+C.
echo.
call npm start

if %errorlevel% neq 0 (
  echo.
  echo [INFO] Server stopped.
  pause
)
