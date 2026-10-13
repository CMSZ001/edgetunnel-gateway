@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title GitHub 快速发布助手
echo ========================================================
echo  🚀 EdgeTunnel 开源版本发布助手 (release 环境)
echo  📂 当前仓库路径: %~dp0
echo ========================================================
echo.

cd /d "%~dp0"

:: 检查当前是否有关联远程仓库
git remote -v | findstr "origin" >nul
if %errorlevel% neq 0 (
    echo [提示] 检测到当前仓库尚未绑定 GitHub 远程仓库 (origin)！
    set DEFAULT_URL=https://github.com/aihddelyy/edgetunnel-gateway.git
    echo 预设默认仓库地址: !DEFAULT_URL!
    set /p REPO_URL="请输入您的 GitHub 仓库地址 (直接按回车即使用预设地址): "
    if "!REPO_URL!"=="" set REPO_URL=!DEFAULT_URL!
    
    git remote add origin !REPO_URL!
    git branch -M master
    echo.
    echo ✔ 已成功关联远程仓库: %REPO_URL%
)

echo.
echo 正在执行提交与推送到 GitHub...
git add .
git commit -m "release: update open source release" --allow-empty
git push -u origin master

echo.
if %errorlevel% equ 0 (
    echo ========================================================
    echo  🎉 发布成功！最新脱敏开源版本已推送到 GitHub。
    echo ========================================================
) else (
    echo ========================================================
    echo  ⚠️ 推送遇到问题，请检查网络连接或 GitHub 访问凭据。
    echo ========================================================
)

pause
