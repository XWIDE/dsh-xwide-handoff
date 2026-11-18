// dsh-xwide-handoff · CLIENT 半（浏览器端）
//
// 职责一：把「新建**可见**会话」这件事放在 GUI 亲生 API 上做（服务端 create 造的是裸会话，
// 列表里看不见）。协议：服务端 /handoff 在结果文本里追加一行
//   HANDOFF-PAYLOAD-V1 {"title":"…","cwd":"C:\\…","agentPreset":"…","stamp":"…","card":"…"}
// 本半扫到这条 payload 后：
//   1) sessions.create({cwd, agentPreset}) —— 与 GUI「新建对话」按钮同一条 API：可见、零上下文；
//      agentPreset 传不上就退回只传 cwd（保持当前默认智能体），并打日志。
//   2) prompt(卡片, "queue")               —— 卡片作为第一句填好；
//   3) binding.session.rename(标题)        —— Alt+G 改名同一条 RPC；
//   4) best-effort 打开新会话（探测候选 API，探不到就留在列表里由你点一下）；
//   5) 自愈重钉：目标标题被官方取名覆盖 → 重钉（上限 repinLimit）。
//
// 职责二：设置页分区（settings.section）。读写走 ctx.configForms.get(NS_SETTINGS)——
// 命名空间 = 装载行 entry id（harness 0.1.7 由 entry id 推导表单命名空间）。写回的键落进
// settings.yaml，覆盖 cordis.patch.yml 装载行里的基线；清空一项 = 回落基线。改动重载后生效。
window.__ModuleLoader__.load({
  id: "dsh-xwide-handoff",
  factory: (require) => {
    const module = { exports: {} };

    // ── 平台外部（web 预载基线包；缺席时逐层降级，绝不抛错）────────────────
    let React = null;
    try {
      React = require("react");
    } catch {}
    const h = React && typeof React.createElement === "function" ? React.createElement : null;
    let createSnapshotStore = null;
    try {
      createSnapshotStore = require("@deepseek-ai/dsh-client-store").createSnapshotStore;
    } catch {}

    const NS = "settings.xwideHandoff"; // 本分区文案字典命名空间
    const NS_SETTINGS = "dsh-xwide-handoff"; // 宿主设置命名空间 = 装载行 entry id
    // 设置页脚注（用户点名要「我的开发信息 / 版本号 / 支持的 harness 版本」）：
    // 版本号与 package.json:3 必须一字不差，发布时两处一起改。
    const PLUGIN_VERSION = "0.2.8";
    const PLUGIN_DATE = "2026-11-18";
    // 支持的宿主：peerDependencies 声明 @deepseek-ai/dsh-app-plugin >= 0.1.7；
    // 括号里是本机实测读数（F:\deepseekharness\resources\app.asar/package.json: name=@deepseek-ai/dsh-desktop version=0.2.2-rc.3）。
    const SUPPORTED_DSH = "≥ 0.1.7（本机实测 0.2.2-rc.3）";

    const zh = {
      nav: "交接插件",
      intro: "把「/handoff 交接」调成你喜欢的样子：命令名、新会话怎么建、卡片内容、自动备好阈值。写进 settings.yaml，覆盖 cordis.patch.yml 基线；清空一项即回落基线。改动重载后生效。",
      loading: "读取设置中…",
      unavailable: "设置服务不可用（该 composition 没有 configForms 或命名空间未注册）。",
      enabled: { label: "启用插件", hint: "关掉后不再注册 /handoff，watcher 全部停摆。" },
      commandName: { label: "命令名", hint: "斜杠命令的名字，默认 handoff（即 /handoff）。" },
      childMode: { label: "新会话模式", hint: "GUI 亲生=浏览器半建新会话（列表可见，推荐）；服务端=直接建会话（可能要刷新才出现）；fork=继承全部历史（上下文不清零）。" },
      autoReady: { label: "到阈值自动备好", hint: "A 半自动：上下文到阈值自动把新会话备好（建好/命名/置顶/填卡），不替你切会话。" },
      autoHandoff: { label: "上下文阈值提醒（模型说一声）", hint: "勾上后：上下文到阈值时，模型会在回复开头告诉你「上下文已到 X%，建议打 /handoff」。不勾＝一声不吭（就算勾了自动交接也不提醒）。默认开。" },
      autoExecute: { label: "自动交接（提醒完插件自己交接）", hint: "勾上后：模型说完提醒，插件等 20 秒自己执行一次 /handoff（建新会话+命名+填卡），你不用手打。不勾＝只提醒、你手动打 /handoff。默认关。" },
      inPlace: { label: "原地交接（在当前对话里交接，不新建对话）", hint: "勾上后：自动交接到阈值时插件自己在当前会话里把老对话压成摘要接着干，不新建会话、不用你手打 /handoff；你手动打 /handoff 同样就地做。交接卡照样落盘存档。默认关（=去新对话）。" },
      handoffGroup: { label: "交接行为", hint: "这三条一起决定「上下文到阈值之后发生什么」：先要不要提醒，再要不要插件自己接手，最后要不要换对话。" },
      autoHandoffPct: { label: "自动交接阈值 (%)", hint: "可填 50–95，默认 90；超出范围会自动夹到 50 或 95。" },
      readyPct: { label: "触发阈值 (%)", hint: "inputTokens ÷ 窗口 ≥ 这个百分比就自动备好。填 0–100，如 70。" },
      contextWindow: { label: "上下文窗口 (tokens)", hint: "本地模型窗口，默认 262144。" },
      readyCooldownMs: { label: "全局冷却 (毫秒)", hint: "两次自动备好之间的最小间隔，默认 600000（10 分钟）。" },
      compact: { label: "卡片内本地压缩", hint: "对近满上下文做本地压缩是分钟级（单卡）；关掉则跳过压缩，用官方 /compact 自行控制。" },
      recentUserMessages: { label: "卡片带最近原话条数", hint: "「最近你的原话」一节逐条带几条，默认 6。" },
      titleTemplate: { label: "标题模板", hint: "必须含 {seq}，如 调节Qwen3.8 Agent对接本地模型_{seq}。" },
      seqWidth: { label: "序号位数", hint: "递增序号的位数，默认 2（01、02…）。" },
      maxTitleChars: { label: "标题最长字符", hint: "超过会截断，默认 64。" },
      repinLimit: { label: "自愈重钉上限", hint: "新会话被官方改名后最多重钉几次，默认 3；0=关闭自愈。" },
      keepFork: { label: "fork 模式保留源会话", hint: "仅 childMode=fork 时有意义。" },
      cardSectionsGuide: { label: "卡片·接手须知段", hint: "关掉后卡片不再带「接手须知」清单。" },
      cardSectionsFiles: { label: "卡片·动过文件段", hint: "关掉后卡片不再列「本轮动过的文件」。" },
      cardSectionsUsage: { label: "卡片·上下文用量段", hint: "关掉后卡片不再带源会话用量数据。" },
      counterFile: { label: "计数器文件路径", hint: "留空 = 用默认路径。" },
    };
    const en = {
      nav: "Handoff (X-WIDE)",
      intro: "Tune /handoff: command name, how the new chat is created, card contents, auto-ready threshold. Values persist to settings.yaml and override the cordis.patch.yml baseline; clear a field to fall back. Reload to apply.",
      loading: "Loading settings…",
      unavailable: "Settings service unavailable (no configForms in this composition, or namespace not registered).",
      enabled: { label: "Enable plugin", hint: "When off, /handoff is not registered and all watchers stop." },
      commandName: { label: "Command name", hint: "Slash-command name, default handoff (i.e. /handoff)." },
      childMode: { label: "New-chat mode", hint: "gui-native = browser half creates a VISIBLE chat (recommended); server = server-side create (list may need refresh); fork = inherit full history (context NOT cleared)." },
      autoReady: { label: "Auto-ready at threshold", hint: "Semi-auto: prepares a new chat when context crosses the threshold (create/name/pin/seed card) without switching sessions." },
      autoHandoff: { label: "Context threshold reminder (model speaks up)", hint: "When on, crossing the threshold makes the model open its reply with \"context at X%, consider /handoff\". Off = stays silent (even if auto-handoff is on). On by default." },
      autoExecute: { label: "Auto-handoff (plugin runs it after the reminder)", hint: "When on, after the reminder the plugin waits 20s and runs a real /handoff itself (create + name + seed card) — no typing needed. Off = reminder only, you type /handoff. Off by default." },
      inPlace: { label: "In-place handoff (manual /handoff stays in this chat)", hint: "When on, typing /handoff does NOT create a new chat — it compacts this session's old messages into a summary and you keep going here; the card is still archived to disk. Auto-handoff is unaffected (always goes to a new chat). Off by default." },
      handoffGroup: { label: "Handoff behaviour", hint: "These three together decide what happens once context crosses the threshold: whether the model speaks up, whether the plugin acts on its own, and whether it switches chats." },
      autoHandoffPct: { label: "Auto-handoff threshold (%)", hint: "Range 50–95, default 90; out-of-range values are clamped to 50 or 95." },
      readyPct: { label: "Trigger threshold (%)", hint: "inputTokens ÷ window ≥ this percent triggers auto-ready. 0–100, e.g. 70." },
      contextWindow: { label: "Context window (tokens)", hint: "Model window, default 262144." },
      readyCooldownMs: { label: "Global cooldown (ms)", hint: "Minimum gap between auto-readies, default 600000 (10 min)." },
      compact: { label: "Local compaction in card", hint: "Compacting a near-full context takes minutes on a single GPU; off = skip (use official /compact)." },
      recentUserMessages: { label: "Recent user messages in card", hint: "How many verbatim user messages the card carries, default 6." },
      titleTemplate: { label: "Title template", hint: "Must contain {seq}, e.g. MyProject_{seq}." },
      seqWidth: { label: "Seq width", hint: "Digits in the incrementing counter, default 2 (01, 02…)." },
      maxTitleChars: { label: "Max title chars", hint: "Titles longer than this are truncated, default 64." },
      repinLimit: { label: "Self-heal rename limit", hint: "Max re-pins after the host renames the new chat, default 3; 0 = off." },
      keepFork: { label: "Keep source session in fork", hint: "Only meaningful when childMode=fork." },
      cardSectionsGuide: { label: "Card · guide section", hint: "Off = omit the onboarding checklist." },
      cardSectionsFiles: { label: "Card · touched-files section", hint: "Off = omit the changed-files list." },
      cardSectionsUsage: { label: "Card · usage section", hint: "Off = omit source-session context usage stats." },
      counterFile: { label: "Counter file path", hint: "Empty = use the default path." },
    };

    // ── 设置分区组件（React.createElement / h，照 dsh-force-compact 的分区写法）──
    const wrapStyle = { display: "flex", flexDirection: "column", gap: 2, maxWidth: 860 };
    const titleStyle = { fontSize: 18, fontWeight: 600, margin: "0 0 4px" };
    const introStyle = { fontSize: 13, opacity: 0.75, lineHeight: 1.6, margin: "0 0 10px" };
    const rowStyle = { display: "grid", gridTemplateColumns: "220px 220px 1fr", gap: 12, alignItems: "center", padding: "7px 0", borderBottom: "1px solid rgba(127,127,127,0.15)" };
    const labelStyle = { fontSize: 13.5, fontWeight: 550 };
    const hintStyle = { fontSize: 12.5, opacity: 0.62, lineHeight: 1.5 };
    const inputStyle = { width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 13, borderRadius: 6, border: "1px solid rgba(127,127,127,0.35)", background: "transparent", color: "inherit" };
    // 设置页脚注（开发信息）；样式照 dsh-xwide-annotation 的分区脚注：小字、低对比、上边线
    // X-WIDE 标识（用户 2026-11-18 要求放进页脚；320px 调色板 PNG 内嵌约 5KB）
    const LOGO_URI = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAFAAeADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD36ikopiFpM0UUAFLmkooAWjNJRQAUZoooAWikooAM0UUUAFGaKKACiiigApaSigBaSiigAzRRRQAUtJRQAUUUUAFLSUUALSUUUALSUUUALSZoooAKKKKACiiigAozRRQAuaSiigBaKKKACikpaBhRRRQAUZpKKAFooooEGaKSigApaSigApRSUo60AJRQaKACiiigAooooAKKKKACiiigAoopaAEopaKAEopaSgAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKWkoGFFFLQISloopDCikzRQAUUUooASloppNAC5opKWgAopaSmIKKKKACiiigAooooAKUdaSlHWgBO9FHeigAooooAKKKKACiiigAooooAWiiigAooooAKKKa24HK8juKAHUU1XVx8p6dR6U6gBKWiigAooooASloooASilooASiiigAopaSgAooooAKKKWgAooooASiiloGFFISBTCxNFhXH5ppNIDQOTgdaNEG4uaUA0oUClpXuMOlJmg0Y9aQxKWilpiEooooAWkoopiCiiigAooooAKKKKAClHWkpR1oATvRS0lABRRRQAUUUUAFFFFABRRRQAUtJRQBBex3MtuwtLgQTY+VmTcv4ivPtT8S+KtJufIvDFGf4WEIKuPUGvSKgvbG21G2a3u4Vlibs3b3Hoa68LiIUnapBSXpqcWMwtStG9KbjL10PMx4517/n4h/wC/Ipw8b66f+W8P/fkVd1jwa+nb57S3N3bZztDkSIPp/EPesARWrLlY3B/uiXn9RXvU44SrHmhBNeiPmK08dRly1JtP1ZqjxjrTNkzxZ9REM1ZTxjq/eWI/9sxXMO0at8u8D/axQJQO9aPB0X9hfcZRxuIX/Lx/ezrR4u1U/wDLWL/v2KePFmp95I/+/YrlFmHrUyzD1rJ4Ol/KvuNFjcR/O/vOm/4SrUz/AMtY/wDv2K39E14aivkz7VuVHbgOPUe9efLMPWrEU7I6vGxDKcgg8g1hWwNOUbJWZtRzGvTnzOTa7M9S304HNc/o+trfxeVMQLhRz6OPUVrrLXg1KcqcuWR9HRxcKkVJMt0VEsoI61IDnmoOqMlLYKKKKChaSlpKACilooASikLBRknFAJPbFAC9KM5ppYCq1zfxW6kllz7niqUW3ZDLRIUZJxVaW9VOF5NYs+rLK3+sJA9BSvOscC7FcyuM4YfdH0rojh2viFdGg11I/IOB7Cnq5IyzHHsetZ1sssjDeDnqE/qfStRFWPknc3r2H0pVEoaIuML6skGcfNwPSnebt6ACoHnA6cmq7TE9K5eST1N407lt7pgflI/Kmfa5PUflVQMzfdGfeoWmYHmn7NmsaK2NI3TqOSB+FRm+f2/Ksw3FNE2TyT+FWqTNFh11RpG/mzwQPwo+3zkgLjJ6ALVa2hluT8i4XuxrXgtY4BwMt3Y9aGkjGp7OGltQtxcEbpmA/wBkCp6KKg5G7u4UU15FjXLHA/nUX76U/wDPJP8Ax4/4U0hE1FIqhF2qOKWkIKKKKACiiigApRSUo60AJRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAC0UlIckfKcGgB1YGteFbPVN00IFvdHneo4b6j+tbSyAuUPyuOx7/AEqQdK0p1J0pc0HZmNWlTrx5Zq6PHtU0q80yYw3URUno3UN9DWQXeJ8jGR6jNe53Vpb3sDQ3MSyxt/Cwrg9e8DNCGuNPZ3j6mMjLL9PWvoMHmkJ+7V0f4HzmMympT9+l7y/E4v7fP0Kxf9+1/wAKeuoSA/NHGR/ugf0qtPC0T7SydcZJx/Ooljds7dhx6Ov+NexyQaueNaRpLqcuflihx7xg086hNIAMRpg9UTFUFgmH8A/77X/GpVgm7J/48P8AGocKa7CtI3bO6PySRSfvV5wOCD9K7LTNWW9iw3yzKPmHr715iZDG+2QbW69a19P1eW3kRnxIF6E/eH0NedjMEqsbrc68PWlTejPS45x/F+dW1fIz29RXOWWoxXcIlibjuO4NaMNyVPB+o9a+cqUZQdme3h8ar2ka4YE4p1VopVkGU691qZWrI9iFRSVySik70xpAp2qCzf3RRY0ckh5OBzUXmNJxEMj++en4etGzPMpDHsg6D/Gns6qpZ2CqBkkngUxXbEVApyTub1NNlnjiHzsBWFqHiWKMlLRA5H/LRjgfgK5u51a4uWO+Tj0FdtLA1KmstDknjKcXaOp0uo64gjZID8x756Vgxia8m2rukc+p6D+gqG2hM8ZmkcRW6nBkYdT6KO5qx9o3RmK3QxwE85PzP/vH+nSu6FKNJcsNzN1ZTd2W4/KtTiMiWbvJj5V/3R3+tW7WCSdt7MQpPLdzVa0t8sDJ09K2UdQMKOAOtc9WdtFueph6Mrc0kTIqxJtUYH6mmyP8vJwKie4XaSD06selUZrwDO05/wBo1yqEmzuhSlJliSQJ1I+neoEu1ldlx05A9qz2nMpbGdo+83YfU1VaQA/u3JOOW6ZrqjQvvud0MOmrPc1Z9QCHb1GOgNUnvmb0A9BVEsM5Jp8MbXD7YlJ9WPQVqsPGKuzdUqdNXZft7hXBUqWkPTFbdjpJ4kuRj0T/ABp2jWNtbx71y8w+8zDp9PStJ5VQ7eWc9EXk1wVqqb5YHk4jFJtxp7D1AVQqgADoBSJKkm7YwbacHHrURjeUfvjhf+ean+Z71JuCAIi9OiqOn+Fc1jgH5xUXmtJxCAf9s9B/jR5Zf/WHI/ujp/8AXqWjRAMSIK24ks/94/09KfRRSEFFFFABRRRQAUUUUAFKOtJSigANJRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQA10WQYYZxyPUUzdJF9/Lx/3gOR9RUtFCYnG+qBWV1DKQQehFNmkMUTOqFyB90daZ5WCXhIVj1H8LfWljnDuY2Uo47EcH6HvTt1Jv0ehxGtWumazKzELa3fd8fu39m9PrXn2o2Uul33lXNqB3Cscqw9QR1Fexa14di1NGkgcW912cD5W/3h/WvL9Yu77SZm0zV7MSQ5yEk6H/AGo27fh+Ir6bK6/OuWDv5Pf5f19x83mGFcJc01v1W3z/AK+8wTLas53ROi9gmD/OrosbUbS/2hdw3D5FOR+DVmy+Q7FraRmTrtf7y/X1+oqGOSW3mWWJirqchlr3XBte67HlLlT1RrqNNU4M8w+seKcLlfMwjFkHAJ6kVlS3ZuXLyBfMJySowPyqQxyxIkhU+W/3XHIP4+tT7L+Z6ile1kjp9M1NrWYOhyDwy+orrIdQDorqcqeRXmMVztYBjjnr6VvafqZt2Cu6vC38SnIHvXm4vBKXvJahGbPQLe+5BDdK2ba+SXAc7W9fWuHiuMEEH3BBrailFvCkt1JjeMrGv3mHr7CvCr4VHfhMZVpy026nVZI57etKGB6VzkGvlJPmQeV02Dt+PrTdV8TJBDttB+8I6sMbfp71yrCVXJRSPdhmFGUeZM2NQ1O102P9626QjKxr1P8AhXGapr8982GbbGDxGvT8fWsW51GaVmZuWY5JJJJqmks91MsUEZeRjhVUcmvaw2XxprmlqzhrYudb3Vouxde4J6mrkdvDZos2ohi7DMdqpwze7n+Efqahtttk2UMdxdjrJ1jh+nZj79B2zSwRm4uTI7GVmOWc/wCeTW8vLRf1/X5DpU3fuy2sk19IrTgAAYjiQYVB6Adh+tacEKoAzcdhgfyqNYFtTtI3Sn+DPT/eP9Kk3hBvdxnpuP8AICuOcubSOx9JgcufxzLocADPA7KOf/1mmy3gQYPJ/uA/zNZct8eQmVz3/iP+FVFkkuFYxhRGv3pHO2Nfqe/0FQqHWR7XsoU1ebsaE16WBZ3AVfwUVTuLnC5dyg7A/eP0Hb6mqE2pRW7f6OfOmHHnyLwv+4vb6nmsqa7wxLsWcnnNdVLDN9LAqml0rRNlr1mQICdi9ATUX2lmbaCSfQVji5J5Z8ewHNaujWlzf3Hl28LN/ex0H+8a2qQjTi2KWNglaJrWVn5iK8zH/cB/ma6Oy053QEqIoR046/Srem6MlnEDNtkl6/7Iq5NdxwuIwGlnI4jQZb/6w9zXgVcRKpKyPJrYiVR3bFjhKJsjHlp3PVj/AIU9DFGCEwOeT1yfr3NRqssvMpA/6ZoeB9T3qVQq9CCemf8ACuZnOB3H1Ufqf8KUYAx+gpxGaAMdKkA5+n0paKKQBRRRQIKKKKACiiigAooooAKUdaSlHWgApKKKACiiigBaSiigAooooAKKKKACiiigAooooAKKKKBjSnO5Ttb9DRw3yuuD/npTqXrRcVhOR7iqWq6RY63ZNa38Cyxnof4lPqD2NXfbrSdOlVGUoyUouzRMkpKz1R4V4s8Eah4aka5hL3Gn54nUcp7OB0+vSuVSdkO5SMjsRkGvp9gsiMjqGVhhlYZBFeXeMPhhnff+HkAPLSWWeD7p/h+XpX1WXZ3GdqWJ0ffo/Xt+R4eLyy3v0dV2PNG3oRvUqWG4e49as2t5cRRyeWvmQjDSRsMofQkf1qtHcmANZ3kTmJWIKEYeJu5GenuD1qJ2Nu7CC4DxuuCyHBK9wR2+lfQNcy5WjyFGzudLDZ22p2CS2Urvcxp++gbG9cdwP4l+nIqknmQvjnINYwuhHOJIN8W05U7/AJgfqMVqrrQuWBvEDSd5UGCfqO/1rF05x81+KM6kOqOg0/VfLRY5eFHAPYVqf2hs6Nk+nWuchMMqB423KetWvMRVyDIMdgFxXBUoxbvYyjq9TYOpzHoF/Kq11ezyglnjUY5ODVS2dp0wjM9xniMJhcfWra20IYNcYnkHSFG+Qf7zd/oPzrLkhB7HXSjqQ2kMt2+9mWO1X/WTuCFHsPU+wq35q7XhtEaG3bh3P+slHofQew/WnJbzXsgJYCNOMgYVB6KOla9hYKrBkThedz/zPpWdWrFav7j1MNRlVfLTXzKtrpskgVZFKocbYlHJ+v8AhWzDF9nIjgUGYdWH3Y/p6n37VZijUJu3FIm6y4+eT2Udh71BPdlk8m3i8uHptA6/WvNnVlUdv6/r+mfWYLLo0t1dkEkkUCkDEjHqSePxPeqLSS3DbucHgHHJ9gKklktoMtdTIiqMnJ4H4dSfauY1PxJLOWjs1aGHpu/jYf0HsK6qFCU37q+Z6FfERoq3U27m6s7If6SRNKOlujcf8Db+grEvdXmvWBlkVY1+5Gowq/RawzO7cZNNeQAYBye57V6dPBxi7vVnlSxnvX3Zee7bB2sEH94nmoYi8sqxxK8kjnCqoyzH2rS8PeEtS8QOJI08i0z81zIOD/uj+I/pXq2ieGtM8PQ4tY8zkfPcScu349h7CubGY+jhvdWsu3+ZlKtUqatnJ6B4Bnl23GrsYY+ot0Pzn/ePb6Dmu+iitNNtVihSOCFeAqjqf6mmtctIP9HA295X+7+H97+VNSNYz5rMWc8eY/LH6Dt+FfN4jEVa7vUfy/r/AIcm99hzNPNwCYIz/wB/G/w/nTooY7dCiIEBOSByzH1Jpyg4JxtHck8//WpVH9wf8CNc7fQLCnkYbgdlXvThn0x6ClVQPc9yaXFQ2AUtFFIAooooEFFFFABRRRQAUUUUAFFFFABSjrSUo60AJRSmkoAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAClpKWgAopjSKjKpzuboAKbuJPzcD0FFhOSRLijNQzTRwRb5XWOMccnr7VFHPJKwPlNHH238M34dh9apRbVyXNJ2Ob8YeA7DxPGbiIra6ko+WcDh/Zx3+vUV4dqml6n4c1T7PeQvb3MZyjDow9VPcV9OAnGW4rI8TafomoaO8evGFLUciWRghjPqp7Gvay3N6mHtSqLmh+K9P8jixOChVXOtGfN0949y4eRU3YwSqhc/lUYc1Z1O2tbXU7iCxuxd2qPiKfaV3j6GoFi3V9pCzimtjwJJJ2ZPb3stu+5GOfbvXR/bYngQgM0hUFlHAB+veuft7be4G0n2Fdfofhy51FvlXy4VPzykdPYev0rlxUqcFzTdjnnJc1orUhsRd3svkRHZH958DCqPU+tdXb6SsEQabcN3IQ/ePuff+VaVtZWumxLFDGMA5weSx9T7/AMqa7l5tvLyHnaO319K8KtinUfuKyPSwuFlUdnqxiRA4BACjoo6VZuLmCxh/fld3URnp+Pr9OlY15rsNkxS3KzTjjzf4E/3fU/7X5Vhvdi4kMkrFnPdjUwws6mstEfV4NUsOrR3Ohl1aacmTcQp6sao3XiIQpshXe/qegrKa8VGKBj6MCP6VUniB+eMfKfTpXXTwtNP3lodVXGzUbQEur6W5ctIc1TaWh2xxU2lwWNzqUUepXL29oT87xruP09vrXoJRhG9tEeTOtKT1Yyzs7zVLpbaxt5J5m/hQdPcnoB9a9I8PfDm1tNlzrLLdT9RAv+rX6/3j+ldVotnpdjpsY0dIvsrDO+M7i/uT1JrQDKwyDkV8xjc3q1bwpe6vx/4BcYdWINsahVAVVGAoGABVR1EjkykSYP3eiD/H8anKMTjNMfyrcrJIWJZgi8Z5PTAryI6bF2vuKoZzkDP+0w4H0FSABTlcu/ck/wBakxkc/kKUDFS5DG7M8tz7dhTqKKkBaKKKBBRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABSjrSUo60AIaKWkoAKKKKACiiigAooooAKKKKACiiigAoopaAEpaKQnFAC0U3k+1NaUKdqgsw7Dt9fSiwXHMTg9gOpNVTO0gP2YAjvM4+X8PX+VOMZnIMmHHZf4B/8AFULPD9o8gSCSYdVHO36+laJWM3dvsRx2iq/nOxklA/10vUfQdFH0pJb2GGJ5dyLEvLzyttQfiev4Vy3inx3Z6Sz21qqXl4vBBP7uM++Op9v5V5LrniDU9cm36hdvKAflj6Iv0UcV7GCyitiUpz92P9bI86vmFGi+WGrPRPEfxStbMPBogF5cdPtMgxGv+6O/+eteVapq2o61dGfULqa5lPTcchfoOgH0qrtZj0qzafbbfe1qzJ5yGJmXup6jP88V9RhcDQwkf3a17vf+vQ82piKlZ++9OxVRe5/KtjS9Lnv5AsakKe+K0dE8J3WoSKAuF6s7D5VFeq6T4es9ItlMo7ZwR8z/AOArHHZnToLljrI4XCpWfLT+/ojm/D/gjIE1xhYx1Y1080sNtCLazQLGg+9/Wp7q6eciNQQnRY0HWsq+ubeyGJiJZh0hU8D/AHj/AEr52VWriJ3qa+R34bBwpq6+cn+hFKwETTyy+TAOsp6t7KO5rldU8QGUNBZp5Nt3B5aT3Y/06VNqd/LeuWmIOBgDOAo9AO1Y/lpnIXJ9Sc16uGw8Y+9PVnqU5KK5aehSedmYlmJPqTUTTtjANWXsnbJjGSP4R/T/AAqkwNerDlewp1Zx3LEN6uBHcqXj6B1++n09foafOJ7VY5oZvMhYEq6enAOR27VQIqWJrqxZJ1QhJV43D5XHQ0OCvdfcKOIlazLEJt747XmW1nPRn/1bf1X+VLcWVzYOouIyu7lXByrfQjg1Alu160hgjUMDkQg849vWn2uo3NiGiUh4ScPBKu5D9Qeh/Wk1K/u/d/wRuonuauieIdQ0O48y0l+Qn54m5R/qP616joXiWz19M27i3vgMvbyH7309R7jmvJo49P1Dm1k+x3B/5YTNmNj/ALLdR9DUD/adPuFEivDKpypzj8QR/SvOxeBpYr+7P+t+4415Q31R77HOGcRspSTGSpP6j1FTFsDIGfXHavNvD/jxJVSy135lyNl2v3lP+1j+Y/Gu9WdolV3cSwMMrOnTHvj+Y4r5fE4OpQlyzX/B9P6ud1OrGaumXcg9DRUePlLR4OecUquD9a5LGpJRSUtIAooooEFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFKOtJSjrQAGkoooAKKKKACiiigAooooAKKKKACiiloAKKKRtu07sbe+aAGGQ7tqgkj0pSVQc9T+JNMMnAWMYHY4/kKjleK2jMtxKI1PGSeW9v/AKwqlG+hHN1JGZ3OBkewPP4ntUE08FqVjfLytysMa5J98f1NNzdXSgRg2kH94r+8b6Dov48+1MmjGnWU0lpFmXG5h96ST8T1NaKKvZkSnZOX9fcU9WvjaWZuNQkeCI8La27fvJD6Fu34fnXm+teK9RuY2s7RF0+0BwYoOCf95upq3rGqXWq3G5xsVOAO4+prEvFUhpHCogGOOB/9evpMBg4U0nUV3+X9dz5LG5nOrO1N2j+L/rsYEkbEZPC9s96qtGCdoBLnoAMmtYjzwAilFPVyMs3sB2Fa2m+G5J8F18mI9QeWavbliI01eRNCjOTOdsNJa4nAEXmv1Cc7B7sep+g6+td7ofg4zTCSZfMcAcEYAH8gPauj0rw7b2ECvKnkx9cfxvWm07Oogto/Lj/uL1P1NeDi80nUbjS+89dYRqNqmnkuv9f0hYkttNjCQhZJB/Fj5VP9TUE0pKtPcS7E7u3f2A71Xub2G1+UYll9B91f8axLy4nuXLyMWbtnoPoK4KVBzd395nUlCmrdunT5k17rrKrR2cZjQ8Fyfnb8e34VzFxdl+B1JrUSwnvJCqKTgZYk4Cj1J7CrVpaQ2kipYxG6v24EpGQn+6P/AGY16UHSorRa/wBbsw9rUqay2/rZGKumC3QXOp7kU8rbqcSP9f7o/WtOLwzf6jaSXcNoluuMxQk4Zx7Z/r1rqdM8ORwyi6viLi6JyAeVQ/1PvXQhfWuOvmbT9zV/h8l+p6eGpSS10PFpY2hlaORGSRDhlYYINKbKO+4PyynpIB1+o7/XrXq2r+H7LWo/3ybJwMJOg+YfX1FcJeaLeaJchZ0yufklX7rf4H2rtw+YQrLTSR6FOhzvllscjdadPaSbJoyueh7N9DTYp7iKBrUMGt5DzGwyAfVfQ/Su7WSDU4vJmiXzO8Z43e6n1rFutBZJd0GXUHlSPmH+NdtPGKXu1FZk1ssnSlzU3dHNNAySF4ifkPUdVq6ZrfUV2Xw8u4xhblR1/wB4d/rTvJZJWIyDk1HJa+Yf3YAk/u9m+nvXS5KW/wB5wuLW33FC7sp7KQCVcqfuuvKt9DVi31K4ihEMyC4tT/yzk5A+h6g1YtbloopI7gCS3Bw8TZ3A+3vTpNL/AHf2myPn27HlOjL/APX/AM803NP3ai+f9bMy5Jbw+7+t0RxwW8rh7eQhepjc/MPoe9db4Z1+80uQQr+9s2PMDHhf909q45YSDlcsB1/vD6itC1m2kYcficVz4mlGrBxlqiqdZwex7TZTQXEAltDhD1jPG3/D+VWxhhyK850jWprYqS/TjIrtLDVUvVyCm8dgev8AhXyWJwk6Tb6Hq0q0ZrQ0cFfcU4U1XD5HQjqD1FLiuM1FooopAFFFFAgooooAKKKWgBKKKKACiiigAooooAKUdaSlHWgApKWkoAKKKKACiiigAooooAWiiikMKKaXA6c4/Sm4Z/p79Pyp2FcGlA+7z70m0v8AM/AHPP8AninhQvufU1A9qZ5CZ5C8X8MQGF/H1/lVKxLTIvtLzkpYopGfmnf7g+n94/p70+Kzjhfz5GM0+P8AWyckfQdAPpVrouFA4HArLv8AUorFf3775e0Sdfx9KuN5PlgRO0FzSLE07gE7vLXux6n/AArmtR8RRwbo7Y7mHVs/1rM1XWLi7Yq5Kqfuwxd/qaxHtJLk4l+VR0iQ/wAzXr4bAxSvUPFxWIqzdqZVvdRa4nbykErnk4GFFVYtNub6UNId5HqPlX6Cuis9FaVgix4XP3VFdbY6FDbIpnA46IK7a2PpYeNomeDyadR889F+JzOjeGCzBkTc3eR+grqIbe104fulE04/jbov0q85O3y0XavZVqpJJHF0Akft/dH+NeJVx0qzvJ6HvRw1PDxtBDHywM9zJtX+8ep+g71n3N67qY7dTHEeCSfmb6/4VO++eTfJ8x/2qljtGnk+Vct6AYApRrxW55+InJ+7AxDGwA4GT7VZTTdqiW9LIp5WNR87/wCA9zW0lvDanMYEk/8AfxkL9B3PvT0si775ckk5wT1+ta/W30OFUHfXV/h/wTHS1ub7EEcSwWwP3R90e57sa27HToLCPbCvzH7znq3+fSraRhRgCpQtYVK8pK3Q76OG5feerIjlFJVCzYyFBxk+makBbI3DGR0/pUgWl2gjB5FYOR2xhYAOKZPBFcwtDPGskbdVYcGn4I6H8ad1FTezujeOhxWq+GGtd01oDJAOSv8AEn+IqrBcJKoiuuvRZscj/e9fr1rvsc1kaloUU+ZrYBJe69mr0KWM5ly1fvPRoYmPw1PvOM1DS0MhEqhZDyJF/iHr7isC6sZLc5IyvZh0rtQphBtriMtHn7nRkPqp7f1qG4sNihwBLC/CyL/Ij19q9Kji3DRixGAhU1WjOIEaSsvnZR1+7MoyR7EdxUkUdxZXLCIg7+QR9166GXT4SDtRVI6ECqwt2g42hoz/AAnp/wDWru+sKSPOeCcXd7mW0Mdy+dpjlHVT1B9jTfszJzIm4f31HP41tmCG4TJU8cbh95KhMckJCyYZD0fsaSrdERUwsXq/vKcEZUblOV9R2+orUtLmWJgySYI96hW3Un90dr/3SeD9DUkSckEYPdTWVSSktTH6vKDOv03XVlCx3Zww+7MO31roVfgbiDnow6GvOY121t6Xqktp+7fMkB6oe30rxsThF8UDqgm1qddRUNvPHPEHifch/MfWpq81qzsNoKKKKQgooooAKKKKACiiigAooooAKKKKAClHWkpR1oAKSlNJQAUUUUAFFFFABS0lFAASB16noKYSzcAf5+tP4zn0paAGhAOvOOlOooPA5oGFRTzxW6bpGwOw7moZLksSkZK/7ZAP6VmXEUbSFijzP/flfr+ArWnTu/eE2+hFqOtTFQtuVjDe4Lfj6fQVgTJK3MhZS3JyPmP4f1NbhgkAB3IvoqDFKlk87Z5b1YmvQpzhSWhi6HtHdnOJaM5wqFQeuByfxrasdEMiKXQIg/iIwT/jW1b2EMOCRvb36CrLEZ9TXNiMy6QNqeFhB3tchhghtU2woB6seppHbnAyT+tS4J6Cm7Qv19a8eVZyld6nWrFeVSRjO0dx3quYRV4QmQ4QfjVmO3SH5iNz/wAqUXOb02MK0UyjDYkjfJ8ifqamIyvlxLsj7+p+tWGVnbLHPtSiOuqKOGVO+iII4FXoOfWpljAqQLS4rW5UKKQ0LS4p2KMUrmyiJilpaKQ7CUUtFAxKKWigdypeWEN4nzjDjo46isf7HNZyMrKGRuCD91xXR010WRCrAEGtI1ZRVuh0UsRKC5XqjmZdOV1LwgsvdT95P8R71ReyQjmune1MLb4ycDuOoqGW2S4BKqEk6kDo3/163p4xp2Z1KupLXY5OezZZTKgCk9QBwajWISAgDn+JDXRm2ABVs5HY9qrG1UnOMEdDXdHEpoiUFfQwWtCn3Advp3H0p/k7lXfnOOGxW4LVXOCMfhT/ALEoGB27VTxS6k+yVjGhUA4cg+/b8atJAyngEirvkL0K/mKmjTbgLxWU63YlUkmO08vDIGR9pPUHoa3YpRIPRh1FZsUSt9/g9jjg1bVCuAcgjoa8ytUTdyakYst0U1GOMN+dOrNO5zNWCiiimIKKKKACiiigAooooAKKKKAClHWkpR1oAQ0UtJQAUUUUAFFFFABRRRQAUUUUAFLSUtAxuxf7o/Kk8qPOfLX8qfRRdgR+THnPlp+VO2J/dH5U6ii9wE2r/dFJtX+6PypaKVkF2JtX+6KNif3R+VLRRyoLsAABgACiiigAwKKKKYgooooAKKKKACiiigAooooAKKKKACiiloGJSbE/uD8qWlpANMaMcsik+4pvkxf88k/75p9FMLsZ5MX/ADyT8qUxRnqin8KdRRcd2M8mL/nmn5UeTF2iT/vmpKKLsLsb5af3F/KlwMYwKWkpCuwwPQUUUUAFFFFMQUUUUAFFFFABRRRQAUUUUAFKOtJSjrQAlFL3pKACiiigAooooAKKKKACiiigApaSigBaMVjeJ/DVl4q0aTTr1pYwfmjmhcq8T9mBH8jwa+V/GnhrxJ4I1b7FqF5dPDJk290kz7Jl/Phh3FVCKl1FJ2PsGivmP4YfFi48LXC6Xrcstxo0rcSMSz2zHuO5X1HbqPSvobUvEujaToJ1u81CFNO2B0mDZEmegXH3iewFEoOLsCaaNajFfKnxA+LGq+MLg2tk0un6QjZSJGxJLjozkf8AoI4HvVLwN4L8TeOr3FteXdvp0bYnvZJX2r7KM/M3t+dV7Kyu2Ln1sj63orH8NeGrDwtpCafYeayj5pJpnLySt/eYn+XStisygpaKKACjFeVfHqwnl8E2+p20ssb2N0pcxuV+R/lPT32187WOuajp+o216l7cs1vKkoDTMQdpBx19q0jT5lclySdj7eoqvZXcV/YW95AcxXESyofZhkfzr5n+Nmn3mh+P5biC6uUtdRiFwgWZgA33XA59Rn8amMeZ2G3ZXPqCivlP4ReKbjSPiHYx3V3M9tfg2kgkkJALfdPP+0APxr6rolHldgi7oKXFcV8TPHEXgnwy80TK2qXQMVnGf72OXI9F6/XA718oPqepTSs7395JLI2SfObLMT9euacKbkrilJI+5KK4P4V+Dp/CvhhZdSklk1a+AkuPMkLeUP4Yxn0B59yfauP/AGhNemtLLRtItriSJ5pHuZfLcqdqjavT3Y/lSUbysht2Vz2zFJXxVoS6jrXiDTtLjvbstd3KQ/69uhIz39M19poixRrGgwqAKB7CnOHKEZXH0V43+0Fr01joelaXbTvFJdTtM5jYq2xBjqO2WH5V4Auo6k7BVvr1mPQCdyf50403JXE5pOx9x4oxXxB9p1n/AJ76l/33JR5+snpNqR/4HJVex8xc/kfb+KSviOHW9b0+cNDqmo28q8jFw6kfrXqvw6+NWpQ6pb6T4onF1ZzuI0vGAEkLE4G4j7y579R71MqTSuNTTPoelpK8P/aF16a2TRdHtp5ImcvdS+W5UkD5V6fVvyqIx5nYpuyue40V8Nrf6jI21Ly9Zj2WZyf51J9o1f8A57aj/wB9yVr7F9yPaI+4MUYr4g+0ax/z21H/AL7ko+06x/z31H/vuSj2PmHP5H2/ikr5h+H3w48S+LpkvL6+1DT9HByZmlcSTe0YJ/8AHjx9a+ktL0uz0XTobCxjMdvEMKCxYn1JJ5JPqazlFRdrlJ3LlFFFSMKKKKAFpKKKACiiigApaSigApR1pKUdaACkpTRQAlFFFABRRRQAUUUUAFFFFABRRS0DCsvxB4e0zxPpEumarbia3k5HZkbsynsR61qEgDJOAOteM/Eb41waZ52keFpEuL3lJb4fNHCe4T+83v0HvTim3oJtJanjvjvwfN4I8SyaVJcx3MZUSwSqRuKHpuH8Lf8A6xXPyXl1NaQ2stzM9tASYoWclI89do6DNW7W01bxPrYgt47jUNSunyeSzue5Ynt7ngVreMPAWt+CJ7dNUiRoZ0BjuISWjLY5TP8AeH69RXWn0e5h5o7P4afBybxHHBrWvkw6S4DwwI3z3I9SR91f1PtX0ZZWVrptlFZ2VvHb20K7Y4o12qo9hXyz8Nvide+CbsWl1vutElbMkGctCT1eP+o7/WvqLTNTstZ06DUNOuEuLWdd0ciHgj+h9q56vNfU1ha2had1jjaR2CooLMT2ArzL/hffgsEgHUjg9RbcH9a7/XNNfWNCvtNjumtGuoWh89F3FAwwSB9K8iH7OWnAY/4SS7/8B1/xqY8v2hu/Q3f+F+eDP7up/wDgMP8A4qt7wn8TNC8aanLYaRDfmSKLzZHmhCoozjrnqSa4T/hnPT/+hku//Adf8a7zwD8PrHwDZ3cVtdSXc11IGkmkQKcAYCgDsMk/jVS5LaCXN1NbxhpI13wdq+mYy1xauqD/AGwMr+oFfFfPQjB7ivu+vjPx7o/9heO9a08LtjS5Z4x/sP8AMv6GqovdE1F1Po34M6v/AGt8M9OVmzLZFrR+f7p+X/x0rXlXx18XWWu69baPYqki6WXEtwOcyNjKA+gxz7/Sua8H/EO78IeF9e0yzDi5v9htpQeIWwVdvrtxj3Fctpmm3mt6tb6dYxtPd3UgRF7knqSfTqSaqMLScmJyurIqxyPDKksTFZI2DIw7EHINfZmi+KbLUPA1r4muJlhtWtBPO5PCED5x+BBFfIOuaPdaBrl5pN6B9otJTG5Xo3oR7EYP41ot4x1M+BY/CSsFsRctcOwPLg4IT/dDZb6n2qpw5rWFGXLuL448W3PjPxPcarPuSH/V20JP+qiHQfU9T7mu2+CHgb+3dcPiC+izp+nP+5VhxLP1H4L1+uK868O6FeeJtfs9HsVzPcvt3EcIvVmPsBk19kaBodn4b0O00iwTbb2yBR6se7H3JyfxqaklFcqHBXd2aVfK3xt1cap8SbqFWzHYRJbL9cbm/VsfhX1NNMlvBJNIcRxqXY+gAya+IdW1B9W1m+1GQ5e6uHmJ/wB5iaiitblVHod98C9JGo/EaO6dd0dhbvPz2Y/Iv/oR/KvqOvFv2d9H8nRNW1l15uZ1t4z/ALKDJ/Vv0r2eSVIYnlkbaiKWY+gHJqajvIcFZHy98c9X/tL4jS2qtmPT7dIBj+8fnb/0ID8Kv/s/6OL3xpd6lImUsLU7SR0dzgfoGrzXW9SfWdf1DU5Dlru5eb8CxI/TFfQ/wA0n7H4HudRZcPf3TEH1RBtH67q1n7sLER1lc9X49qWiiuc2PM/jhpenXPw7u7+4gj+2Wrxm3m2jcCXAIz6EE8V8uNwpx17V77+0D4qtjZWfhi2mV5zKLi6CnOxQDsU+5Jzj2HrXkXgjQn8SeNNK0tVJSScPLgdI1+Zj+Q/WuinpC7MZ6yPsPSjIdHsTNnzTbx78/wB7aM18tfGTV/7W+JmohW3RWQS0T22jLf8AjxNfVF9dxadp1zeS4WG2iaVvYKM/0r4hvLuS/vri9mJMtxK0rk+rEk/zqaK1uVUeljt/hP4n0Hwh4iutV1vzyfs/lW4hi3kFiNx9uBj8a9g/4Xz4I/6iH/gJ/wDXrzbwX8Fbjxb4YtdbfWBZLcltkX2fedoYjOdw64NdB/wzi/8A0M4/8A//ALKnLkb1Yo8yR1P/AAvrwR/1EP8AwE/+vS/8L58EY+9qA/7dD/jXK/8ADODf9DP/AOSf/wBlWv4c+AOnaVrUN9qmqHUoITuW2MGxWYdN3JyB6d6m1Mr3j1qyu0v7C3vIldY541kVZF2sARkZHY1PRwBgDAFFZFBRRRQAUUUUAFFFFABRS0lABRRRQAUo60lKOtACUUppKACiiigAooooAKKKKACiiigAqjq+s6doOnSahql5Fa2sY+aSRsfgPU+wq9VHUdG0vWBGNT061vBGSUFxEHCn2zQM+bfiH8YtQ8VGbTNIL2Ojk7W5xLcD/aI+6v8Asj8fSuV8HeCNY8a6j9l0yHbAhHn3Tj93CPc9z6Ac19W/8IT4V/6FzSv/AAET/CtSx0+y0y2FtYWkFrACWEcEYRcnqcCtVUSVooz5bvUwfBfgXR/BGnfZ9Pj8y5kA8+7kH7yU/wBB6AVsa1o2n+INKn0zVLZbi1mGGRux7EHsR2NX6Kyu73LPkX4hfDvUPAmpfNuuNKmbFvd4/wDHH9G/n2o+H3xH1DwLqGFJudKmbNxaFv8Ax9PRv0Pf1r6yvbG01K1a2vrWG5gYgmKaMOpx04NZX/CFeFf+hc0r/wABE/wrX2t1aSI5NbouaJrmm+I9Jh1PSrpLi1lGQynlT3Vh2I9DWjVLTtH0zR0kTTNPtrNJDudbeIIGPqcd6u1kywooooGFfOn7QujfZfEum6wi4S9tzFIf9uM8f+OsPyr6LqlqWj6brESRanYW15GjbkW4iDhT6jNVCXK7ikrqx8O7gO4r6U+Cvw9OgaZ/wkOpw7dTvUxBG45ghP8AJm6n0GB613y+C/CyMrL4c0oMpyCLROD+VbtXOpzKyJjCx87ftB6B9k8QWGvRpiO9i8iY/wDTROn5qf8Ax2vGsj1FfceoaXp+rQLBqNlb3cKtvCTxh1B9cHvzWb/whXhXOf8AhHNJ/wDANP8ACnGrZWYnC7ucH8D/AAN/YehnxBfwldQ1FP3SsOYoOo/Fuv0xXrNIAFUAAAAYAHalrKTbdy0rHHfFTV/7F+G2szq+2WaH7NH/AL0h2/yJP4V8hZCr1HAr7kv9MsdVtvs+o2cF3AGDeXPGHXI6HB71mf8ACE+Fe/hvSv8AwET/AAq4TUUTKNyl8NtH/sP4eaLZsoWU24ml/wB5/mP88fhUXxR1f+xfhvrNyr7JZIfs8Z/2pDt/kT+VdcqhVCqAFAwAOgqvf6bY6rbfZ9Rs4LuAMG8ueMOuR0OD3qL63ZVtD4ayOmRXQaf478UaTYxWOn69eW1rCCI4o3AVQTnjj1Jr6x/4Qrwqf+Zc0r/wET/Ck/4Qjwr/ANC5pX/gIn+FbOqn0M1BrqfLP/CzfGv/AEM9/wD99j/CmS/EjxlNG0b+J9R2sMHbLt/UV9U/8IR4U/6FvSv/AAET/ClHgnwqOR4c0r/wET/Cl7SPYfK+58gaZpGr+JNQMOm2d1qF1IcsUBc59WboPqTX0r8K/hmPBNrJf6i0cus3KbX2crAnXYp7nPU+1egWtla2EPk2dtDbxDokMYRfyFT1M6jkrDjBI8/+M+sDSfhpfoG2yXrJapzz8xy3/joavlHI9RX3FqWkabrEKQ6nYW15GjblSeMOAemQD3rN/wCEI8Kf9C3pX/gIn+FOFRRVglG58oWPjzxTptlDZWXiC9t7aFdscUcgCqPQcVY/4WV40/6GfUP+/o/wr6n/AOEI8Kf9C3pX/gIn+FJ/wg/hT/oW9K/8BE/wp+0j2FyvufLP/CyvGn/Qz6j/AN/R/hW/4H8V+M/EvjbSdKbxLqTxSzhpgJf+Wa/M36Aj8a+h/wDhB/Cn/Qt6V/4CJ/hVqw8M6FpVyLnT9GsLWcAqJYbdUYA9RkCk6kbbAovuatFFFZFhRRRQAUUUUAFFLSUAFFFFABRRRQAUo60lKOtABSUtJQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFIZBb3trdy3EVvOkj20nlTKpyY3wDg++CD+NT1yfg/nXPGH/YX/8AaEVdZTasIKhvLy20+zlu7yeOC3hXdJLIcKo9SamrlviScfDjXsYz9lIGenUULVgW18beGGZV/t6wBY4G6YD+dbwIIBByD0IriNetfF114ZvoJf8AhHI4ntXV2bzDhSvP3uAcevFbng66tb3wZotxZJOlq1nEIluDmQKFAG49zx1702gNyufHjjwu2duuWRwSMiTIyK6CvOfh2PEZ8C6b9j/sn7L+92ecJN+PNfrjihLQDv7W7t761jurWVZYJBlJEOQwqZmCqWY4AGSfSkXdtXfjdjnb0zUd1/x5zf8AXNv5UhjbO8ttQs4byzmSe3mUPHIhyGB7ip65f4cHPw50D/rzSuooejEQ3d3b2FnNd3cyQ28KGSSRzgIo5JNSo6yIrowZGAKkdCDXOfEHj4deIv8AsHzf+gmtvTv+QXaf9cE/9BFFtLjJbm5hs7WW5uZUigiQvJI5wFUckk+lYY8deFiARrtmQRkHfSeOzjwB4gz/ANA+b/0A0zRl8S/2dYeZ/ZHk+THnasm7btH64ppKwjoo5EliSSNgyOoZWHcHoajvb2206ymvLyZYbaFC8kj9FUdSampk0MVzBJBMiyRSoUdGGQykYIP4UhjkdZEV0YMrDKkHgioLK/tNRgaeynSeJZGjLocjcpwwz7EEV5/Hq99oeg3Hg+CQtrkNwun6c7cloJATHMfZIw2feP3rvNJ0y30bSLXTbRcQW0QjTPU47n3J5P1ptWEWpZY4YXllcJGilnZjgADqTWCnjvws6hk12yZSMgh+CKveIjjwxqxP/PlN/wCgGsDwiPEh8JaGVOkeR9hg2/LJu27FxntnFCStcDroZ4rmCOeFw8UihkdejA9DT6KKQBRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAC0lLSUAFFFFABSikpRQAUlLSUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQBDDaW9tJPJBBHG87+ZKyLgu2AMn1OAB+FTUUUAFV76xtdSsZrK9gS4tpl2yRSDKsPQ1YooA5w+AvChxu0K0YejKSD+BODXQoiRxrHGqoigKqqMAAdgKdRRdgFc+PA/hhfu6LaLkk4VSBk+wroKKAK9nZW2n2qWtpCsMCZ2ovQZ5qcgMpBGQRgilooA55fAvhZAAuiWigdAqkAfhmtu1tYLG1jtraJYoIhtRF6KKmoou2BFc20F5ay211Ck0EqlJI3XKsp6gj0qRVVEVEAVVGAB0ApaKAIrm2gvLWW1uYklgmQpJG4yGU8EEelYo8E+GVxt0a1GOBgH/ABrfooAZFFHBCkMShI41Cqo6ADoKfRRQBUbTbGTVI9Te0ha+jiMKXBX51QnJUH0q3RRQAyWKOeF4ZUV45FKurDIYHgg1hL4I8MRgBNEtFCjAAUgCugpKAI7e3htLeO3t41jhjXaiL0UVLRRQAUUUUAFFFFABRRRQAUUUUAFLSUUAFLSUUALSUUUAFFFFABSjrSUo60AJRS0lABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUo60lKOtABSUuKMUAJRS4oxQAlFLijFACUUuKMUAJRS4oxQAlFLg0YNACUUuKMUAJRS4NGDQAlFLijFACUUuKMGgBKKXFGDQAlFLg0YoASilxRigBKKXFGDQAlFLg0YoASilxRigBKKXBoxQAlFLijBoASilwaMUAJRS4NGKAEopcUYoASilxRigBKKXBoxQAlFLijFACUUuKMUAJRS4oxQAlFLg0YoAKSlxRigBKKXBoxQAlKOtGKMUAf//Z";
    // [2026-11-18 用户「把标向上移，字向右移」] 改横排：logo 在左顶格上移，文字块挪到 logo 右侧
    const footerStyle = { marginTop: 24, paddingTop: 0, display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 18, fontSize: 12.5, color: "#979da7", lineHeight: 1.7 };
    // 脚注里的可点链接（用户 2026-11-15 要求：发布页 / B站 / 邮箱都要能点开）
    const linkStyle = { color: "#6ea8ff", textDecoration: "underline", textDecorationThickness: "1px", textUnderlineOffset: "2px", cursor: "pointer" };
    // 「交接行为」分组卡片（P5）：底比页面亮一档 + 1px 描边 + 圆角 + 内 padding，组外上下各 24px。
    // 行内三列表语法仍用 rowStyle，只在组内把分隔线减淡、末行去线（boolRow 第 4 参可选传入）。
    const groupStyle = { margin: "24px 0", padding: "10px 14px 8px", borderRadius: 10, border: "1px solid rgba(153,200,255,0.22)", background: "rgba(255,255,255,0.04)" };
    const groupTitleStyle = { fontSize: 13, fontWeight: 700, color: "#99c8ff", letterSpacing: "0.02em", margin: "0 0 2px" };
    const groupSubStyle = { fontSize: 12.5, opacity: 0.6, lineHeight: 1.5, margin: "0 0 4px" };
    const groupRowStyle = { ...rowStyle, borderBottom: "1px solid rgba(127,127,127,0.12)" };
    const groupRowLastStyle = { ...groupRowStyle, borderBottom: "none" };

    function XwideHandoffSection(props) {
      const { useXwideHandoff, update, mutatePath, t } = props;
      const snap = useXwideHandoff((s) => s);
      if (snap.status === "unavailable") {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: hintStyle }, t("unavailable")));
      }
      if (snap.status === "loading" || snap.value === undefined) {
        return h("div", { style: wrapStyle }, h("h2", { style: titleStyle }, t("nav")), h("p", { style: introStyle }, t("intro")), h("p", { style: hintStyle }, t("loading")));
      }
      const value = snap.value;
      const disabled = !snap.writable;
      const label = (k) => {
        const e = t(k);
        return typeof e === "string" ? e : (e && e.label) || String(k);
      };
      const hint = (k) => {
        const e = t(k);
        return (e && typeof e === "object" && e.hint) || "";
      };
      // 第 4 参 rs：组内行可传减淡分隔线的样式。勾选态只留勾选框（P4：删掉右侧 on/off 小字，原生 checkbox 已表达状态）。
      const boolRow = (key, on, onToggle, rs) =>
        h("div", { key, style: rs || rowStyle },
          h("span", { style: { ...labelStyle, minHeight: 32, display: "flex", alignItems: "center", cursor: disabled ? "default" : "pointer" }, onClick: () => { if (!disabled) onToggle(!on); } }, label(key)),
          h("span", { style: { display: "flex", alignItems: "center", minHeight: 32 } },
            h("input", { type: "checkbox", checked: !!on, disabled, style: { width: 16, height: 16, margin: 0, accentColor: "#4c8dff", cursor: disabled ? "default" : "pointer" }, onChange: (e) => onToggle(e.target.checked) })),
          h("span", { style: hintStyle }, hint(key)));
      const textRow = (key, raw, commit, placeholder) =>
        h("div", { key, style: rowStyle },
          h("span", { style: labelStyle }, label(key)),
          h("span", {}, h(DraftInput, { value: raw === undefined ? "" : String(raw), disabled, placeholder: placeholder || "", onCommit: (v) => commit(v) })),
          h("span", { style: hintStyle }, hint(key)));
      const selectRow = (key, current, options, commit) =>
        h("div", { key, style: rowStyle },
          h("span", { style: labelStyle }, label(key)),
          h("span", {},
            h("select", {
              value: String(current == null ? options[0].value : current),
              disabled,
              style: inputStyle,
              onChange: (e) => commit(e.target.value),
            }, options.map((o) => h("option", { key: o.value, value: o.value, style: { background: "#1f1f20", color: "#e8e8e8" } }, o.label)))),
          h("span", { style: hintStyle }, hint(key)));

      const sections = value.cardSections && typeof value.cardSections === "object" ? value.cardSections : {};
      return h("div", { style: wrapStyle },
          h("style", { key: "xwh-ph" }, ".xwh-input::placeholder{color:#9aa0aa;}"),
          h("h2", { style: titleStyle },
          h("a", { href: "https://github.com/XWIDE/dsh-xwide-handoff", target: "_blank", rel: "noreferrer noopener", style: { color: "inherit", textDecoration: "none", cursor: "pointer" } }, t("nav")),
          // [2026-11-18 用户「加上插件名字」] 标题后追加插件全名
          h("span", { style: { fontSize: 15, fontWeight: 500, opacity: 0.75, marginLeft: 10 } }, "dsh-xwide-handoff")),
        h("p", { style: introStyle }, t("intro")),
        boolRow("enabled", value.enabled, (v) => update("enabled", v)),
        textRow("commandName", value.commandName, (v) => update("commandName", v.trim() || null), "handoff"),
        selectRow("childMode", value.childMode, [
          { value: "none", label: "GUI 亲生 / gui-native (visible)" },
          { value: "create", label: "服务端 / server-side create" },
          { value: "fork", label: "fork（带历史）" },
        ], (v) => update("childMode", v)),
        // ── 「交接行为」分组卡片（P5）：三行勾选包进成组容器，三列表语法与行内结构不动 ──
        h("div", { key: "handoffGroup", style: groupStyle },
          h("div", { style: groupTitleStyle }, label("handoffGroup")),
          h("div", { style: groupSubStyle }, hint("handoffGroup")),
          boolRow("autoHandoff", value.autoHandoff, (v) => update("autoHandoff", v), groupRowStyle),
          boolRow("autoExecute", value.autoExecute, (v) => update("autoExecute", v), groupRowStyle),
          boolRow("inPlace", value.inPlace, (v) => update("inPlace", v), groupRowLastStyle)),
        textRow("autoHandoffPct", value.autoHandoffPct === undefined ? "" : Math.round(Number(value.autoHandoffPct) * 100), (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || v.trim() === "") return update("autoHandoffPct", null);
          const p = n > 1.5 ? n / 100 : n; // 接受 90 与 0.9 两种写法
          return update("autoHandoffPct", Math.min(0.95, Math.max(0.5, p))); // 允许 50–95（用户 2026-11-18 定）
        }, "90"),
        textRow("readyPct", value.readyPct === undefined ? "" : Math.round(Number(value.readyPct) * 100), (v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || v.trim() === "") return update("readyPct", null);
          const p = n > 1.5 ? n / 100 : n; // 接受 70 与 0.7 两种写法
          return update("readyPct", Math.min(0.99, Math.max(0.05, p)));
        }, "70"),
        textRow("contextWindow", value.contextWindow, (v) => {
          const n = Math.trunc(Number(v));
          return update("contextWindow", Number.isFinite(n) && n > 1000 ? n : null);
        }, "262144"),
        textRow("readyCooldownMs", value.readyCooldownMs, (v) => {
          const n = Math.trunc(Number(v));
          return update("readyCooldownMs", Number.isFinite(n) && n >= 0 ? n : null);
        }, "600000"),
        boolRow("compact", value.compact, (v) => update("compact", v)),
        textRow("recentUserMessages", value.recentUserMessages, (v) => {
          const n = Math.trunc(Number(v));
          return update("recentUserMessages", Number.isFinite(n) && n > 0 ? n : null);
        }, "6"),
        textRow("titleTemplate", value.titleTemplate, (v) => update("titleTemplate", v.includes("{seq}") ? v : null), "项目名_{seq}"),
        textRow("seqWidth", value.seqWidth, (v) => {
          const n = Math.trunc(Number(v));
          return update("seqWidth", Number.isFinite(n) && n > 0 ? n : null);
        }, "2"),
        textRow("maxTitleChars", value.maxTitleChars, (v) => {
          const n = Math.trunc(Number(v));
          return update("maxTitleChars", Number.isFinite(n) && n > 8 ? n : null);
        }, "64"),
        textRow("repinLimit", value.repinLimit, (v) => {
          const n = Math.trunc(Number(v));
          return update("repinLimit", Number.isFinite(n) && n >= 0 ? n : null);
        }, "3"),
        boolRow("keepFork", value.keepFork, (v) => update("keepFork", v)),
        boolRow("cardSectionsGuide", sections.guide !== false, (v) => mutatePath(["cardSections", "guide"], v)),
        boolRow("cardSectionsFiles", sections.files !== false, (v) => mutatePath(["cardSections", "files"], v)),
        boolRow("cardSectionsUsage", sections.usage !== false, (v) => mutatePath(["cardSections", "usage"], v)),
        textRow("counterFile", value.counterFile, (v) => update("counterFile", v.trim() || null), ".dsh/xwide-handoff-counter.json（工作区内）"),
        h("div", { key: "footer", style: footerStyle },
          // [2026-11-18 用户「把标向上移，字向右移」] logo 挪到最左、顶格（原在文字下方）；去掉 marginTop
          h("img", { src: LOGO_URI, alt: "X-WIDE", title: "X-WIDE", style: { height: 96, width: "auto", borderRadius: 8, flexShrink: 0, alignSelf: "flex-start", border: "1px solid rgba(255,255,255,0.18)", boxShadow: "0 1px 4px rgba(0,0,0,0.45)" } }),
          h("div", { style: { display: "flex", flexDirection: "column", gap: 3, paddingTop: 4 } },
            h("div", {}, `dsh-xwide-handoff v${PLUGIN_VERSION} · ${PLUGIN_DATE}`),
            h("div", {}, `支持的 DeepSeek Harness：${SUPPORTED_DSH}`),
            h("div", {}, "作者 ",
              h("a", { href: "https://space.bilibili.com/374064919", target: "_blank", rel: "noreferrer noopener", style: linkStyle }, "X-WIDE"),
              " · B站 ",
              h("a", { href: "https://space.bilibili.com/374064919", target: "_blank", rel: "noreferrer noopener", style: linkStyle }, "374064919"),
              " · xiupk@sina.com.cn"),
            h("div", {}, "发布页 ",
              h("a", { href: "https://github.com/XWIDE/dsh-xwide-handoff", target: "_blank", rel: "noreferrer noopener", style: linkStyle }, "github.com/XWIDE/dsh-xwide-handoff")))));
    }

    /** 草稿文本框：本地编辑，失焦/回车才写回（避免逐字符打宿主）。 */
    function DraftInput(props) {
      const { value, disabled, placeholder, onCommit } = props;
      const [buf, setBuf] = React.useState(String(value == null ? "" : value));
      React.useEffect(() => setBuf(String(value == null ? "" : value)), [value]);
      return h("input", {
        type: "text",
        className: "xwh-input",
        value: buf,
        disabled,
        placeholder: placeholder || "",
        style: inputStyle,
        onChange: (e) => setBuf(e.target.value),
        onBlur: () => {
          if (String(value == null ? "" : value) !== buf) onCommit(buf);
        },
        onKeyDown: (e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        },
      });
    }

    function apply(ctx, config = {}) {
      // ── 设置分区（独立 try：任何缺席都不影响交接主逻辑）────────────────
      try {
        // [dsh-fix 2026-10-12] 这里原来是 `break;` —— JS 里 break 只能出现在循环/switch 内，
        // 在 try 块里是 SyntaxError，会让整个 client.js 加载失败（实测报 "Illegal break statement"）。
        // 原意是「依赖缺席就放弃设置分区、继续交接主逻辑」，所以用 throw 交给下面的 catch 接。
        if (!h || !React || typeof ctx.get !== "function" || !ctx.get("slots") || !ctx.get("locale") || !ctx.get("configForms"))
          throw new Error("设置分区依赖缺席（缺 slots/locale/configForms 或 React 运行时）");
        if (!createSnapshotStore) createSnapshotStore = fallbackSnapshotStore;
        const scope = ctx.configForms.get(NS_SETTINGS);
        const store = createSnapshotStore({ status: "loading", value: undefined, writable: false });
        const derive = () => {
          try {
            const s = scope.getSnapshot();
            if (s && typeof s === "object") {
              store.update((d) => {
                d.status = s.status;
                d.value = s.value;
                d.writable = s.writable;
              });
            }
          } catch {}
        };
        const unsub = scope.subscribe(derive);
        derive();
        ctx.effect(() => (typeof unsub === "function" ? unsub : () => {}), "xwide-handoff: settings subscription");
        ctx.effect(() => {
          const disposeDict = ctx.locale.register(NS, { zh, en });
          return () => {
            if (typeof disposeDict === "function") disposeDict();
          };
        }, "xwide-handoff: settings dictionaries");
        const t = ctx.locale.bind(NS);
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "dsh-xwide-handoff",
          order: 30,
          label: () => {
            const v = t("nav");
            return typeof v === "string" ? v : "Handoff";
          },
          inject: () => ({
            hooks: { xwideHandoff: store },
            t,
            update: (field, val) => (val === null || val === undefined ? scope.unset(field) : scope.set(field, val)),
            mutatePath: (path, val) => scope.mutate([{ op: val === null ? "unset" : "set", path, value: val }]),
          }),
        }, XwideHandoffSection));
        console.log("[xwide-handoff] 设置分区已注册（settings.section → configForms:" + NS_SETTINGS + "）");
      } catch (e) {
        console.log("[xwide-handoff] 设置分区跳过: " + ((e && e.message) || e));
      }

      // ── 交接主逻辑 ────────────────────────────────────────────────────
      try {
        const sessions = ctx.get("sessions");
        if (!sessions) {
          console.log("[xwide-handoff] no sessions service（浏览器半跳过）");
          return;
        }
        const MARKER = "HANDOFF-PAYLOAD-V1 ";
        // [防重放·红线] 只认「新鲜」payload：stamp 距现在必须 ≤ 这个毫秒数。
        // 事故教训（2026-10-13）：去重只靠 localStorage xwh.seen，换浏览器/清缓存后 seen 为空，
        // 历史会话里的旧 HANDOFF-PAYLOAD-V1 被逐条重放 → 批量建会话、批量改名，侧栏被打穿。
        // 现在：stamp 由服务端写（index.js: `stamp: new Date().toISOString()`），解析不了/缺席/过期
        // 一律拒绝建会话（只记 seen，不再重复打日志）。这是**结构性**防线，与 localStorage 无关。
        const PAYLOAD_MAX_AGE_MS = 5 * 60 * 1000;
        const repinLimit = Number.isInteger(config.repinLimit) && config.repinLimit >= 0 ? config.repinLimit : 3;
        const SEED_PREAMBLE =
          "【交接卡·只读】这是上一个会话自动注入的交接卡。你只需要回复一句『已接收交接，等待指令』；" +
          "不要分析卡片内容、不要给任何选项、不要自行开工。我的下一句指令才是任务。\n\n";

        const load = (k, d) => {
          try {
            const v = JSON.parse(localStorage.getItem(k) || "null");
            return v && typeof v === "object" ? v : d;
          } catch {
            return d;
          }
        };
        const save = (k, v) => {
          try {
            localStorage.setItem(k, JSON.stringify(v));
          } catch {}
        };
        const seen = new Set(load("xwh.seen", []));
        const want = load("xwh.want", {}); // childId -> 目标标题
        const pin = load("xwh.pin", {}); // childId -> 已重钉次数

        /** 从会话事件里倒着找最新一条 payload。 */
        function extractPayload(s) {
          try {
            const evs =
              typeof s.snapshotEvents === "function" ? s.snapshotEvents() : typeof s.messages === "function" ? s.messages() : [];
            for (let i = evs.length - 1; i >= 0; i -= 1) {
              const data = evs[i] && evs[i].data;
              if (!data) continue;
              let texts = [];
              if (Array.isArray(data.content))
                texts = data.content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text);
              else if (typeof data.text === "string") texts = [data.text];
              for (const t of texts) {
                const idx = t.indexOf(MARKER);
                if (idx < 0) continue;
                try {
                  const p = JSON.parse(t.slice(idx + MARKER.length).split("\n")[0].trim());
                  if (p && typeof p.title === "string" && typeof p.card === "string") return p;
                } catch {}
              }
            }
          } catch {}
          return null;
        }

        /** best-effort 打开/聚焦新会话：候选 API 逐个试，全失败就留在列表里。 */
        function tryOpen(id) {
          const tries = [
            () => sessions.activate && sessions.activate(id),
            () => sessions.open && sessions.open(id),
            () => sessions.focus && sessions.focus(id),
            () => sessions.select && sessions.select(id),
            () => ctx.get("navigation") && ctx.get("navigation").openSession && ctx.get("navigation").openSession(id),
          ];
          for (const fn of tries) {
            try {
              const r = fn();
              if (r) {
                console.log("[xwide-handoff] 已请求打开新会话：" + id);
                return true;
              }
            } catch {}
          }
          console.log("[xwide-handoff] 未找到「打开会话」的公开 API —— 新会话已建好并命名，请在列表点一下");
          return false;
        }

        async function processPayload(parentId, p) {
          const key = parentId + "|" + String(p.stamp || p.title);
          if (seen.has(key)) return;
          // ── 新鲜度闸门（先于任何建会话动作）────────────────────────────
          // 无戳 / 戳不可解析 / 超龄 → 直接丢弃：历史里的旧交接卡永远不可能触发建新会话。
          const stampMs = typeof p.stamp === "string" ? Date.parse(p.stamp) : NaN;
          const age = Number.isFinite(stampMs) ? Date.now() - stampMs : NaN;
          if (!Number.isFinite(age) || age > PAYLOAD_MAX_AGE_MS || age < -5 * 60 * 1000) {
            seen.add(key);
            save("xwh.seen", [...seen].slice(-50));
            console.log(`[xwide-handoff] 忽略非新鲜 payload（${parentId}，stamp=${p.stamp || "(缺失)"}）`);
            return;
          }
          seen.add(key);
          save("xwh.seen", [...seen].slice(-50));
          const cwdOk = typeof p.cwd === "string" && /^[a-zA-Z]:[\\/]/.test(p.cwd);
          let newId = "";
          // ① 带当前模型/智能体新建（DeepSeek 用 DeepSeek，千问用千问），失败退回只传 cwd
          const req = {};
          if (cwdOk) req.cwd = p.cwd;
          if (typeof p.agentPreset === "string" && p.agentPreset) req.agentPreset = p.agentPreset;
          try {
            const created = await sessions.create(req);
            newId = (created && created.value && created.value.sessionId) || "";
            if (!newId)
              console.log(
                "[xwide-handoff] create(带preset) 失败: " +
                  JSON.stringify((created && created.error && (created.error.message || created.error.code)) || created),
              );
          } catch (e) {
            console.log("[xwide-handoff] create(带preset) 异常: " + ((e && e.message) || e));
          }
          if (!newId) {
            try {
              const created2 = await sessions.create(cwdOk ? { cwd: p.cwd } : {});
              newId = (created2 && created2.value && created2.value.sessionId) || "";
              if (newId) console.log("[xwide-handoff] 已退回「只传 cwd」新建：" + newId);
            } catch (e2) {
              console.log("[xwide-handoff] create(只cwd) 异常: " + ((e2 && e2.message) || e2));
            }
          }
          if (!newId) return;
          want[newId] = p.title;
          save("xwh.want", want);
          // ② 填好第一句
          try {
            const r = await sessions.get(newId).prompt([{ type: "text", text: SEED_PREAMBLE + p.card }], "queue");
            if (r && r.ok === false)
              console.log("[xwide-handoff] prompt 失败: " + ((r.error && (r.error.message || r.error.code)) || "?"));
          } catch (e) {
            console.log("[xwide-handoff] prompt 异常: " + ((e && e.message) || e));
          }
          // ③ 命名（Alt+G 同一条 RPC）
          try {
            await sessions.using(newId, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(p.title));
            console.log(`[xwide-handoff] 交接新会话已建：${newId} 命名「${p.title}」`);
          } catch (e) {
            console.log("[xwide-handoff] rename 异常: " + ((e && e.message) || e));
          }
          // ④ 打开（best-effort）
          setTimeout(() => tryOpen(newId), 600);
        }

        function scan() {
          try {
            const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
            const ids = (snap && snap.ids) || [];
            const byId = (snap && snap.byId) || {};
            for (const id of ids) {
              const row = byId[id];
              if (!row || row.blank) continue;
              if (row.updatedAt && Date.now() - row.updatedAt > 15 * 60 * 1000) continue;
              try {
                sessions.using(id, { source: "workspaceOperation" }, (ref) => {
                  const s = ref && ref.binding && ref.binding.session;
                  if (!s) return;
                  const p = extractPayload(s);
                  if (p) void processPayload(id, p).catch((e) => console.log("[xwide-handoff] process 异常: " + ((e && e.message) || e)));
                });
              } catch {}
            }
            // ⑤ 自愈重钉
            for (const cid of Object.keys(want)) {
              const r = byId[cid];
              if (!r) continue;
              const t = String(r.title || "");
              if (!t || t === want[cid]) continue;
              const n = pin[cid] || 0;
              if (n >= repinLimit) continue;
              pin[cid] = n + 1;
              save("xwh.pin", pin);
              try {
                sessions.using(cid, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(want[cid]));
                console.log(`[xwide-handoff] 自愈重钉：${cid} -> 「${want[cid]}」（第${n + 1}次，原「${t}」）`);
              } catch (e) {
                console.log("[xwide-handoff] 自愈重钉异常: " + ((e && e.message) || e));
              }
            }
          } catch {}
        }

        // [修复 2026-10-13 18:35] 停用「每 5 秒扫全量会话 + 重放历史交接卡」自动扫描器。
        // 事故记录见 profile\cordis.patch.yml:577-581：去重只靠 localStorage(xwh.seen)，写入路径
        // 一变 seen=空 → 历史 HANDOFF-PAYLOAD-V1 被逐条重放（批量建会话 + 改名）→ sessions.list
        // 变化 → subscribe 回调再扫 = 正反馈死循环 → 渲染进程持续重算 → 界面卡死 / 心跳丢 /
        // 断开连接再重连。当前 childMode=create（服务端直接建会话），浏览器半边不需要自动扫描。
        // 恢复方式：把下面 9 行取消注释（原件备份在 default-workspace\_fix-backup-20261013-1835\client.js.bak）。
        // try {
        //   ctx.on("session/create", () => setTimeout(scan, 1500));
        // } catch {}
        // try {
        //   if (sessions.list && sessions.list.subscribe) sessions.list.subscribe(() => setTimeout(scan, 800));
        // } catch {}
        // setInterval(scan, 5000);
        // setTimeout(scan, 3000);
        // ── 自动提示横幅（2026-11-17 修复②）──────────────────────────────
        // 用户原话：「自动交接是没有告知用户…不新建对话是可以的」→ 服务端到阈值不再建新会话
        // （index.js attachAutoReady 已改为纯日志），提示由这里在浏览器 DOM 弹横幅。
        // [防卡死红线] 本 watcher 只读事件、不写会话、不建会话、不改名 → 无正反馈环
        //   （2026-10-13 卡死事故：扫描器写 localStorage + 改 sessions.list → subscribe 回灌）。
        const noticed = new Set(load("xwh.noticed", []));
        let noticeEl = null;
        function showNotice(text) {
          try {
            if (noticeEl && document.body.contains(noticeEl)) return true;
            const el = document.createElement("div");
            el.setAttribute("data-xwh-notice", "1");
            el.style.cssText =
              "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
              "background:#8a5a00;color:#fff;padding:10px 16px;border-radius:8px;font-size:14px;" +
              "box-shadow:0 2px 12px rgba(0,0,0,.35);max-width:80vw;";
            const span = document.createElement("span");
            span.textContent = text;
            const close = document.createElement("button");
            close.textContent = "×";
            close.setAttribute("aria-label", "关闭提示");
            close.style.cssText = "margin-left:12px;border:0;background:transparent;color:#fff;font-size:16px;cursor:pointer;vertical-align:middle;";
            close.onclick = () => el.remove();
            el.appendChild(span);
            el.appendChild(close);
            document.body.appendChild(el);
            noticeEl = el;
            setTimeout(() => el.remove(), 60 * 60 * 1000);
            return true;
          } catch {
            return false;
          }
        }
        function latestInputTokens(s) {
          try {
            const evs = typeof s.snapshotEvents === "function" ? s.snapshotEvents() : [];
            for (let i = evs.length - 1; i >= 0; i -= 1) {
              const u = evs[i] && evs[i].data && evs[i].data.usage;
              if (u && Number.isFinite(u.inputTokens)) return u.inputTokens;
            }
          } catch {}
          return NaN;
        }
        function noticeScan() {
          try {
            if (!config.autoHandoff) return;
            const snap = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null;
            const ids = (snap && snap.ids) || [];
            const byId = (snap && snap.byId) || {};
            for (const id of ids) {
              const row = byId[id];
              if (!row || row.blank) continue;
              if (row.updatedAt && Date.now() - row.updatedAt > 15 * 60 * 1000) continue;
              if (noticed.has(id)) continue;
              try {
                sessions.using(id, { source: "workspaceOperation" }, (ref) => {
                  const s = ref && ref.binding && ref.binding.session;
                  if (!s) return;
                  const n = latestInputTokens(s);
                  if (!Number.isFinite(n)) return;
                  const ratio = n / (Number(config.contextWindow) || 262144);
                  if (ratio < (Number(config.autoHandoffPct) || 0.85)) return;
                  noticed.add(id);
                  save("xwh.noticed", [...noticed].slice(-50));
                  showNotice(`上下文到 ${(ratio * 100).toFixed(0)}% 了 — 打 /${config.commandName} 可交接（自动交接已改为只提示、不建新会话）`);
                  console.log(`[xwide-handoff] 提示横幅已弹：${id} ${(ratio * 100).toFixed(1)}%`);
                });
              } catch {}
            }
          } catch {}
        }
        // 判定器入口（显示类断言用）：playwright 调它弹一条假提示，验 DOM 真在页面上。
        globalThis.__xwhNoticeTest = (pct) =>
          showNotice(`上下文到 ${pct}% 了 — 打 /${config.commandName} 可交接（自动交接已改为只提示、不建新会话）`);
        setInterval(noticeScan, 5000);
        setTimeout(noticeScan, 4000);

        console.log("[xwide-handoff] web half active（自动扫描已停用 2026-10-13；提示横幅 watcher 2026-11-17 上线）");
      } catch (e) {
        console.log("[xwide-handoff] client init skipped: " + ((e && e.message) || e));
      }
    }

    /** createSnapshotStore 缺席时的极简兜底（订阅语义同形，无 React 批处理）。 */
    function fallbackSnapshotStore(initial) {
      let state = { ...initial };
      const subs = new Set();
      return {
        get: () => state,
        update: (fn) => {
          const next = { ...state };
          fn(next);
          state = next;
          for (const s of subs) {
            try {
              s();
            } catch {}
          }
        },
        subscribe: (fn) => {
          subs.add(fn);
          return () => subs.delete(fn);
        },
      };
    }

    module.exports.apply = apply;
    module.exports.inject = ["sessions", "slots", "locale", "configForms"];
    return module.exports;
  },
});
