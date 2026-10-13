# EdgeTunnel GitHub 快速发布助手 (PowerShell 版本)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host " 🚀 EdgeTunnel 开源版本发布助手 (release 环境)" -ForegroundColor Cyan
Write-Host " 📂 当前仓库路径: $ScriptDir" -ForegroundColor Gray
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

# 检查当前是否有关联远程仓库
$originCheck = git remote -v | Select-String "origin"
if (!$originCheck) {
    Write-Host "[提示] 检测到当前仓库尚未绑定 GitHub 远程仓库 (origin)！" -ForegroundColor Yellow
    $defaultUrl = "https://github.com/aihddelyy/edgetunnel-gateway.git"
    Write-Host "预设默认仓库地址: $defaultUrl" -ForegroundColor Green
    
    $inputUrl = Read-Host "请输入您的 GitHub 仓库地址 (直接按回车即使用预设地址)"
    if ([string]::IsNullOrWhiteSpace($inputUrl)) {
        $repoUrl = $defaultUrl
    } else {
        $repoUrl = $inputUrl.Trim()
    }

    git remote add origin $repoUrl
    git branch -M master
    Write-Host ""
    Write-Host "✔ 已成功关联远程仓库: $repoUrl" -ForegroundColor Green
} else {
    Write-Host "✔ 当前已关联远程仓库: $($originCheck[0])" -ForegroundColor Green
}

Write-Host ""
Write-Host "正在准备提交与推送到 GitHub..." -ForegroundColor Yellow
git add .
git commit --no-gpg-sign -m "release: update open source release" --allow-empty | Out-Null

Write-Host "正在推送到 GitHub master 分支..." -ForegroundColor Yellow
git push -u origin master

if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Cyan
    Write-Host " 🎉 发布成功！最新脱敏开源版本已推送到 GitHub。" -ForegroundColor Green
    Write-Host " 🌐 仓库地址: https://github.com/aihddelyy/edgetunnel-gateway" -ForegroundColor Cyan
    Write-Host "========================================================" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "========================================================" -ForegroundColor Red
    Write-Host " ⚠️ 推送遇到问题，请检查网络连接或 GitHub 访问凭据。" -ForegroundColor Red
    Write-Host " (若使用 HTTPS 推送，首次可能需要登录 GitHub 或输入 Personal Access Token)" -ForegroundColor Gray
    Write-Host "========================================================" -ForegroundColor Red
}

Write-Host ""
Read-Host "按回车键退出..."
