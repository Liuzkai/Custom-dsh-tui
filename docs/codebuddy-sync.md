# CodeBuddy 会话导入 dsh-tui

把本机 `~/.codebuddy` 的会话增量同步进 dsh-tui 的会话库，导入后在 dsh-tui 里 `/resume` 就能
按原工作目录浏览、续聊。

## 为什么需要它

dsh-tui 0.18.0 的迁移源是编译期常量，写在
`lib/types/dsh-adapter/migrate/index.js` 的 `MIGRATION_ADAPTERS`：

```js
export const MIGRATION_ADAPTERS = [
  claudeCodeAdapter, codexAdapter, ompAdapter, zcodeAdapter, grokBuildAdapter,
]
```

没有 CodeBuddy，也没有注册接缝（`createForeignBrowser` / `picker` / /migrate 都直接引这个数组）。
想加第六个源，要么改包源码，要么给上游提 PR。

## 怎么绕的

CodeBuddy 的落盘形态与 Claude Code 几乎同构，改字段名就能直接喂给**官方 claude-code 适配器**，
落盘、去重、工具配对、压缩检查点统统还是官方逻辑：

| CodeBuddy | Claude Code |
| --- | --- |
| `projects/<munged-cwd>/<sessionId>.jsonl` | 完全相同的目录布局 |
| `<sessionId>/subagents/*.jsonl` | 相同语义（属于父会话，不单独成篇） |
| `message.content[].input_text` / `output_text` | `content[].{type:"text"}` |
| `reasoning` 行的 `rawContent` 数组里的 `reasoning_text` | `content[].{type:"thinking",thinking}` |
| `type:"function_call"`（`callId`/`name`/`arguments`) | `tool_use` 块（`id`/`name`/`input`) |
| `type:"function_call_result"`（`callId`/`status`/`output.text`) | user 行的 `tool_result` 块 |
| `type:"ai-title"` 的 `aiTitle` | 同名 `ai-title` 行的同名字段 |
| `summary` / `session-meta` / `turn-metrics` / `file-history-snapshot` | 丢弃（与对话无关） |

几个容易踩的点：

- **`rawContent` 是块数组，不是单对象**。写成 `rawContent.type === 'reasoning_text'` 会静默拿到
  空字符串，思考过程全丢。
- **`reasoning` 与 `function_call` 共用 `providerData.messageId`**。转换时把 `message.id` 换成
  `messageId`，Claude 侧的解析器才会把它们并进同一个 step（它按 `message.id` 归并）。
- **盘符大小写要归一**。CodeBuddy 记 `g:\...`，DSH 的工程目录名按原样生成，不转大写会在会话库里
  分裂出 `--g-...` 和 `--G-...` 两个目录。

## 增量与幂等

| 项 | 做法 |
| --- | --- |
| 增量 | 状态存 `$DSH_HOME/codebuddy-sync.state.json`，记每个源文件的 mtime+size，只处理变过的 |
| 状态作废 | 状态文件带 `sessionRoot`；换了 `DSH_TUI_SESSION_ROOT` 就整体作废重导，隔离试跑骗不过真实库 |
| 幂等 | 官方用源会话 id 生成确定性 UUID（v5），重复导入落到同一会话并跳过 |
| 单实例 | `$DSH_HOME/codebuddy-sync/lock`，第二个窗口 exit 4，不抢占 |
| 跳过不记 | 无人类提问的、工作目录已不存在的、超 64 MB 的，都不记指纹，下次自动重试 |

跳过的下次重试这点很重要：外接盘没挂的时候会话先跳过，盘回来后的那次启动就自动补上。

## 实测数据

本机（89 个源会话 / 60.7 MB，8 个工作目录）：

| 场景 | 结果 |
| --- | --- |
| 转换 | 83 个（6 个只有机器注入、无人类提问，跳过） |
| 首次全量导入 | 83 个，4.8 秒 |
| 稳态启动（无变化） | 131 ms，零输出 |
| 一个会话有新活动 | 794 ms |
| 幂等复跑 | `imported 0 · already present 83` |
| 读回校验 | 83 会话 / 571 条 user 消息 / 4113 次工具调用 ↔ 4113 条结果，**未配对 0** |
| 思考过程 | 1872 条 assistant 消息里 1158 个 reasoning 块 |
| 显式标题 | 50 个会话带 `session/title` |

## 依赖注入的小把戏

脚本要 `import` profile 里的编译产物，那份代码以裸说明符引 `@deepseek-ai/*`（cordis、
dsh-session-persistence-jsonl …）。这些是 dsh-tui 的 peer 依赖，profile 里不一定存在。

脚本用 Node 的 loader hook 兜底：**先按它自己的位置解析，失败才重定向到 dsh 全局安装自带的那份**。
用 `data:` URL 注册 hook，不在用户目录里留第二个文件。等 dsh-tui 自己修好 profile 依赖，兜底
自然让位，不用改代码。

## 命令

```powershell
node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs            # 手动跑一次
node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs --status   # 状态
node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs --dry-run  # 只列不写
node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs --force    # 忽略状态重扫
node $DSH_HOME/bin/sync-dsh-tui-codebuddy.mjs --only <sessionId>
```

退出码：`0` 完成或无变化；`1` 失败（垫片打一行提示后继续启动）；`2` 没有 CodeBuddy 数据；
`3` profile 未就绪；`4` 另一个实例正在同步。除 `1` 外全部静默。

## 限制

- `subagents/*.jsonl` 不导入，与适配器对 Claude 子代理的处理一致。
- 逐条消息时间戳不迁移（事件时间取导入时刻），会话起始时间保留。
- 工具结果超 64 KB 截断，图片换 `[image]` 占位（适配器既有规则）。
- 上游若真的加了 CodeBuddy 适配器，删掉垫片里那段调用即可退回。
