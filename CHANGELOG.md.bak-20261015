# Changelog

本文件记录 `dsh-xwide-handoff` 的可见变更。日期为本地时间。

## 0.2.0 — 2026-10-12

### 新增
- **A 半自动（`autoReady`）**：会话上下文使用量达到阈值（默认 70%）时，在一轮结束时**自动把新会话备好**（建会话 → 命名 → 置顶 → 注入交接卡 → 驱动首轮），但**不替用户切换会话**。判据取 `assistant/message.data.usage.inputTokens ÷ contextWindow`（注意：`totalTokens` 是累计消耗，不能用来判占用）。
- **侧栏置顶**：新会话自动 `workspaceRegistry.pinSession()`，在分组内排最前，不会被「展开 N 条」折叠埋掉。
- **归入源会话的项目分组**：通过 `projectController.baseline()/assign()` 把新会话文件到源会话所在项目；源会话未分组时保持未分组（不硬塞）。
- **交接卡新增三段**：`## 接手须知`（先读全卡 / 先报计划 / 不重复已完成步骤 / 拿不准就查证）、`## 本轮动过的文件`（扫 `tool/call` 里 write/edit 的 `file_path` 自动提取，带 write×n / edit×m 计数）、源会话上下文用量。
- **卡片栏目开关 `cardSections`**：`{ guide, files, usage }`，默认全开，可按需关闭。
- `client.js` 客户端半边：识别服务端结果里的 `HANDOFF-PAYLOAD-V1 {…}` 单行 payload，用 GUI 原生 API 建**可见**会话。

### 修复
- **★ surface head 保护**：DSH 要求会话可见序列（surface）的第一条必须是 `system/message`（`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:599` 抛 `system/message requires a protected first surface head`）。插件原来在建会话瞬间直接注入 `user/message`，抢占了 surface 首位，导致 DSH 之后写系统提示时抛错、**整个会话被判 `stored log is corrupt` 打不开**。现在先 append 一条形状合法的 `system/message` 占住 `protectedHead`，再注入卡片。
- 卡片注入补 `{ surfaceOp: "append" }`：`user/message` 是 surface-eligible 事件，缺第三个参数会抛 `session event "user/message" is surface-eligible and requires a surfaceOp marker`，注入静默失败、新会话变空壳。
- 驱动首轮补第二个参数 `signal`：`prompt(request, signal)` 的包装层第一行就调 `signal.throwIfAborted()`，不给会抛 `Cannot read properties of undefined (reading 'throwIfAborted')`。
- 合成消息过滤（`isSyntheticUserText`）：`<system-reminder>` / `<hindsight_knowledge_refresh>` / `<hindsight_knowledge>` / `<available_skills>` / `<project-context>` / 上一张交接卡本身等都会被当成 `user/message` 注入，原来 6 条「你的原话」里常有 3 条是这类垃圾。现在按前缀 + 包含双重判断过滤。
- 剥掉原话里的 `dsh-resource://…` 附件尾巴。
- `agentPreset` 继承改读会话的 `agent-preset/selected` 投影，而不是 `header.agentPreset`（后者只是初始默认值，会把 preset 继承成 `standard`）。

### 已知限制
- 依赖若干 DSH 内部接口（`sessionController` / `workspaceRegistry` / `projectController` / `session.append` 的事件形状）。DSH 升级后需复核，见 README 的「兼容性」一节。
- `childMode: "none"`（完全交给客户端半边建会话）需要把 `client.js` 作为 `dsh.client` 正确打进包；本仓库当前默认走 `create`。

## 0.1.0 — 2026-10-12 之前

- 初版：`/handoff` 命令、按落盘计数器生成 `原名_NN` 标题、交接卡注入为新会话第一句、`childMode`（none/create/fork）三档。
