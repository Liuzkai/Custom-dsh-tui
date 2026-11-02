# Custom dsh-tui

我在本机对 [dsh-tui](https://github.com/ccch1mneyyy/dsh-TUI)（`@deepseek-harness-tui/dsh-tui`，基线 0.18.0）
做的改动合集。目标是**换一台机器、让 AI 读这个仓库就能把我的环境复原出来**，同时把后续迭代也
攒在这里。

上游包本体一行没改——所有定制都在包外面（`$DSH_HOME/bin` 的启动垫片 + profile 配置层），
所以 `dsh-tui update` 升级上游不会冲掉这些改动。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `bin/dsh-tui.cmd` | 启动垫片。放在 `~/.dsh/bin`（在 npm 全局 bin 之前），每次启动先跑两个同步脚本，再把 argv 原样交给真正的启动器 |
| `bin/dst.cmd` | `dst` 短别名的垫片，转到上面那个 |
| `bin/sync-dsh-tui-tt-switch.mjs` | 把 tt-switch 维护在 `profiles/web/cordis.patch.yml` 的模型路由同步进 `dsh-tui` profile |
| `bin/sync-dsh-tui-codebuddy.mjs` | 把本地 CodeBuddy 会话增量导入 dsh-tui 会话库 |
| `profile/*` | profile 层的模板（自有 bundle 列表、补丁层、pnpm 设置） |
| `scripts/install.ps1` | 一键还原：把 `bin/` 装到 `$DSH_HOME/bin`，按需铺 profile 模板 |
| `docs/` | 各改造的设计与踩坑记录 |

## 两个垫片做什么

`bin/dsh-tui.cmd` 是这套东西的入口。它住在 `$DSH_HOME/bin`，而那个目录排在你 PATH 里 npm
全局 bin 的前面，所以敲 `dsh-tui` 会先经过它：

```
dsh-tui.cmd
  ├─ sync-dsh-tui-tt-switch.mjs --quiet     # 刷新模型路由
  ├─ sync-dsh-tui-codebuddy.mjs   --quiet   # 增量导入 CodeBuddy 会话
  └─ 真正的启动器（npm 全局那份）
```

两个同步互相独立，各有逃生开关：

| 环境变量 | 作用 |
| --- | --- |
| `DSH_TUI_NO_TT_SWITCH_SYNC=1` | 跳过模型路由同步 |
| `DSH_TUI_NO_CODEBUDDY_SYNC=1` | 跳过 CodeBuddy 导入 |
| `DSH_TUI_LAUNCHER=<path>` | 指定真正的启动器，跳过自动探测 |

### 为什么要垫片

两边的问题同源：**dsh-tui 是独立 profile，不共享别的 profile 的配置**。

- tt-switch 只往 `profiles/web` 写模型路由，`dsh-tui` profile 看不到，`/model` 里就没有那些路由。
- dsh-tui 的会话迁移源是编译期常量（claude-code / codex / omp / zcode / grok-build），没有
  CodeBuddy，也没有 adapter 注册接缝，想把 CodeBuddy 历史带进来只能自己铺路。

垫片这种方式的好处是升级不丢：它在包外，`dsh-tui update` 和重装 npm 包都碰不到；代价是
每次启动多一次 Node 冷启动（约 100–250 ms）。

## 装完要自己填的两件事

`scripts/install.ps1` 只铺**结构与脚本**，运行环境相关的两件事必须按机器自己填：

1. **装 dsh-tui 本体**

   ```powershell
   dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.18.0
   ```

   模板里的 `profile/package.json.template` 只列了最小 bundle 集；你要多装实验插件（会话搜索、
   自动 review、worktree 之类）就自己往 `dependencies` 和 `dsh.profile.bundles` 里加。

2. **填 profile 补丁层** `$DSH_HOME/profiles/dsh-tui/cordis.patch.yml`

   模板只留一个空数组 `[]`。要让 tt-switch 同步生效，先装 tt-switch 并让它往 `profiles/web`
   写一次路由；之后每次启动垫片会自动把那段拷过来。默认模型改 `agent-default-model`。

   > ⚠️ 那个 `[]` **不能删**。dsh 解析这一层时要求顶层是 YAML 数组，**全是注释的文件会被解析成
   > `null` 并直接抛错**（`must be a top-level YAML array of loader patch entries`），dsh-tui 就
   > 起不来了。手工清空这个文件时务必留下 `[]`。

**密钥绝不写进这些文件。** dsh 的 provider 配置用 `apiKeyEnv: <变量名>` 指向用户环境变量，
或者交给 `$DSH_HOME/.credentials.yaml` 管。本仓库里没有任何密钥，也不该有。

## 还原步骤（给另一个机器上的 AI 看）

```powershell
git clone https://github.com/Liuzkai/Custom-dsh-tui.git
cd Custom-dsh-tui

# 1) 预演，确认会在你的机器上改哪些文件
pwsh -File scripts/install.ps1 -DryRun

# 2) 真装（幂等，可反复跑；不覆盖你已有的 profile 补丁）
pwsh -File scripts/install.ps1 -AddToPath

# 3) 装 dsh-tui 本体（见上一节）
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.18.0

# 4) 新开一个终端，验证
dsh-tui --version
```

`-AddToPath` 会把 `$DSH_HOME/bin` 插到用户 PATH 最前面。不加也行，但要自己保证垫片被先找到，
否则 `dsh-tui` 直接走 npm 那份，同步脚本不跑。

### 验证清单

| 检查 | 期望 |
| --- | --- |
| `Get-Command dsh-tui.cmd` 解析到 `$DSH_HOME/bin` | 垫片在 PATH 里优先 |
| `dsh-tui --version` | 正常输出版本，且启动时能看到同步脚本的提示（有新会话时） |
| `node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs --status` | 打印源目录、目标会话库、已导入数量 |
| `node $DSH_HOME/bin/sync-dsh-tui-tt-switch.mjs --dry-run` | 打印会写进 profile 的补丁内容 |

## 各改造的细节

- [`docs/codebuddy-sync.md`](docs/codebuddy-sync.md) — CodeBuddy 会话导入：格式映射、增量策略、
  实测数据
- [`docs/tt-switch-sync.md`](docs/tt-switch-sync.md) — 模型路由同步
- [`docs/launcher-shim.md`](docs/launcher-shim.md) — 启动垫片的设计与 PATH 前提
- [`AGENTS.md`](AGENTS.md) — 给 AI 的作业说明（改这里的规矩、验证方式）

## 与上游的关系

这些都是**本机定制**，不是上游补丁。其中 CodeBuddy 迁移是有机会进上游的（写个
`adapters/codebuddy.parse.ts` 注册进 `MIGRATION_ADAPTERS` 即可）；真进了上游，把
`dsh-tui.cmd` 里对应的那段调用删掉就能退回原生。

## 许可证

MIT，见 [LICENSE](LICENSE)。
