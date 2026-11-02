#!/usr/bin/env node
/**
 * 把 CodeBuddy 的本地会话增量同步进 dsh-tui 的会话库。
 *
 * 背景：dsh-tui 0.18.0 的迁移源是编译期常量（claude-code / codex / omp /
 * zcode / grok-build），没有 CodeBuddy。但 CodeBuddy 的落盘形态与 Claude Code
 * 几乎同构（同样的 `projects/<munged-cwd>/<sessionId>.jsonl`，同样有
 * `subagents/`），所以这里把记录改字段名后，交给 dsh-tui **自带的** claude-code
 * 迁移管线去落盘——标题、工作目录、工具配对、去重、压缩检查点都还是官方逻辑。
 *
 * 与同目录 sync-dsh-tui-tt-switch.mjs 同一个模式：每次 dsh-tui 启动跑一遍
 * （见 dsh-tui.cmd），只处理自上次以来改动过的会话，因此稳态下只有一次目录
 * 遍历的开销；导入本身是幂等的（官方用源会话 id 生成确定性 UUID）。
 *
 * 用法：
 *   node sync-dsh-tui-codebuddy.mjs            增量同步
 *   node sync-dsh-tui-codebuddy.mjs --quiet    只报错（启动垫片用）
 *   node sync-dsh-tui-codebuddy.mjs --dry-run  只列将导入的会话，不写盘
 *   node sync-dsh-tui-codebuddy.mjs --status   看状态文件与上次同步结果
 *   node sync-dsh-tui-codebuddy.mjs --force    忽略状态，重扫全部源会话
 *   node sync-dsh-tui-codebuddy.mjs --only <sessionId>  只处理一个会话
 *
 * 退出码：0 完成或无事可做；1 同步失败；2 没有 CodeBuddy 数据（跳过）；
 *         3 profile 未就绪（跳过）；4 另一个实例正在同步（跳过）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { register } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const quiet = argv.includes('--quiet') || argv.includes('-q')
const dryRun = argv.includes('--dry-run')
const force = argv.includes('--force')
const statusOnly = argv.includes('--status')
const onlyIndex = argv.indexOf('--only')
const only = onlyIndex === -1 ? undefined : argv[onlyIndex + 1]

const log = (message) => {
  if (!quiet) process.stdout.write(`dsh-tui: ${message}\n`)
}
/** --quiet 下也要说的一句：真的在导入，别让启动看起来像卡住了。 */
const notice = (message) => {
  process.stdout.write(`dsh-tui: ${message}\n`)
}
const warn = (message) => process.stderr.write(`dsh-tui: ${message}\n`)

// 启动垫片里已经给了显式开关；直接调用脚本时也认它，免得两边行为不一致。
if (process.env.DSH_TUI_NO_CODEBUDDY_SYNC === '1' && !dryRun && !statusOnly) process.exit(0)

const MAX_SOURCE_BYTES = 64 * 1024 * 1024 // 官方适配器的单文件上限
const LOCK_STALE_MS = 10 * 60 * 1000

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const codebuddyRoot = process.env.CODEBUDDY_HOME
  ? join(process.env.CODEBUDDY_HOME, 'projects')
  : join(homedir(), '.codebuddy', 'projects')
const statePath = join(dshHome, 'codebuddy-sync.state.json')
const workRoot = join(dshHome, 'codebuddy-sync')
const lockPath = join(workRoot, 'lock')
const profileMigrateDir = join(
  dshHome, 'profiles', 'dsh-tui', 'node_modules',
  '@deepseek-harness-tui', 'dsh-tui', 'lib', 'types', 'dsh-adapter', 'migrate',
)
/** 目标会话库：与官方 CLI 的解析顺序一致（DSH_TUI_SESSION_ROOT → $DSH_HOME/sessions）。 */
const sessionRoot = resolvePath(process.env.DSH_TUI_SESSION_ROOT?.trim() || join(dshHome, 'sessions'))

/**
 * 状态：每个源会话文件上一次同步的指纹。只记「已导入」的，跳过的下次重试。
 * 指纹带着「导到哪个会话库」：换了 DSH_TUI_SESSION_ROOT 就把记录作废，否则
 * 隔离试跑留下的记录会让真实会话库以为已经导过了。
 */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'))
    if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
      if (parsed.sessionRoot === sessionRoot) return parsed
    }
  } catch {}
  return { version: 1, sessionRoot, sessions: {} }
}
function writeState(state) {
  mkdirSync(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ ...state, sessionRoot }, null, 2)}\n`, 'utf8')
  renameSync(temporary, statePath)
}

if (statusOnly) {
  const state = readState()
  const ids = Object.keys(state.sessions)
  process.stdout.write(`源目录: ${codebuddyRoot}\n`)
  process.stdout.write(`目标会话库: ${sessionRoot}\n`)
  process.stdout.write(`状态文件: ${statePath}\n`)
  process.stdout.write(`已导入并记录: ${ids.length} 个会话\n`)
  const recent = ids
    .map((id) => ({ id, ...state.sessions[id] }))
    .sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0))
    .slice(0, 10)
  for (const entry of recent) {
    const when = entry.importedAt ? new Date(entry.importedAt).toISOString() : '(未知)'
    process.stdout.write(`  ${entry.id}  ${when}\n`)
  }
  process.exit(0)
}

// ── 前置检查：没有源或 profile 未就绪就安静退出，别在每次启动时吵人 ──────────
if (!existsSync(codebuddyRoot)) process.exit(2) // 这台机器没装 CodeBuddy
if (!existsSync(profileMigrateDir)) process.exit(3) // profile 还没装好，下次再说

// ── 单实例锁：两个窗口同时启动时不要让它们一起写会话库 ──────────────────────
function acquireLock() {
  mkdirSync(workRoot, { recursive: true })
  try {
    const holder = Number(readFileSync(lockPath, 'utf8').trim())
    if (Number.isFinite(holder) && holder > 0) {
      try {
        process.kill(holder, 0) // 只探测存活，不真的发信号
        if (Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS) return false
      } catch {
        // 持有者已经退出：接管
      }
    }
  } catch {
    // 没有锁文件就是没人在跑
  }
  writeFileSync(lockPath, String(process.pid), 'utf8')
  return true
}
function releaseLock() {
  try {
    if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) rmSync(lockPath, { force: true })
  } catch {}
}

if (!dryRun && !acquireLock()) process.exit(4)

// ── 转换用的小工具（`const` 有 TDZ：必须在下面的 sync() 调用之前求值）──────────
/** CodeBuddy content 块 → Claude content 块。 */
function toBlock(block) {
  if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
    return { type: 'text', text: block.text }
  }
  if (block.type === 'reasoning_text') return { type: 'thinking', thinking: block.text }
  if (block.type === 'image') return { type: 'image' }
  return undefined
}
const parseArguments = (value) => {
  if (typeof value !== 'string') return value ?? {}
  try {
    return JSON.parse(value)
  } catch {
    return { input: value }
  }
}

try {
  await sync()
} catch (error) {
  warn(`同步失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  if (!dryRun) releaseLock()
}

async function sync() {
  const state = readState()
  if (force) state.sessions = {}

  // ── 1. 找出改动过的源会话 ────────────────────────────────────────────────
  const changed = []
  let total = 0
  for (const project of readdirSync(codebuddyRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const dir = join(codebuddyRoot, project.name)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      // 只认 <project>/<sessionId>.jsonl；<sessionId>/subagents/ 属于父会话，不单独成篇。
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const path = join(dir, entry.name)
      const sessionId = entry.name.slice(0, -'.jsonl'.length)
      if (only !== undefined && sessionId !== only) continue
      total += 1
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (stat.size > MAX_SOURCE_BYTES) continue
      const known = state.sessions[sessionId]
      if (known && !force && known.mtimeMs === stat.mtimeMs && known.size === stat.size) continue
      changed.push({ path, sessionId, projectDir: project.name, mtimeMs: stat.mtimeMs, size: stat.size })
    }
  }

  if (changed.length === 0) {
    log(`CodeBuddy 会话无变化（共 ${total} 个源会话）。`)
    return
  }

  // ── 2. 转换到临时 staging（只放本次要导入的） ────────────────────────────
  const staging = join(workRoot, `staging-${process.pid}`)
  const converted = []
  const skipped = []
  try {
    mkdirSync(join(staging, 'projects'), { recursive: true })
    for (const item of changed) {
      let records
      try {
        records = convert(readFileSync(item.path, 'utf8'), item.sessionId)
      } catch (error) {
        skipped.push({ ...item, reason: `读取失败：${error.message}` })
        continue
      }
      if (!records.hasPrompt) {
        skipped.push({ ...item, reason: '没有人类提问（只有机器注入）' })
        continue
      }
      if (records.cwd !== undefined && !existsSync(records.cwd)) {
        // 工作目录不在（盘没挂载时常见）：导入后 /resume 打开会失败，不如先跳过。
        skipped.push({ ...item, reason: `工作目录不存在：${records.cwd}` })
        continue
      }
      const dir = join(staging, 'projects', item.projectDir)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `${item.sessionId}.jsonl`), records.text, 'utf8')
      converted.push(item)
    }

    if (dryRun) {
      process.stdout.write(`[codebuddy] ${converted.length} 个会话待导入（源共 ${total} 个，本次改动 ${changed.length} 个）\n`)
      for (const item of converted) process.stdout.write(`  · ${item.sessionId}\n`)
      for (const item of skipped) process.stdout.write(`  - 跳过 ${item.sessionId}：${item.reason}\n`)
      return
    }

    if (converted.length === 0) {
      log(`没有可导入的会话（跳过 ${skipped.length} 个）。`)
      return
    }

    // ── 3. 交给官方迁移 CLI ────────────────────────────────────────────────
    notice(`正在导入 ${converted.length} 个 CodeBuddy 会话…`)
    const imported = await importBatch(staging)
    if (!imported) {
      // 官方 CLI 失败时保留状态，下次启动重试。
      return
    }

    // 只有真正走完导入的才记指纹：跳过的和失败的下次还会重试。
    for (const item of converted) {
      state.sessions[item.sessionId] = {
        mtimeMs: item.mtimeMs,
        size: item.size,
        importedAt: Date.now(),
        projectDir: item.projectDir,
      }
    }
    writeState(state)
    notice(`已导入 ${converted.length} 个 CodeBuddy 会话` +
      (skipped.length > 0 ? `，跳过 ${skipped.length} 个` : '') +
      `（源共 ${total} 个）。`)
  } finally {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {}
  }
}

// ── 转换：CodeBuddy 行 → Claude Code transcript 行 ─────────────────────────
/**
 * 一个 CodeBuddy transcript 文本 → Claude Code transcript 文本。
 * @returns {{ text: string, hasPrompt: boolean, cwd: string|undefined }}
 */
function convert(raw, sessionId) {
  const out = []
  let hasPrompt = false
  let cwd
  // CodeBuddy 记小写盘符（g:\…），DSH 的工程目录名与「当前目录」都按原样比较：
  // 不归一化会让同一个工程分裂成 --g-… 与 --G-… 两个目录。
  const normalizeCwd = (value) => (typeof value === 'string'
    ? value.replace(/^([a-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
    : value)

  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue // 单条坏行不拖垮整篇，与官方解析器同口径
    }
    const head = {
      sessionId: record.sessionId ?? sessionId,
      cwd: normalizeCwd(record.cwd),
      timestamp: record.timestamp,
    }
    if (cwd === undefined && typeof head.cwd === 'string' && head.cwd !== '') cwd = head.cwd
    const chain = record.parentId === undefined ? {} : { parentUuid: record.parentId }

    if (record.type === 'message' && (record.role === 'user' || record.role === 'assistant')) {
      const blocks = (Array.isArray(record.content) ? record.content : [])
        .map(toBlock)
        .filter((block) => block !== undefined && !(block.type === 'text' && block.text === ''))
      if (blocks.length === 0) continue
      if (record.role === 'user' && blocks.some((block) => block.type === 'text')) hasPrompt = true
      const model = record.providerData?.model
      out.push({
        type: record.role,
        ...head,
        ...chain,
        uuid: record.id,
        message: { id: record.id, role: record.role, content: blocks, ...(model ? { model } : {}) },
      })
    } else if (record.type === 'reasoning') {
      // rawContent 是块数组（与 message.content 同形），元素 type=reasoning_text。
      const blocks = Array.isArray(record.rawContent) ? record.rawContent : []
      const text = blocks
        .filter((block) => block?.type === 'reasoning_text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n\n')
        .trim()
      if (text === '') continue
      // 同一次模型调用里 reasoning 与 function_call 共用 messageId：换成 messageId
      // 才能在 Claude 侧并进同一个 step。
      out.push({
        type: 'assistant',
        ...head,
        ...chain,
        uuid: record.id,
        message: {
          id: record.providerData?.messageId ?? record.id,
          role: 'assistant',
          content: [{ type: 'thinking', thinking: text }],
        },
      })
    } else if (record.type === 'function_call') {
      out.push({
        type: 'assistant',
        ...head,
        ...chain,
        uuid: record.id,
        message: {
          id: record.providerData?.messageId ?? record.id,
          role: 'assistant',
          content: [{
            type: 'tool_use',
            id: record.callId,
            name: record.name,
            input: parseArguments(record.arguments),
          }],
        },
      })
    } else if (record.type === 'function_call_result') {
      const text = typeof record.output?.text === 'string'
        ? record.output.text
        : (record.output === undefined ? '' : JSON.stringify(record.output))
      out.push({
        type: 'user',
        ...head,
        ...chain,
        uuid: record.id,
        message: {
          id: record.providerData?.messageId ?? record.id,
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: record.callId,
            content: text,
            ...(record.status === 'completed' ? {} : { is_error: true }),
          }],
        },
      })
    } else if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim() !== '') {
      out.push({ type: 'ai-title', aiTitle: record.aiTitle, sessionId: head.sessionId, cwd: record.cwd })
    }
    // session-meta / turn-metrics / file-history-snapshot / summary 与对话无关，丢弃。
  }
  return { text: out.map((record) => JSON.stringify(record)).join('\n') + '\n', hasPrompt, cwd }
}

// ── 调用官方迁移链路 ───────────────────────────────────────────────────────
/** dsh 全局安装的包根，用来兜底解析 @deepseek-ai/*。 */
function findDshPackage() {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', '@deepseek-ai', 'dsh'),
    join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
  ]
  return candidates.find((candidate) => existsSync(join(candidate, 'package.json')))
}

/** 让 profile 的编译产物能解析 @deepseek-ai/*：先按它自己的位置找，找不到再落到 dsh 自带那份。 */
function installResolveFallback(dshPackage) {
  if (dshPackage === undefined) return
  const dshManifest = join(dshPackage, 'package.json').replace(/\\/g, '/')
  // 用 data: URL 注册，不在用户的目录里留第二个文件。
  const source = `
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(${JSON.stringify(dshManifest)});
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (!specifier.startsWith('@deepseek-ai/')) throw error;
    try {
      return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
    } catch {
      throw error;
    }
  }
}
`
  register(`data:text/javascript,${encodeURIComponent(source)}`, import.meta.url)
}

/** 把 staging 里的会话交给官方 claude-code 适配器导入。 */
async function importBatch(staging) {
  const dshPackage = findDshPackage()
  if (dshPackage === undefined && !existsSync(join(dshHome, 'profiles', 'dsh-tui', 'node_modules', '@deepseek-ai', 'cordis'))) {
    warn('跳过同步：找不到 dsh 安装目录，无法解析迁移管线依赖。')
    return false
  }
  installResolveFallback(dshPackage)

  let claudeCodeAdapter
  let cliMigrate
  try {
    ;({ claudeCodeAdapter } = await import(pathToFileURL(join(profileMigrateDir, 'adapters', 'claude-code.js')).href))
    ;({ cliMigrate } = await import(pathToFileURL(join(profileMigrateDir, 'cli.js')).href))
  } catch (error) {
    warn(`跳过同步：迁移管线加载失败（${error instanceof Error ? error.message : String(error)}）。`)
    return false
  }

  // 只扫 staging，不碰真实的 ~/.claude/projects。
  const originalRoots = claudeCodeAdapter.roots
  claudeCodeAdapter.roots = () => [join(staging, 'projects')]
  // --quiet 时 CLI 自己会往 stdout 打导入进度；启动垫片不该被这些行刷屏。
  const originalWrite = process.stdout.write.bind(process.stdout)
  if (quiet) process.stdout.write = () => true
  try {
    const code = await cliMigrate(['claude-code'])
    return code === 0
  } finally {
    if (quiet) process.stdout.write = originalWrite
    claudeCodeAdapter.roots = originalRoots
  }
}
