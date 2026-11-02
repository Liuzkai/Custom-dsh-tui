# 把本机的定制反向拉回仓库（维护自己的机器时用）。
#
#   pwsh -File scripts/collect.ps1            # 复制本机 -> 仓库
#   pwsh -File scripts/collect.ps1 -DryRun    # 只看差异
#
# 只同步"确实该进仓库"的文件。profile 的 cordis.patch.yml **不在**列里：
# 本机那份由 tt-switch 生成、含 provider id 与内网地址，仓库里只放脱敏模板。

[CmdletBinding()]
param([switch]$DryRun)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$BinDir = Join-Path $DshHome 'bin'

$files = @(
  'dsh-tui.cmd',
  'dst.cmd',
  'sync-dsh-tui-tt-switch.mjs',
  'sync-dsh-tui-tt-switch.ps1',
  'sync-dsh-tui-codebuddy.mjs'
)

Write-Host "收集本机定制 -> $RepoRoot"
$updated = 0
foreach ($name in $files) {
  $src = Join-Path $BinDir $name
  $dst = Join-Path $RepoRoot "bin\$name"
  if (-not (Test-Path $src)) { Write-Host "  缺失 $src，跳过"; continue }
  $same = (Test-Path $dst) -and ((Get-FileHash $src -Algorithm SHA256).Hash -eq (Get-FileHash $dst -Algorithm SHA256).Hash)
  if ($same) { Write-Host "  未变 $name"; continue }
  if ($DryRun) { Write-Host "  [dry-run] 会更新 $name"; $updated++; continue }
  Copy-Item $src $dst -Force
  Write-Host "  已更新 $name"
  $updated++
}
Write-Host ''
Write-Host $(if ($DryRun) { "预演：$updated 个文件会更新" } else { "完成：$updated 个文件更新" })
Write-Host '提交前记得跑一遍敏感词扫描（见 AGENTS.md「验证纪律」）。'
