@echo off
title GitHub Release Helper
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0push-to-github.ps1"
if %errorlevel% neq 0 (
    pause
)
