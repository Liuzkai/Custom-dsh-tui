# 一键还原：把仓库里的定制装进 $DSH_HOME（默认 ~/.dsh）。
#
#   pwsh -File scripts/install.ps1                 # 装（幂等，可反复跑）
#   pwsh -File scripts/install.ps1 -DryRun         # 只看会改哪些文件
#   pwsh -File scripts/install.ps1 -SkipProfile    # 只装 bin/ 垫片
#   pwsh -File scripts/install.ps1 -AddToPath      # 顺便把 $DSH_HOME/bin 加到用户 PATH
#
# 默认**只复制文件**，不碰环境变量、不删任何东西、不覆盖已有的 profile 补丁
# （除非显式 -Force）。PATH 那步要 -AddToPath 才做，因为它改的是整台机器的环境。
#
# 装完看 README 的「装完要自己填的两件事」。

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$SkipProfile,
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$BinDir = Join-Path $DshHome 'bin'
$ProfileDir = Join-Path $DshHome 'profiles' 'dsh-tui'

$script:changed = 0
$script:skipped = 0

function Say([string]$Message) { Write-Host "  $Message" }

# 复制一个文件；目标已存在且内容相同就跳过，内容不同则备份后覆盖（仅 -Force）。
function Install-File {
  param([string]$Source, [string]$Target)
  $name = Split-Path $Target -Leaf
  if (-not (Test-Path $Source)) { Say "缺少源文件 $Source，跳过 $name"; $script:skipped++; return }
  if (Test-Path $Target) {
    $same = (Get-FileHash $Source -Algorithm SHA256).Hash -eq (Get-FileHash $Target -Algorithm SHA256).Hash
    if ($same) { Say "已是最新 $name"; $script:skipped++; return }
    if (-not $Force) { Say "保留现有 $name（内容不同；加 -Force 才能覆盖）"; $script:skipped++; return }
    if ($DryRun) { Say "[dry-run] 备份并覆盖 $Target"; $script:changed++; return }
    $backup = "$Target.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $Target $backup
    Say "已备份 $name -> $(Split-Path $backup -Leaf)"
  }
  if ($DryRun) { Say "[dry-run] 复制 -> $Target"; $script:changed++; return }
  New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
  Copy-Item $Source $Target -Force
  Say "已安装 $name"
  $script:changed++
}

Write-Host 'dsh-tui 定制还原'
Write-Host "  仓库: $RepoRoot"
Write-Host "  DSH_HOME: $DshHome"
if ($DryRun) { Write-Host '  模式: 预演（不落盘）' }
Write-Host ''

# ── 1. 启动垫片与同步脚本 ────────────────────────────────────────────────────
Write-Host 'bin/'
foreach ($file in @(
    'dsh-tui.cmd',
    'dst.cmd',
    'sync-dsh-tui-tt-switch.mjs',
    'sync-dsh-tui-tt-switch.ps1',
    'sync-dsh-tui-codebuddy.mjs'
  )) {
  Install-File -Source (Join-Path $RepoRoot "bin\$file") -Target (Join-Path $BinDir $file)
}

# 垫片要生效，$DSH_HOME/bin 必须在 PATH 上且排在 npm 全局 bin 之前。
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $userPath) { $userPath = '' }
$onPath = ($userPath -split ';') -contains $BinDir
if ($onPath) {
  Say "$BinDir 已在用户 PATH 上"
} elseif ($AddToPath) {
  if ($DryRun) {
    Say "[dry-run] 把 $BinDir 加到用户 PATH 最前面"
    $script:changed++
  } else {
    [Environment]::SetEnvironmentVariable('Path', "$BinDir;$userPath", 'User')
    Say "已把 $BinDir 加到用户 PATH 最前面（新开终端生效）"
    $script:changed++
  }
} else {
  Say "提示：$BinDir 不在 PATH 上，垫片不会自动生效。"
  Say '      加 -AddToPath 让本脚本代劳，或自己把这个目录加到 PATH 最前面。'
}

# ── 2. profile 模板 ─────────────────────────────────────────────────────────
if ($SkipProfile) {
  Write-Host ''
  Write-Host 'profile/  (已跳过)'
} else {
  Write-Host ''
  Write-Host 'profile/'
  $manifest = Join-Path $ProfileDir 'package.json'
  if (Test-Path $manifest) {
    # 已有 profile 说明用户装过 dsh-tui：不拿模板覆盖人家的 bundle 列表。
    Say 'profile 已存在，保留原有 package.json'
    $script:skipped++
  } else {
    Install-File -Source (Join-Path $RepoRoot 'profile\package.json.template') -Target $manifest
  }
  foreach ($pair in @(
      @{ Src = 'profile\pnpm-workspace.yaml';       Dst = 'pnpm-workspace.yaml' },
      @{ Src = 'profile\cordis.patch.yml.template'; Dst = 'cordis.patch.yml' }
    )) {
    $dst = Join-Path $ProfileDir $pair.Dst
    # 补丁层常由别的工具（tt-switch 之类）维护，绝不静默覆盖。
    if (Test-Path $dst) {
      Say "保留现有 $($pair.Dst)"
      $script:skipped++
      continue
    }
    Install-File -Source (Join-Path $RepoRoot $pair.Src) -Target $dst
  }
}

Write-Host ''
if ($DryRun) {
  Write-Host "预演完成：$($script:changed) 处会改动，$($script:skipped) 处保持不变。"
} else {
  Write-Host "完成：$($script:changed) 处改动，$($script:skipped) 处保持不变。"
  Write-Host ''
  Write-Host '下一步（见 README「装完要自己填的两件事」）：'
  Write-Host '  1. 装 dsh-tui 本体： dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.18.0'
  Write-Host '  2. 按需填 profile/cordis.patch.yml（默认模型、欢迎页）'
  Write-Host '  3. 新开终端跑 dsh-tui 验证'
}
