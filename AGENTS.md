# AGENTS.md

给在本仓库工作、或要用本仓库复原/维护 dsh-tui 定制的 AI 的作业说明。

## 这个仓库是什么

不是 dsh-tui 的 fork，是**包外定制**的合集：`$DSH_HOME/bin` 里的启动垫片 + `$DSH_HOME/profiles/dsh-tui`
的配置模板 + 还原脚本。上游包本体一行没改——动手前请保持这个前提，不要把它变成 patch 上游。

## 复原一台新机器

```powershell
git clone https://github.com/Liuzkai/Custom-dsh-tui.git
cd Custom-dsh-tui
pwsh -File scripts/install.ps1 -DryRun     # 先预演
pwsh -File scripts/install.ps1 -AddToPath  # 再真装
dsh plugin --profile dsh-tui add @deepseek-harness-tui/dsh-tui@0.18.0
```

然后按 README 的「装完要自己填的两件事」补：dsh-tui 本体、profile 补丁层。密钥只走环境变量或
`$DSH_HOME/.credentials.yaml`，**任何情况下都不写进仓库文件**。

装完按 README 的验证清单逐条跑，别只看 `dsh-tui --version` 就说完事——垫片静默失效是这套东西
最可能的坏法，必须验证 `Get-Command dsh-tui.cmd` 解析到 `$DSH_HOME/bin`。

## 改东西的规矩

- **只改包外**。改 `$DSH_HOME/bin` 或 profile 配置；不要 patch
  `node_modules/@deepseek-harness-tui/dsh-tui` 里的任何文件（`dsh-tui update` 会冲掉）。
- **同步脚本要快且安静**。它们在每次启动的路径上：无变化时应当静默退出、亚秒级完成。新增同步
  一定带增量状态和 `--quiet`。
- **失败不阻塞启动**。同步脚本 exit 1 之外都算跳过；退出码语义见
  `docs/launcher-shim.md`，别自己造新语义。
- **不要把本机路径写死**。用 `$DSH_HOME`、`$HOME`、`process.execPath` 推导，别写
  `C:\Users\<名字>`。本机专用的值（用户名、内网地址、provider id）留在本机，不进仓库。
- **文档跟代码一起改**。`docs/` 里三篇分别对应三个改造；改行为就更新对应那篇和 README 的表格。

## 三条容易被"顺手改坏"的线

1. **CodeBuddy 转换的 `rawContent` 是块数组**，不是单对象。写成 `rawContent.type === ...` 会静默
   丢失全部思考过程——这正是本仓库第一版踩过的坑。改解析逻辑后一定要用 `--dry-run` 抽查导入
   数量，并用读回脚本确认 reasoning 块还在。
2. **盘符大小写归一**。CodeBuddy 记小写盘符，不归一会在会话库分裂出重复的工程目录。
3. **PATH 顺序**。垫片靠"排在 npm 全局 bin 前面"生效。任何改动 PATH 的脚本都要显式说明这点，
   且默认不要擅自修改用户环境变量（`install.ps1` 的 `-AddToPath` 就是为此存在）。

## 验证纪律

- 任何行为改动，先在一个隔离的 `DSH_HOME` 里跑通（`$env:DSH_HOME = <临时目录>`），别直接写真实
  会话库。导入类改动要验「幂等」（连跑两次，第二次 0 改动）和「不扰动已有数据」（对已有会话
  文件做哈希比对）。
- 耗时数字写进 docs 时要标明场景（冷启动/稳态/单个新会话）。
- 结论只能来自实际运行。没跑过的项写"未验证"，不要拿"应该可以"糊过去。

## 上游可能接手的方向

CodeBuddy 迁移有机会进上游：写 `adapters/codebuddy.parse.ts`（纯函数，原始文本 → 轮模型）注册进
`MIGRATION_ADAPTERS`，格式映射见 `docs/codebuddy-sync.md`。真进了上游就把 `bin/dsh-tui.cmd` 里
对应那段调用删掉，本仓库相应简化。
