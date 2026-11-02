#!/usr/bin/env node
/**
 * 把 tt-switch 写进 dsh `web` profile 的模型路由，同步到 `dsh-tui` profile。
 *
 * tt-switch 只维护 $DSH_HOME/profiles/web/cordis.patch.yml 里的
 * `llm-pi-ai.providers`（本地代理 http://127.0.0.1:15721/deepseek-harness/<id>/v1），
 * dsh-tui 是独立 profile，不共享这份配置，所以 /model 里默认看不到这些路由。
 *
 * 本脚本从 web 的补丁里原样抠出 `- id: llm-pi-ai` 整段，写进 dsh-tui 的
 * cordis.patch.yml：目标文件里其它条目保留，本次同步的那段整体刷新，因此可重复运行。
 * 每次 dsh-tui 启动都会自动跑一遍（见同目录 dsh-tui.cmd），更新 profile 后也能自愈。
 *
 * 用法：
 *   node sync-dsh-tui-tt-switch.mjs           同步
 *   node sync-dsh-tui-tt-switch.mjs --quiet   只报错（启动垫片用）
 *   node sync-dsh-tui-tt-switch.mjs --dry-run 打印不落盘
 *
 * 退出码：0 已同步/无需改动；2 源缺失（跳过）；3 目标 profile 未初始化（跳过）。
 */
import { existsSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet') || argv.includes('-q')
const dryRun = argv.includes('--dry-run')

const ENTRY_ID = 'llm-pi-ai'
const SOURCE_PROFILE = process.env.TT_SOURCE_PROFILE || 'web'
const TARGET_PROFILE = process.env.TT_TARGET_PROFILE || 'dsh-tui'

const log = (message) => {
  if (!quiet) process.stdout.write(`dsh-tui: ${message}\n`)
}
const warn = (message) => {
  process.stderr.write(`dsh-tui: ${message}\n`)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const sourcePath = join(dshHome, 'profiles', SOURCE_PROFILE, 'cordis.patch.yml')
const targetPath = join(dshHome, 'profiles', TARGET_PROFILE, 'cordis.patch.yml')

/** 顶层条目 = 行首的 `- id: <name>`；条目内容一直到下一个行首 `- ` 为止。 */
function topLevelEntries(lines) {
  const entries = []
  let current
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
    if (idMatch) {
      if (current) current.end = index
      current = { id: idMatch[1], start: index, end: index }
      entries.push(current)
      continue
    }
    if (/^-\s/.test(line)) {
      if (current) current.end = index
      current = undefined
    }
  }
  if (current) current.end = lines.length
  return entries
}

const trimTrailingBlank = (lines) => {
  let end = lines.length
  while (end > 0 && lines[end - 1].trim() === '') end -= 1
  return lines.slice(0, end)
}

if (!existsSync(sourcePath)) {
  warn(`跳过同步：找不到 ${sourcePath}（tt-switch 还没装到 ${SOURCE_PROFILE} profile？）`)
  process.exit(2)
}
if (!existsSync(dirname(targetPath))) {
  // profile 目录还没建：让 dsh-tui 自己自举，下次启动再同步。
  process.exit(3)
}

const sourceLines = readFileSync(sourcePath, 'utf8').split(/\r?\n/)
const sourceEntries = topLevelEntries(sourceLines).filter((entry) => entry.id === ENTRY_ID)
if (sourceEntries.length === 0) {
  warn(`跳过同步：${sourcePath} 里没有 "- id: ${ENTRY_ID}" 条目——先在 tt-switch 里开一次 DeepSeek Harness 集成。`)
  process.exit(2)
}
if (sourceEntries.length > 1) {
  warn(`跳过同步：${sourcePath} 里出现 ${sourceEntries.length} 个 "- id: ${ENTRY_ID}" 条目，拒绝猜测。`)
  process.exit(2)
}

const block = trimTrailingBlank(sourceLines.slice(sourceEntries[0].start, sourceEntries[0].end))
if (!block.some((line) => /^\s+providers:\s*$/.test(line))) {
  warn(`跳过同步：${ENTRY_ID} 段里没有 providers，疑似 tt-switch 写入被改坏，保留现有配置。`)
  process.exit(2)
}

// 目标里除本次同步条目外的条目原样保留，不吞用户手写的内容。
const kept = []
if (existsSync(targetPath)) {
  const targetLines = readFileSync(targetPath, 'utf8').split(/\r?\n/)
  for (const entry of topLevelEntries(targetLines)) {
    if (entry.id === ENTRY_ID) continue
    kept.push(...trimTrailingBlank(targetLines.slice(entry.start, entry.end)))
  }
}

const output = [
  '# dsh profile 用户补丁层：在 bundle 层之后、--patch 覆盖层之前应用。',
  `# 下面的 llm-pi-ai 段由 sync-dsh-tui-tt-switch.mjs 从 profiles/${SOURCE_PROFILE}/cordis.patch.yml`,
  '# 原样复制（tt-switch 本地代理路由），请勿手改：在 tt-switch 里换 provider 后重跑该脚本，',
  '# 或直接重启 dsh-tui —— 启动垫片 dsh-tui.cmd 每次都会先同步一遍。',
  ...block,
]
if (kept.length > 0) output.push('', ...kept)
const nextText = `${output.join('\r\n').trimEnd()}\r\n`

const previousText = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : undefined
if (previousText === nextText) {
  log(`${targetPath} 已是最新（${block.length} 行），无需改动。`)
  process.exit(0)
}

if (dryRun) {
  process.stdout.write(nextText)
  process.exit(0)
}

// 原子写：先写同目录临时文件再改名，避免启动时读到半截 YAML。
const temporary = `${targetPath}.sync-${process.pid}.tmp`
try {
  writeFileSync(temporary, nextText, 'utf8')
  renameSync(temporary, targetPath)
} catch (error) {
  try {
    unlinkSync(temporary)
  } catch {}
  warn(`同步失败，保留原文件 ${targetPath}：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}

log(`已更新 ${targetPath}（${block.length} 行，来自 ${SOURCE_PROFILE}）。重启 dsh-tui 后 /model 里可见这些路由。`)
