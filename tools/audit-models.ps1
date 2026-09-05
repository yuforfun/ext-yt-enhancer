# 功能: Windows 工作排程器呼叫用的包裝腳本
# input: 無
# output: 執行 audit-models.mjs 並將輸出寫入 log
# 備註:
#   - 工作排程器設定範例:
#       程式: powershell.exe
#       引數: -ExecutionPolicy Bypass -File "D:\ProjectsCode\ext-yt-enhancer\tools\audit-models.ps1"
#       開始位置: D:\ProjectsCode\ext-yt-enhancer

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$logDir = Join-Path $scriptDir 'reports'

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir | Out-Null
}

$dateStr = Get-Date -Format 'yyyy-MM-dd'
$logFile = Join-Path $logDir "audit-$dateStr.log"

Set-Location $repoRoot
& node "$scriptDir\audit-models.mjs" *>&1 | Tee-Object -FilePath $logFile
exit $LASTEXITCODE
