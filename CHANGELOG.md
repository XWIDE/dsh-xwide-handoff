# Changelog

本文件记录 `dsh-xwide-handoff` 的可见变更。日期为本地时间。

## 0.3.0 — 2026-11-19

### 修复
- **★原地交接后第一条消息被吞（要发两次才回复）。** 现象（用户报障）：`/handoff` 完成后发的第一条普通消息没有回复，敲第二条才醒。根因（读官方引擎注释实锤）：翻篇是在 `/handoff` 自己这个活动回合里当场写压缩括号的，这种括号绝不能横跨/嵌进活动回合边界——写完宿主状态机没归位。修法：`/handoff` 卡片照写、播报照发，翻篇改挂官方 `agent/status` 的 **idle 瞬间**消费（与官方 turn-end 强制压缩同一挂载点：所有回合已闭合、下一条人类消息之前），`agent/pre-step` 留兜底防漏单（任何异常放行请求，绝不卡步骤）。括号写在活动回合之外 → 不吞消息；翻篇仍是零 LLM 毫秒级。
- 中间版本 0.2.9（翻篇排队到 pre-step）能修吞消息但百分比不当场降（要等下一条消息触发），被 0.3.0 的 idle 方案取代。

### 行为变更
- **交接完百分比当场下降。** 翻篇在 `/handoff` 回合一闭合就执行，用户在发下一条消息之前就能看到上下文占比掉下来；弹条同步播报「原地翻篇完成：已压 N 条」。

### 判定器（用户实测通过）
- 重启后跑 `/handoff`：不发任何消息，百分比当场降 ✓（日志 `翻篇完成 shadow=43 tokens=26063 用时ms=91`，零降级行）。
- 交接后第一条普通消息直接有回复 ✓（不再打两次）。
- 手动/自动交接卡片与 ~20s 流程零改动 ✓。

### 维护
- 调试日志路径从个人工作区硬编码改为 `~/.dsh/_xwh_debug.log`（发布包内不再含个人机器路径）。

## 0.2.8 — 2026-11-18

### 新增
- **★上传积压守卫（防 413 复发）。** 现象（用户报障）：一个会话发任何一句话都返回 HTTP 413，会话自己好不了。根因：**不是插件坑死的** —— 官方 `session-log-deepseek` 把「交付确认水印」之后的全部事件序列化进每个请求的 `dsh_session_log` 字段（单字段上限 8 MiB）；一旦最早那条积压事件本身就超 8 MiB，水印永远推不动，每轮重放同一批积压 → 出口被永久堵死（实测积压 18.58 MB）。功能：插件在每次 usage 记录时扫描该会话的上传积压，若「最新有效水印之后的事件」合计超过 `uploadGuardMaxBytes`（默认 6 MiB，留网关余量），就自动补写一条合法的 `session-log-deepseek/delivery-accepted` 水印事件，把积压水位推过超限段 —— 堵死的会话自己会通，不再需要手改会话文件。每会话 10 分钟节流一次，全程 try/catch，失败只记日志不影响交接主流程。配置项：`uploadGuardMaxBytes`（设置页可改）。
- **设置页脚注换新版 X-WIDE 彩标**（`I BELIEVE` 全彩 logo，480×320 JPEG base64 内嵌约 15 KB），显示高度 64 → 96。

### 行为变更（2026-11-19，用户拍板）
- **「原地交接」语义改为自动就地。** 现象（用户报障）：设置页写着「手动 /handoff 不建新对话」，但用户预期是「勾上后插件自己就在当前对话交接，不用手打 /handoff」。原实现自动交接路径强制 `inPlace:false`（11-18 旧规则「自动交接始终去新对话」），勾选只影响手动。现改为自动交接尊重勾选：勾上＝到阈值插件自己在当前会话压摘要接着干，不新建会话、不用手打；手动 /handoff 行为不变（勾了就地、没勾去新对话）。设置页 label/提示与发布说明同步。

### 界面
- 设置页脚注改为**横排**：logo 居左顶对齐，文字行组居右。
- 侧栏「X-WIDE 交接」链接后加插件全名 `dsh-xwide-handoff` 小字，方便辨认归属。

### 判定器
- 语法：`index.js` / `client.js` `--check` 退出码 0（源与已安装副本共 4 份全绿）。
- 守卫：盘上断言 `uploadGuardOnce` 调用点在 usage 路径内；配置默认 `uploadGuardMaxBytes=6291456` 在位。
- 未验：守卫的运行时效果（需上传开关重新打开后、真实超阈会话观察一次水位推进日志）。

## 0.2.6 — 2026-11-15

### 修复
- **★npm 包发出去没有 `repository`，导致插件市场里本插件「版本号」一栏永远空白。** 现象（用户报障）：插件市场卡片 `XWIDE · · ★ 0`，版本号位置空着，而同作者的 picflow 显示 `v0.3.1`。根因：`package.json` 的 `author / homepage / repository / bugs / keywords` 全写在 `dsh` 块**内部**，npm 只读**顶层** `repository`，所以 registry 文档里该字段为空 —— 而市场正是靠「npm 包的 repository 指回 GitHub 仓库」把两者关联起来（awesome-dsh-plugin `contributing.md` L240：不指回就不关联）。修法：把 `author / homepage / repository / bugs / keywords` 补到 `package.json` 顶层（`dsh` 块内的原名元数据保留不动，宿主读的是那一份）。
- 版本号 `0.2.5` → `0.2.6`（`package.json` 与 `client.js` 的 `PLUGIN_VERSION` 同步），设置页脚注随之显示 `dsh-xwide-handoff v0.2.6 · 2026-11-15`。

### 判定器
- 语法：`index.js` / `client.js` `--check` 退出码 0；`package.json` 解析通过且顶层 `repository.url` 指向本仓库。
- 发布后复核：`registry.npmjs.org/dsh-xwide-handoff/0.2.6` 的 `repository.url` 已非空、`dist-tags.latest=0.2.6`。
- 未验：市场卡片上的版本号要等 awesome-dsh-plugin 合并 PR #15570 并重建索引后才会出现；设置页 DOM 表现需重启 DSH 装载。

## 0.2.5 — 2026-11-15

### 修复
- **★设置页所有文本类设置项（含「自动交接阈值」）根本没有输入框、不能填值。** 现象（用户报障）：设置页「自动交接阈值 (%)」那一行只有标签和说明文字，值的位置是空的，填不进 90。根因：`client.js:137` 写成了 `h("DraftInput", {...})` —— 组件名是**字符串**，`React.createElement("DraftInput")` 只会建一个未知的自定义 DOM 标签（空元素、无报错），真正的 `DraftInput` 函数（`client.js:215`）从未被调用。修法：改成 `h(DraftInput, {...})`。影响面＝同一 `textRow` 渲染的所有项：命令名、自动交接阈值、触发阈值、上下文窗口、全局冷却、卡片带最近原话条数、序号位数、标题最长字符、自愈重钉上限、计数器文件路径。
- **脚注里的发布页 / B站地址改成可点链接**：`<a target="_blank">` → 桌面端 `main.js:20278` 的 `setWindowOpenHandler` 会把 http/https 交给系统浏览器打开；邮箱是 `mailto:`，该处理器只放行 http/https，做成链接会点了没反应，故保持纯文本。

## 0.2.4 — 2026-11-15

### 修复
- **★交接序号改为按「会话线（标题基名）」分桶，每条线各自 `_01` 起。** 现象（用户报障）：`comfyui-preset-switch-plus升级Ultra` 那条线用到 `_27`，随后完全无关的新会话「对话标记插件推荐」第一次交接直接被写成 `_28`。根因：0.2.3 把桶键设成「项目分组」，而这两条会话都归在「未分组」→ 共用同一个桶，序号跨会话串号。修法：`index.js:537-546` 先算 `base`，再 `bucketKey = "title:" + sanitizeSegment(base, 40)`（基名取不到时才退回旧桶，避免断档）；回执文案改为「本会话线第 N 次交接」。
- 已存在的 `_18/_25/_26/_27` 一律不改名，新逻辑只影响之后的交接。

### 新增
- **设置页「自动交接」勾选 + 自动交接阈值（可配置输入框，默认 90，允许 50–95，越界自动夹到边界）**：勾上后到阈值自动执行一次 `/handoff`（建新会话+命名+置顶+填卡+驱动首轮），等同用户手打。实现：`index.js` 的 `cfg()` 新增 `autoHandoff`/`autoHandoffPct`（`CONFIG_DEFAULTS` 同步，阈值夹在 `[0.5, 0.95]`）；`attachAutoReady` 在 `turn/end` 判据里先走全自动分支（每会话一次、受全局冷却约束），半自动 `autoReady` 保留为第二分支；`autoReadyOnce(..., mode)` 按模式区分「自动交接 / 自动备好」两种首句与日志。
- **设置页脚注（开发信息）**：`dsh-xwide-handoff v0.2.4 · 2026-11-15` / 支持的 DeepSeek Harness `≥ 0.1.7（本机实测 0.2.2-rc.3）` / 作者 X-WIDE · B站 374064919 · xiupk@sina.com.cn / 发布页 github.com/XWIDE/dsh-xwide-handoff。样式照 `dsh-xwide-annotation` 的分区脚注（`client.js` 的 `footerStyle`）。

### 判定器
- 语法：`F:\deepseekharness\DeepSeek Harness.exe --check index.js` / `--check client.js` → **exit 0**（两份 SHA1 与已安装副本一致）。
- 装载/行为：**未验** —— 改插件需重启 DSH 才装载。重启后要确认三件事：设置页出现「自动交接」勾选与阈值 90、底部脚注四行；真机跑到 90% 时是否自动产生新会话。

## 0.2.3 — 2026-10-17

### 修复
- **★交接卡序号不再全局共用一个计数器，改为按项目分组各自计数。** 现象：新开项目的**第一张**交接卡标题直接叫 `_32`（本机实测 `Strata0.145机器模型升级提升评估_32`）。根因：序号的桶键是**工作目录**（调用处原为 `claimSeq(config.counterFile, cwdKey)`），而 `dsh-project-groups` 把所有项目的工作目录都落在同一个基工作区（注入的 project-context 原话 "all projects' workspace directories fall into a single base workspace"）→ 所有项目共用同一个基工作区这一个桶，`~\.dsh\xwide-handoff-counter.json` 里该桶已计到 32。
- **修法**：新增 `resolveBucketKey(ctx, sourceId, cwdKey)`（`index.js:159`），取数通道与下方「归入项目分组」块同源（`ctx.get("projectController").baseline()` → `assignments[sessionId] = projectId`）。已分组 → 桶键 `proj:<projectId>#<项目名>`，**新项目首张卡从 `_01` 起**；未分组 / 服务不可用 / 任何异常 → 退回 cwd 键＝旧行为，老会话不断号。`/handoff` 回执同步标明分桶依据（`index.js:867`）。

### 判定器（三层全绿）
- 语法：`node --check index.js` 通过（经 `dsh_safe_write` 校验后落盘，每步自动 `.bak-*`）。
- 装载：`dsh_plugin_check(dir=插件目录)` → `OK dsh-xwide-handoff 装载自检通过`。
- 行为：`_annot_extract\bucket_seq_sim.mjs`（照抄被测函数 + 假 ctx，11 条断言）→ `RESULT: ALL PASS`：新项目首号 1、二次 2；未分组续老桶到 33；服务不可用 / `baseline()` 抛错 / `sourceId` 缺失一律退回 cwd；两个项目各自独立计数。

## 0.2.2 — 2026-10-15

### 修复
- **★「重启机器后，所有交接会话都判 `stored log is corrupt`、历史打不开」的根因修掉了。** 逐帧解 `session.v4.jsonl.zstd`（本机三个交接会话表现一致）得到的实证链：
  - `seq=9 turn/end t1` ← 插件合成的 turn 1 在这里关掉，重载回放器的 `nextTurn` 变成 **2**；
  - `seq=11 turn/start t1` ← DSH 驱动首轮时按**自己的内存状态**取号，写的还是 **t1**；
  - → 重载回放到 `seq=11` 撞 `@deepseek-ai/dsh-session/lib/types/invariant.js:746-749`（`turn/start` 必须 `data.turn === nextTurn`）→ 抛错 → 整条会话标成 `stored log is corrupt`。
- **修法＝插件零合成事件**（`index.js`）：
  - 占位头候选置空 `for (const [turn, step] of [])`（`index.js:625`）→ 不再写 `turn/start` / `step/start` / `system/message`；
  - 卡片注入段整段停用（`if (false)` 保留原文可追溯，`index.js:666`），插件不再写 `user/message` / `step/end` / `turn/end`；
  - 卡片的**唯一投递通道**＝第 5 步官方 prompt（`sessionController.prompt()`）；surface 首位由 DSH 自己写的 `system/message` 占住，turn/step 全由官方取号。
- **不再偷偷退回老路**：官方 prompt 通道抛错＝卡片没送进去，如实置 `seedError` 并让 head 提示「手动粘贴卡片」（`index.js:738`、`:748`），绝不回退到「插件自己写事件」那条会写坏日志的路。

### 说明（本版为什么必须发）
- 0.2.1 只修掉了旧形状（`seq=4` 的占位头没有 open turn，撞 `@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:574 requireStep`），把冲突挪到了 `seq=11` —— 所以当时表现为「猛猛操作一番，问题一模一样」。本版把插件写事件这条路径整条关掉，才是根治。
- 本机已安装副本此前只标到 `0.2.0`（代码已含 A/B 修复、版本号没跟上），本次一并同步到 `0.2.2`。

### 已知问题（本版未修）
- 沿用 0.2.1：**自愈重钉的名单是挂载时的一次性快照**（`index.js:807` 只 `readJson(NAMES_FILE)` 一次，本进程内新建的交接会话不在快照里，被官方改名后不会重钉，直到重启 DSH）。

## 0.2.1 — 2026-10-14

### 修复
- **占位 `system/message` 用了规范上非法的 `turn/step`。** 候选列表原本是 `[[0, 0], [1, 1]]`，而 `[0,0]` 从规范上就必非法：`@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:252-256` 对 `system/message` 同时要求 `turn` 与 `step` 为正（正数检查在 `:226-227`）。关键在于**这条校验位于读取/恢复路径**（`assertV4RowAdmission`，同文件 `:1107-1114`），写侧的 `try/catch` 抓不到它 → 坏行照样落盘，等下次打开该会话时才抛 `format v4 system/message turn must be positive`，前端表现为「本轮运行失败」；交接几次就多几行。现在候选只保留合法值 `[[1, 1]]`。

### 已知问题（本版未修）
- **自愈重钉的名单是挂载时的一次性快照**：`index.js:807` 在 `attachSelfHeal` 里只 `readJson(NAMES_FILE)` 一次，而每次交接走 `saveName()`（`:149-155`）只写文件。于是**本进程内新建的交接会话不在 watcher 快照里**，被官方改名后不会重钉（`:814` 直接 return），直到重启 DSH。修法方向：watcher 现查文件，或把名单提成共享活对象由 `saveName` 同步更新。

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
