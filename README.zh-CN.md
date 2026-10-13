# dsh-xwide-handoff

> 给 **DeepSeek Harness (DSH)** 用的交接插件：一条 `/handoff` 把「快聊满的会话」变成「一张结构化交接卡 + 一个干净的新会话」，并在侧栏自动置顶。上下文快满时还能**自动把下一棒备好**。

[English README](README.md) · [安装与使用指南](docs/INSTALL.md) · [更新日志](CHANGELOG.md) · [MIT License](LICENSE)

> **状态：v0.2.0 · beta。** 核心流程（`/handoff` → 交接卡 → 新会话 → 自增命名 → 置顶）在作者机器上长期在用；
> 跨机器安装路径（尤其 `childMode: none`）**尚未在第二台机器验证**。安装两步、配置项表、五条故障排查见
> [安装与使用指南](docs/INSTALL.md)。

---

## 它解决什么问题

长任务会把会话上下文顶满。官方的自动压缩是**有损**的：它会把细节吃掉，而且压完你还在同一个会话里，继续顶。

这个插件换一条路 —— **交接**：

1. 把「当前做到哪一步 / 改过哪些文件 / 验证过什么 / 下一步做什么」写成一张**交接卡**；
2. 起一个**上下文清零的新会话**，把卡片作为它的第一句；
3. 新会话**自动命名**（`原会话名_01`、`_02`…，落盘计数器，不重名）、**自动置顶**、**自动归入源会话所在的项目分组**。

于是你换了个房间，但接力棒没丢。

## 安装

```bash
# 在 DSH profile 目录里
pnpm add dsh-xwide-handoff
```

或在 profile 的 `cordis.patch.yml` 里按路径挂载：

```yaml
- id: dsh-xwide-handoff
  name: './local-plugins/dsh-x-wide_handoff/index.js'
  config:
    commandName: handoff
    childMode: create
    recentUserMessages: 6
```

## 用法

```
/handoff 本次重点：把 X 的解析逻辑改完；已改 a.js；未验证回归
```

- `/handoff` 后面写的内容会进卡片的「本次交接重点」。
- **不写也行** —— 卡片会自动带上「本轮动过的文件」和「你最近 6 条原话」。
- 命令执行完会告诉你新会话的 id 和标题，并把它置顶。

**注意**：`/handoff` 是斜杠命令，**只能由用户在输入框敲**，模型不能自己调用。所以插件同时提供 A 半自动（见下），到阈值时**替你把它备好**。

## A 半自动（`autoReady`）

打开后，插件监听每一轮的结束（`turn/end`），读最近一次请求携带的上下文量：

```
占用 = 最近一条 assistant/message 的 usage.inputTokens ÷ contextWindow
```

- **≥ `readyPct`（默认 0.7）** → 自动跑一遍交接：建会话、命名、置顶、注入卡片、驱动它跑完首轮（这样它在侧栏里**一定看得见**）。
- **不替你切会话** —— 你从侧栏点那条置顶的新会话继续。DSH 没有「服务端让浏览器换会话」的公开接口，这是有意的边界。
- 保险丝：同一会话只备一次、全局冷却（默认 10 分钟）、总开关默认**关**。

> ⚠️ 判占用**必须**用 `inputTokens`。`usage.totalTokens` 是累计消耗（见过 20 万），拿它判会 100% 误触。

## 配置

```yaml
- id: dsh-xwide-handoff
  name: './local-plugins/dsh-x-wide_handoff/index.js'
  config:
    commandName: handoff          # 命令名，默认 handoff
    childMode: create             # none | create | fork（见下）
    recentUserMessages: 6         # 卡片带最近几条你的原话
    compact: false                # 交接前是否先本地压缩一次
    titleTemplate: '{base}_{seq}' # 标题模板，支持 {base} {seq} {note} {time}
    seqWidth: 2                   # 序号位数：_01
    maxTitleChars: 64             # 标题字符上限
    repinLimit: 3                 # 自愈重钉次数上限
    autoReady: false              # A 半自动总开关
    readyPct: 0.7                 # 触发阈值（占上下文窗口比例）
    readyCooldownMs: 600000       # 冷却
    contextWindow: 262144         # 上下文窗口（判占用用）
    cardSections:                 # 卡片栏目开关
      guide: true                 # 「接手须知」
      files: true                 # 「本轮动过的文件」
      usage: true                 # 「源会话上下文」
```

### `childMode` 三档

| 值 | 行为 | 什么时候用 |
|---|---|---|
| `create` | 服务端直接建**全新空会话**（上下文清零，继承 cwd 与 agentPreset） | **默认推荐**。不依赖客户端半边 |
| `none` | 服务端不建会话，把卡片 JSON 塞进结果文本，由 `client.js` 用 GUI 原生 API 建**可见**会话 | 需要「和点『新建对话』完全一致」时；要求 `client.js` 已正确作为 `dsh.client` 打进包 |
| `fork` | 继承全部历史（上下文**不**清零） | 只想换个标题、不想清上下文的场景 |

> ⚠️ 三种模式都**不能**带 `parentSession` —— DSH 会把带 `parentSession` 的会话从列表和可恢复集合里排除，那正是「交接完看不见新会话」的经典成因。

## 交接卡长什么样

```markdown
调节Qwen3.8 Agent对接本地模型_07          ← 第一行 = 目标标题（官方取名启发式直接取它）

# 交接卡 · 调节Qwen3.8 Agent对接本地模型_07

## 接手须知（先读这一段）
1. 先读完整卡片：源会话 cwd 下的 handoff/ 目录里最新那份 .md 就是本卡全文
2. 先报计划再动手：一句话说清先做哪条、大约要多久、有没有分支
3. 不要重复已完成步骤：下面「本轮动过的文件」都改过了，先读现状
4. 拿不准就去查证：文件、目录、会话记录都在磁盘上

> 新会话命名：**调节Qwen3.8 Agent对接本地模型_07**（序号来自落盘计数器，本次第 7 次交接）
> 改名通道：append session/title(user) 钉住

- 生成时间：2026-10-12 23:09:03
- 源会话: session-ef20af83-…
- 新会话: session-a48315dc-…
- 压缩: 未执行（配置 compact: false …）
- 源会话上下文：约 18461 tokens（最近一次请求携带量；判占用看它，不看累计消耗）

## 本次交接重点（你写的）
（/handoff 后面没写备注 —— 请以下方「本轮动过的文件」+「最近你的原话」自行判断该接哪条）

## 本轮动过的文件（3 个，自动提取自 5 次 write/edit 调用）
- `C:\…\local-plugins\dsh-x-wide_handoff\index.js`（write×1 edit×4）
- `C:\…\package.json`（write×1）

## 最近你的原话（逐条原文，按时间顺序）
1. …
```

## 工作原理（给要改代码的人）

- **命名**：序号来自落盘计数器（`~/.dsh/named-handoff-counter.json`，按 cwd 分桶单调递增），**不是**从源会话标题尾号推算 —— 源会话每次都是新开的、标题没有尾号，推算永远得到 `_01`。名单落在 `~/.dsh/named-handoff-names.json`。
- **钉名三通道**：① 卡片第一行就是目标标题（官方取名服务会读它）；② `ctx.sessions.using(...).binding.session.rename()`（部分版本没有 `using`，会失败）；③ `session.append("session/title", …)`。
- **自愈重钉**：官方取名服务会主动覆盖已钉住的标题（其注释自认 "overwriting a pinned user title is the point"），所以插件监听改名事件，发现名单内会话被非 user 来源改名就再钉一次（上限 `repinLimit`）。
- **`prompt` 需要 signal**：`sessionController.prompt(request, signal)` 的包装层第一行就调 `signal.throwIfAborted()`，务必传 `new AbortController().signal`。
- **`blank` 只认 `turn/start`**：侧栏会把 `blank: true` 的会话直接滤掉（标题还会显示成「新建会话」）。注入消息不会翻这个标记，所以必须真的驱动一轮。

## 兼容性

本插件使用了若干 **DSH 内部接口**（不是稳定公开契约），已在下列位置核对过：

| 用到的东西 | 位置（DSH 桌面版内置包） |
|---|---|
| `sessionController.prompt / create / resolveAgent` | `@deepseek-ai/dsh-api-session-controller` |
| `session.append` 的 `surfaceOp` 语义 | `@deepseek-ai/dsh-session`（`SURFACE_EVENT_TYPES` 只有 system/developer/user/assistant/message + tool/result） |
| `system/message` 必须是 surface 第一条 | `@deepseek-ai/dsh-session-format-v3-to-v4` `foldSurface()` |
| `workspaceRegistry.pinSession` | `@deepseek-ai/dsh-workspace` |
| `projectController.baseline / assign` | `dsh-project-groups`（**可选依赖**，没装就跳过归组） |
| 侧栏 `blank` 过滤 | `@deepseek-ai/dsh-client-ui-workspace` |

**DSH 升级后请复核上表**。所有内部调用都写了宽容处理：失败只记日志，不让交接本身崩掉。

## 路线图

- [ ] `childMode: "none"` 客户端半边的完整接线与回归
- [ ] 卡片栏目可自定义模板
- [ ] 交接卡自动带上「已跑过的关键命令」
- [ ] i18n（目前注释与文案以中文为主）

## License

MIT © 2026 XWIDE
