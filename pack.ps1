# 发布专用脚本：把上一级目录（自用/源码）的运行时文件同步到本目录，再打包成可上传的 zip。
# 用法：powershell -ExecutionPolicy Bypass -File publish\pack.ps1   （在根目录执行）
#       或进入 publish 目录后执行  .\pack.ps1
# 若 publish 被单独拷走（找不到上级源码），则跳过同步、直接用本目录现有文件打包。
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$runtime = @("manifest.json", "content.js", "popup.html", "popup.js", "icons")
$root = Split-Path $PSScriptRoot -Parent

if (Test-Path (Join-Path $root "manifest.json")) {
    foreach ($f in $runtime) {
        Copy-Item (Join-Path $root $f) -Destination . -Recurse -Force
    }
    Write-Host "已从源码目录同步运行时文件。"
}
else {
    Write-Host "未找到上级源码目录，跳过同步，直接打包本目录文件。"
}

$name = "bilibili-fav-hider"
$version = (Get-Content manifest.json -Raw -Encoding UTF8 | ConvertFrom-Json).version
$zip = "$name-v$version.zip"
if (Test-Path $zip) { Remove-Item $zip }

# zip 只含运行时文件 + LICENSE + README（脚本与 .gitignore 不进包）
$items = @("manifest.json", "content.js", "popup.html", "popup.js", "icons", "LICENSE", "README.md")
$staging = Join-Path $env:TEMP "$name-$version"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory $staging | Out-Null
foreach ($f in $items) { Copy-Item $f -Destination $staging -Recurse }
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath (Join-Path $PSScriptRoot $zip)
Remove-Item $staging -Recurse -Force
Write-Host "已打包: $zip"
