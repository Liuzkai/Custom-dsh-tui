# 兼容旧命令：实现已经迁到同目录的 Node 版（sync-dsh-tui-tt-switch.mjs）。
# 直接运行本脚本仍然可用，参数原样透传（--quiet / --dry-run）。
& node (Join-Path $PSScriptRoot 'sync-dsh-tui-tt-switch.mjs') @args
exit $LASTEXITCODE
