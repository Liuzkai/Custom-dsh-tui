# 模型路由同步（tt-switch → dsh-tui）

把 [tt-switch](https://www.npmjs.com/package/tt-switch) 维护在 `profiles/web/cordis.patch.yml`
里的模型路由，同步进 `profiles/dsh-tui/cordis.patch.yml`，让 dsh-tui 的 `/model` 里也能看到
这些 provider。

## 问题

tt-switch 只往 `web` profile 写本地代理路由（`http://127.0.0.1:<port>/deepseek-harness/<id>/v1`），
而 dsh-tui 是**独立 profile**，两边不共享配置。结果就是 dsh-tui 里 `/model` 只有内置 provider。

## 做法

`sync-dsh-tui-tt-switch.mjs` 从源 profile 的补丁里抠出整段 `- id: llm-pi-ai`，写进目标 profile：

- **只替换这一段**。目标里其它条目原样保留，不吞用户手写的内容。
- **原子写**。先写同目录临时文件再 rename，避免启动时读到半截 YAML。
- **幂等**。目标内容与将要写的一致就直接退出（exit 0），不碰 mtime。
- **不猜**。源里没有这段、出现多段、或段里没有 `providers`，一律报错跳过（exit 2），保留现有配置。

## 前提

得先装 tt-switch 并让它往 `profiles/web` 写过一次路由。没装的话脚本静默跳过（exit 2），
dsh-tui 照常启动。

## 字段

| 环境变量 | 默认 | 作用 |
| --- | --- | --- |
| `TT_SOURCE_PROFILE` | `web` | 从哪个 profile 取 |
| `TT_TARGET_PROFILE` | `dsh-tui` | 写到哪个 profile |
| `DSH_HOME` | `~/.dsh` | profile 根 |

## 命令

```powershell
node $DSH_HOME/bin/sync-dsh-tui-tt-switch.mjs            # 同步
node $DSH_HOME/bin/sync-dsh-tui-tt-switch.mjs --quiet    # 只报错（垫片用）
node $DSH_HOME/bin/sync-dsh-tui-tt-switch.mjs --dry-run  # 打印不落盘
```

退出码：`0` 已同步或无需改动；`2` 源缺失或格式不对（跳过）；`3` 目标 profile 未初始化（跳过）。

## 密钥怎么管

同步过来的配置里只有 `apiKeyEnv: <变量名>`，**没有明文密钥**。真正的值走哪条路由 dsh 决定：

1. 用户环境变量（`apiKeyEnv` 指的那个名字）；或
2. `$DSH_HOME/.credentials.yaml` 的 `refs` 段。

所以 profile 补丁文件本身可以公开、可以进这个仓库的模板——`profile/cordis.patch.yml.template`
里刻意留空，就是这个原因。
