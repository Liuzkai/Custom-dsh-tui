# 启动垫片

`bin/dsh-tui.cmd` 是这套定制的入口。它的全部作用：**每次启动 dsh-tui 之前，先跑几个同步脚本，
再把 argv 原样交给真正的启动器。**

```
dsh-tui.cmd
  ├─ sync-dsh-tui-tt-switch.mjs --quiet
  ├─ sync-dsh-tui-codebuddy.mjs   --quiet
  └─ 真正的启动器（npm 全局那份）
```

## 为什么放 $DSH_HOME/bin

垫片必须住在 **`$DSH_HOME/bin`**（默认 `~/.dsh/bin`），并且那个目录要在 PATH 上、排在 npm
全局 bin **前面**。这样：

- 敲 `dsh-tui` 先命中垫片；
- `dsh-tui update` 和重装 npm 包**碰不到它**（它在包外、也在 profile 外），升级不丢定制。

代价是它是 PATH 顺序敏感的：如果哪天 npm 全局 bin 排到了前面，垫片就静默失效，同步脚本也不跑了。
`scripts/install.ps1` 默认只提示、不擅自改 PATH；要让它代劳加 `-AddToPath`。

## 找真正的启动器

```cmd
if not defined REAL for /f "delims=" %%I in ('where dsh-tui.cmd 2^>nul') do (
  if not defined REAL if /I not "%%~dpI"=="%HERE%" set "REAL=%%~fI"
)
```

按 PATH 顺序找第一个**不在本目录**的 `dsh-tui.cmd`，跳过自己，所以不会自己调自己。
找不到就报错并给两条补救建议（重装 npm 包 / 设 `DSH_TUI_LAUNCHER`）。

`DSH_TUI_LAUNCHER=<path>` 可以直接指定，调试时很有用——`scripts/` 和文档里的验证都靠它。

## 为什么是 .cmd 而不是 .ps1

- npm 在 Windows 上装出来的是 `dsh-tui.cmd`/`.ps1`/无后缀三个 shim，`.cmd` 是被 `cmd.exe`
  和 PowerShell 都优先命中的那个；
- `.cmd` 不需要改执行策略，也不会在启动时拉开 PowerShell 的启动开销。

## 退出码

垫片对同步脚本的失败**不作为致命错误**：只要真启动器能跑起来，dsh-tui 就该能开。所以逻辑是：

| 情况 | 行为 |
| --- | --- |
| 同步脚本 exit 0 | 静默继续 |
| 同步脚本 exit 1（真失败） | 打一行英文提示到 stderr，继续 |
| 同步脚本 exit 2/3/4（跳过类） | 静默继续（没装对应工具 / profile 未就绪 / 另一个实例在跑） |

真启动器的退出码原样透传。

## 新增一个同步脚本

照现有两个的约定写，然后在垫片里加一段：

```cmd
:myscript
if defined DSH_TUI_NO_MY_FEATURE goto launch
node "%HERE%sync-dsh-tui-my-feature.mjs" --quiet
if errorlevel 1 echo dsh-tui: my-feature sync failed, continuing. 1>&2
```

约定：`--quiet` 只报错；退出码 2/3/4 表示「跳过」而不是「失败」；有独立的环境变量逃生开关；
快速路径（无变化时）要静默且亚秒级。
