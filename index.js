// dsh-named-handoff — 交接 + 确定性命名（DeepSeek Harness 插件）
//
// 要解决的问题：
//   · 本地/云端模型的上下文窗口有限，快满时继续聊会掉质量，官方自动压缩是有损的；
//   · 交接出新会话后，DSH 官方取名服务会用"第一句话"给新会话取名，
//     于是列表里出现一堆同名、认不出顺序的会话。
// 本插件把交接做成一条命令，并保证新会话名是**我们要的**、带递增序号（_01/_02/_03…）。
//
// 全程本地：零网络、零模型调用。任何 API 漂移都降级，不让命令或启动崩溃。
//
// 用法： /handoff [本次交接重点/未完成事项]   ← 备注会进标题（模板含 {note} 时）与卡片

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_TITLE_CHARS,
  DEFAULT_SEQ_WIDTH,
  DEFAULT_TEMPLATE,
  formatStamp,
  isNonUserTitleEvent,
  isSyntheticUserText,
  nextSeqFrom,
  renderTitle,
  resolveBase,
  sanitizeSegment,
} from "./naming.js";

export const name = "dsh-named-handoff";
// compaction 是**运行时可选**：部分 preset 里该 seam 在隔离作用域内拿不到，
// 作为挂载前置条件会让整个 preset 被标 broken（卡片显示「加载失败」）。
export const inject = ["commands", "sessions"];

// [dsh-fix 2026-10-12] 加「接手须知 + 改动清单 + 上下文用量」三段后会变长：
//   实测旧卡 34 行；新卡按 30 个改动文件 + 6 条原话估约 6.3K 字符，旧上限 6000 会截尾。
//   卡片是新会话第一条消息，12K 字符 ≈ 4K token，对 262K 窗口毫无压力。
const MAX_CARD_CHARS = 12000;
const MAX_MESSAGE_CHARS = 800;
const NAMES_FILE = join(homedir(), ".dsh", "xwide-handoff-names.json");
const COUNTER_FILE_DEFAULT = join(homedir(), ".dsh", "xwide-handoff-counter.json");
// 旧版（dsh-named-handoff 时代）的状态文件：新文件不存在时自动读旧文件（序号不断档），
// 并且写回时双写旧路径，让旧工具链照常看到最新计数。
const LEGACY_FILES = {
  [NAMES_FILE]: join(homedir(), ".dsh", "named-handoff-names.json"),
  [COUNTER_FILE_DEFAULT]: join(homedir(), ".dsh", "named-handoff-counter.json"),
};

// [2026-10-13 关键修正] 本包被列进 dsh.profile.bundles 后，Loader 传给 apply() 的第二参不再是
// 普通值，而是 **Config schema 解析后的 ref**（每个键是带 .get() 的引用，见 @falling-ts/dsh-force-compact
// 的 bindConfig 用法）。于是 String(config.commandName) 得到 "[object Object]"，
// 官方注册器 normalizeDefinition 直接拒绝：
//   command name "[object Object]" must match /^[a-z][a-z0-9_-]*$/u
// → /handoff 根本没注册上（日志只剩「注册失败（不影响启动）」）。所以先逐个解引用再校验。
function unwrapRef(value) {
  return value && typeof value === "object" && typeof value.get === "function" ? value.get() : value;
}

function cfg(config) {
  const src = config && typeof config === "object" ? config : {};
  const c = {};
  for (const key of Object.keys(src)) c[key] = unwrapRef(src[key]);
  return {
    enabled: c.enabled !== false,
    commandName: String(c.commandName || "handoff"),
    template: typeof c.titleTemplate === "string" && c.titleTemplate.includes("{seq}") ? c.titleTemplate : DEFAULT_TEMPLATE,
    seqWidth: Number.isInteger(c.seqWidth) && c.seqWidth > 0 ? c.seqWidth : DEFAULT_SEQ_WIDTH,
    maxTitleChars: Number.isInteger(c.maxTitleChars) && c.maxTitleChars > 8 ? c.maxTitleChars : DEFAULT_MAX_TITLE_CHARS,
    counterFile: typeof c.counterFile === "string" && c.counterFile ? c.counterFile : COUNTER_FILE_DEFAULT,
    recentUserMessages: Number.isInteger(c.recentUserMessages) && c.recentUserMessages > 0 ? c.recentUserMessages : 6,
    compact: c.compact !== false,
    repinLimit: Number.isInteger(c.repinLimit) && c.repinLimit >= 0 ? c.repinLimit : 3,
    keepFork: c.keepFork === true,
    // "none"（默认）= 服务端不造会话，改由浏览器半用 GUI 亲生 API 新建**可见**会话；
    // "create" = 服务端造空会话。注意：**不能带 parentSession** —— DSH 会把带 parentSession 的
    //            会话从列表与可恢复集合里排除（@deepseek-ai/dsh-acp/lib/index.js:1267），
    //            这正是「交接完看不见新会话」的根因；
    // "fork"   = 继承全部历史（上下文不清零）。
    childMode: ["none", "create", "fork"].includes(String(c.childMode)) ? String(c.childMode) : "none",
    // [dsh-fix 2026-10-12] A 半自动：到阈值自动把新会话**备好**（建好/命名/置顶/卡片注入），
    // 但**不替用户切会话** —— 用户在侧栏看到置顶的新会话，点它继续。
    // 默认**关**（autoReady 必须显式 true 才开）；阈值默认 70%；冷却默认 10 分钟。
    autoReady: c.autoReady === true,
    readyPct: Number(c.readyPct) > 0 && Number(c.readyPct) < 1 ? Number(c.readyPct) : 0.7,
    readyCooldownMs: Number(c.readyCooldownMs) >= 0 ? Number(c.readyCooldownMs) : 600000,
    contextWindow: Number(c.contextWindow) > 1000 ? Number(c.contextWindow) : 262144,
    // [dsh-fix 2026-10-12] 卡片栏目开关（为开源分发准备）：用户可以关掉不想要的段。
    // 默认三段全开。支持：guide（接手须知）/ files（本轮动过的文件）/ usage（上下文用量）。
    cardSections:
      c.cardSections && typeof c.cardSections === "object"
        ? {
            guide: c.cardSections.guide !== false,
            files: c.cardSections.files !== false,
            usage: c.cardSections.usage !== false,
          }
        : { guide: true, files: true, usage: true },
  };
}

// ---------- 落盘：计数器 + 命名名单 ----------

function readJson(file) {
  const parse = (f) => {
    try {
      const o = JSON.parse(readFileSync(f, "utf8"));
      return o && typeof o === "object" && !Array.isArray(o) ? o : null;
    } catch {
      return null;
    }
  };
  const fresh = parse(file);
  if (fresh) return fresh;
  const legacy = LEGACY_FILES[file];
  return (legacy && parse(legacy)) || {};
}

function writeJson(file, obj) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(obj), "utf8");
    // 双写旧路径（若旧文件存在）：迁移期兼容旧工具/旧脚本，读到的仍是最新计数。
    const legacy = LEGACY_FILES[file];
    if (legacy) {
      try {
        readFileSync(legacy, "utf8");
        writeFileSync(legacy, JSON.stringify(obj), "utf8");
      } catch {}
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 取本次序号并**立刻占号写回**（按工作目录分桶，跨交接单调递增）。
 * 关键：序号不来自源会话标题尾号 —— 源会话每次都是新开的，尾号推算会永远算回 01。
 */
function claimSeq(counterFile, cwdKey) {
  const store = readJson(counterFile);
  const buckets = store.buckets && typeof store.buckets === "object" ? store.buckets : {};
  const used = Array.isArray(buckets[cwdKey]) ? buckets[cwdKey] : [];
  const seq = nextSeqFrom(used, 99);
  buckets[cwdKey] = [...used, seq].slice(-40);
  writeJson(counterFile, { version: 1, updatedAt: new Date().toISOString(), buckets });
  return seq;
}

function saveName(childId, title) {
  const names = readJson(NAMES_FILE);
  names[childId] = title;
  const keys = Object.keys(names);
  for (const k of keys.slice(0, Math.max(0, keys.length - 80))) delete names[k];
  writeJson(NAMES_FILE, names);
}

// ---------- 会话读取（全部 best-effort） ----------

function messageText(message) {
  try {
    const content = message && message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const out = [];
    for (const block of content) {
      if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
    }
    return out.join("\n").trim();
  } catch {
    return "";
  }
}

/** 最近的用户原话（旧→新），过滤掉系统注入内容。 */
function recentUserMessages(session, limit) {
  const picked = [];
  try {
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (const event of events || []) {
      if (!event || event.type !== "user/message") continue;
      let text = "";
      try {
        text = messageText(session.deriveEventMessage(event));
      } catch {
        text = messageText(event && event.data);
      }
      if (!text || isSyntheticUserText(text)) continue; // 卡片污染缺陷的修复点
      // [dsh-fix 2026-10-12] 剥掉附件引用尾巴：实测卡片里出现过
      //   「…我不知道这个会不会很复杂dsh-resource://file/absolute/C:/Users/.../pic.png」
      // 图片是独立的 content 段，拼进正文只会变成噪音。
      const clean = text.replace(/dsh-resource:\/\/\S+/gi, "").trim();
      if (!clean || isSyntheticUserText(clean)) continue;
      picked.push(clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}…` : clean);
    }
  } catch {}
  return picked.slice(-limit);
}

/** 会话所有历史标题（按事件顺序），用于取基名。 */
function titleHistory(session) {
  const out = [];
  try {
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (const e of events || []) {
      if (!e || e.type !== "session/title") continue;
      const v = e.data && (e.data.title != null ? e.data.title : e.data.text);
      if (typeof v === "string" && v.trim()) out.push(v.trim());
    }
  } catch {}
  return out;
}

function cardDir(session) {
  const cwd = (session && session.header && session.header.cwd) || process.cwd();
  const dir = join(cwd, "handoff");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

// ---------- 卡片要带的事实：改过的文件 / 上下文用量 ----------

/**
 * 本轮改过的文件（去重，按首次出现顺序）。
 * [dsh-fix 2026-10-12] 实测依据（.tmp-zstd\changes-probe-out.txt，源会话 session-ef20af83）：
 *   · workspace/changes 事件只有 {"turn":2} 这种 turn 号，**没有文件路径** —— 拿不到清单；
 *   · tool/call 里 write/edit 的 arguments 是 {"file_path":"C:\\...","content":"..."}，
 *     但 **JSON 键顺序不固定**（有的 file_path 在前、有的在后）→ 必须 JSON.parse，不能正则。
 *   宽容解析：解不开就跳过并计数，绝不让卡片生成失败。
 */
export function changedFiles(session) {
  const seen = new Map();
  let unparsed = 0;
  try {
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (const ev of events || []) {
      if (!ev || ev.type !== "tool/call") continue;
      const name = String((ev.data && ev.data.name) || "");
      const isWrite = /(^|__|:)(write|write_file|fs_write)$/i.test(name);
      const isEdit = /(^|__|:)(edit|edit_file|apply_patch|str_replace)$/i.test(name);
      if (!isWrite && !isEdit) continue;
      let args;
      try {
        args = JSON.parse(String((ev.data && ev.data.arguments) || "{}"));
      } catch {
        unparsed++;
        continue;
      }
      const p = args && (args.file_path || args.path || args.filePath);
      if (typeof p !== "string" || !p.trim()) continue;
      const key = p.trim();
      const row = seen.get(key) || { path: key, writes: 0, edits: 0 };
      if (isWrite) row.writes++;
      else row.edits++;
      seen.set(key, row);
    }
  } catch {}
  return { rows: [...seen.values()], unparsed };
}

/** 最近一次请求携带的上下文量（inputTokens）。判据同 A 半自动：这是「本次请求的上下文」，不是累计消耗。 */
export function usageOf(session) {
  let inputTokens = null;
  try {
    const events = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (const ev of events || []) {
      if (!ev || ev.type !== "assistant/message") continue;
      const u = ev.data && ev.data.usage;
      if (u && Number.isFinite(u.inputTokens)) inputTokens = u.inputTokens;
    }
  } catch {}
  return inputTokens;
}

// ---------- 交接卡 ----------

export function buildCard({
  title,
  sourceId,
  childId,
  notes,
  messages,
  compacted,
  renamedBy,
  seq,
  files,
  usage,
  sections,
}) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const on = sections || {};
  const lines = [];
  // 通道①：卡片第一行 = 目标标题原文。注入后它就是新会话的第一条消息，
  // 官方取名启发式会直接取到我们要的名字（不跟它抢，命中率最高）。
  lines.push(title);
  lines.push("");
  lines.push(`# 交接卡 · ${title}`);
  lines.push("");
  // [dsh-fix 2026-10-12] 「接手须知」放最前。理由：卡片是新会话里**唯一保证被读到**的文本
  //   （它是第一条消息，必然进上下文）；preset 规则只是一段系统提示，模型可以忽略 ——
  //   实测本地线就无视了本卡原先那句「读取 handoff 目录里最新那份交接卡」。
  //   把「该做什么」写进卡片，换任何模型 / 任何 preset 都照做（也让它更适合开源分发）。
  if (on.guide !== false) {
    lines.push("## 接手须知（先读这一段）");
    lines.push("1. **先读完整卡片**：源会话 cwd 下的 `handoff/` 目录里最新那份 `.md` 就是本卡全文 —— 要动手前先把它读完，不要只看注入的这份。");
    lines.push("2. **先报计划再动手**：一句话说清先做哪条、大约要多久、有没有分支，再开始。");
    lines.push("3. **不要重复已完成步骤**：下面「本轮动过的文件」都是已经改过的，先读文件现状再决定是否还要动。");
    lines.push("4. **拿不准就去查证**：文件、目录、会话记录都在磁盘上。不要下「我看不到 / 读不全」的结论就停住。");
    lines.push("");
  }
  lines.push(`> 新会话命名：**${title}**（序号来自落盘计数器，本次第 ${seq} 次交接）`);
  lines.push(`> 改名通道：${renamedBy || `降级 —— 请把新会话标题手动设为「${title}」`}`);
  lines.push("");
  lines.push(`- 生成时间：${stamp}`);
  lines.push(`- 源会话: ${sourceId}`);
  lines.push(`- 新会话: ${childId}`);
  lines.push(
    `- 压缩: ${
      compacted === null
        ? "未执行（配置 compact: false —— 对近满上下文做本地压缩在单卡上是分钟级，交接不值得等）"
        : compacted.skipped
          ? `跳过（${compacted.skipped}）`
          : `已压 ${compacted.count} 条（约 ${compacted.tokens} tokens）`
    }`,
  );
  if (on.usage !== false && Number.isFinite(usage)) {
    lines.push(`- 源会话上下文：约 ${usage} tokens（最近一次请求携带量；判占用看它，不看累计消耗）`);
  }
  lines.push("");
  lines.push("## 本次交接重点（你写的）");
  lines.push(
    notes && notes.length
      ? notes
      : "（/handoff 后面没写备注 —— 请以下方「本轮动过的文件」+「最近你的原话」自行判断该接哪条）",
  );
  lines.push("");
  if (on.files !== false && files && files.rows && files.rows.length) {
    const calls = files.rows.reduce((a, r) => a + r.writes + r.edits, 0);
    lines.push(`## 本轮动过的文件（${files.rows.length} 个，自动提取自 ${calls} 次 write/edit 调用）`);
    for (const r of files.rows) {
      const tag = [r.writes ? `write×${r.writes}` : "", r.edits ? `edit×${r.edits}` : ""].filter(Boolean).join(" ");
      lines.push(`- \`${r.path}\`${tag ? `（${tag}）` : ""}`);
    }
    if (files.unparsed) lines.push(`- （另有 ${files.unparsed} 条调用参数解析失败，已跳过）`);
    lines.push("");
  }
  lines.push("## 最近你的原话（逐条原文，按时间顺序）");
  lines.push(messages.length ? messages.map((m, i) => `${i + 1}. ${m}`).join("\n") : "（没有可提取的用户消息）");
  lines.push("");
  lines.push("## 在新会话里怎么接着走");
  lines.push(`1. 在会话列表里找标题为「${title}」的那条（本次交接新建；名字带递增序号，最新一条就是它）。`);
  lines.push("2. 第一句发：读取 handoff 目录里最新那份交接卡，按「本次交接重点」继续，不要重复已完成步骤。");
  lines.push("3. 大运算前先确认上下文余量；不够就再 /handoff 一次（序号自动 +1）。");
  lines.push("");
  let card = lines.join("\n");
  if (card.length > MAX_CARD_CHARS) card = `${card.slice(0, MAX_CARD_CHARS)}\n…（已截断）`;
  return card;
}

// ---------- 主流程 ----------

async function runHandoff(ctx, config, invocation) {
  const agent = invocation && invocation.agent;
  const session = agent && agent.session;
  // [2026-10-13 诊断] 这行是「命令到底有没有被派发到本插件」的分水岭探针：
  // 出现＝DSH 把 /handoff 交给我们了，问题在造会话那一侧；不出现＝指令派发/注册同步断了。
  console.log(
    `[xwide-handoff] handler 进入：commandId=${String((invocation && invocation.commandId) || "(无)")} ` +
      `session=${String((session && session.header && session.header.id) || "(无)")} ` +
      `childMode=${config.childMode} notes=${String((invocation && invocation.rawInput) || "").trim().slice(0, 40)}`,
  );
  if (!session || typeof session.snapshotEvents !== "function") {
    return {
      kind: "error",
      text: "dsh-named-handoff: 拿不到当前会话对象（sessions API 可能已改名），已停止，未改动任何数据。",
    };
  }
  const notes = String((invocation.rawInput || "")).trim();

  // 1) 本地压缩（可关；seam 不可用时跳过并如实写进卡片）
  let compacted = null;
  if (config.compact) {
    try {
      const result = await ctx.compaction.compactNow(agent, invocation.signal, invocation.commandId);
      if (result) compacted = { count: result.shadowedSeqs.length, tokens: result.shadowedTokenCount };
    } catch (error) {
      compacted = { skipped: String((error && error.code) || (error && error.message) || error) };
    }
  }
  if (invocation.signal && invocaationAborted(invocation)) {
    return { kind: "error", text: "dsh-named-handoff: 已取消，未创建新会话。" };
  }

  const sourceId = session.header ? session.header.id : "(unknown)";
  const cwdKey = String((session.header && session.header.cwd) || process.cwd());
  const messages = recentUserMessages(session, config.recentUserMessages);

  // 2) 新建新会话。默认 childMode="none"：服务端**不**造会话（造出来的是裸会话，GUI 列表看不见），
  //    改由浏览器半用 GUI「新建对话」同一条 API 建**可见**会话、填卡片、命名。
  let child = null;
  let createdEmpty = false;
  let createNote = "";
  let forkError = "";
  // [dsh-fix 2026-10-12] 会话头的 agentPreset 只是 init 默认值（建会话那一刻的 defaultId）；
  // 用户之后切换预设只落成 `agent-preset/selected` 事件。官方
  // @deepseek-ai/dsh-agent-preset-registry/lib/index.js:42 注释原话：
  //   "Reconstruction reads the `agentPreset` Session projection, never the header"
  // 只读 header 会把 "standard" 当结论 → 交接出来的新会话继承错预设（实测 2026-10-12：
  // 源会话实际是 qwen38，新会话却落成 standard）。这里改读事件里最后一次选择。
  let agentPreset = "";
  try {
    const presetEvents = typeof session.snapshotEvents === "function" ? session.snapshotEvents() : [];
    for (let i = presetEvents.length - 1; i >= 0; i -= 1) {
      const ev = presetEvents[i];
      if (
        ev &&
        ev.type === "agent-preset/selected" &&
        ev.data &&
        typeof ev.data.agentPreset === "string" &&
        ev.data.agentPreset
      ) {
        agentPreset = ev.data.agentPreset;
        break;
      }
    }
  } catch (ePreset) {
    console.log(`[xwide-handoff] 读 agent-preset/selected 失败：${String((ePreset && ePreset.message) || ePreset)}`);
  }
  if (!agentPreset) {
    agentPreset = typeof (session.header && session.header.agentPreset) === "string" ? session.header.agentPreset : "";
  }
  // [dsh-fix 2026-10-12] 第三条路：ctx.sessions.create() 造出来的是**不落盘**的裸会话。
  //   dsh-session/lib/index.js:1592 注释原话："Persistence is intentionally not implemented here —
  //   the agent lifecycle attaches a session-log writer to each published session's write handle;
  //   a session published outside that lifecycle persists nothing."
  //   实测 2026-10-12：这样造的会话只有 projcache，sessions\ 目录下没有它 → GUI 会话列表里
  //   翻不到（childMode:"none" 处的注释早写过这个坑：「造出来的是裸会话，GUI 列表看不见」）。
  //   GUI 的「新建对话」走的是 sessionController.create（dsh-api-session-controller/lib/index.js:686
  //   → agents.ensureSession → createOrAdopt → ctx.agents.create），那条链会挂上持久化写入器。
  //   所以优先借同一条链，拿不到再退回旧的 ctx.sessions.create。
  if (config.childMode === "create" && !child) {
    const ctl = typeof ctx.get === "function" ? ctx.get("sessionController") : void 0;
    if (ctl && typeof ctl.create === "function") {
      try {
        const created = await ctl.create({ cwd: cwdKey, ...(agentPreset ? { agentPreset } : {}) });
        const newId = created && created.sessionId ? String(created.sessionId) : "";
        const live = newId ? ctx.sessions.get(newId) : void 0;
        if (live) {
          child = live;
          createdEmpty = true;
          createNote = `sessionController.create(${newId})`;
        } else if (newId) {
          createNote = `sessionController.create 返回 ${newId} 但 ctx.sessions.get 取不到`;
        }
      } catch (eCtl) {
        createNote = `sessionController.create 失败(${String((eCtl && eCtl.message) || eCtl)})`;
      }
    } else {
      createNote = "sessionController 服务不可用";
    }
  }
  if (!child && config.childMode === "create") {
    const meta = {};
    try {
      if (/^[a-zA-Z]:[\\/]/.test(cwdKey)) meta.cwd = cwdKey;
      if (agentPreset) meta.agentPreset = agentPreset; // 继承当前智能体/模型（DeepSeek 用 DeepSeek，千问用千问）
      // 故意不写 meta.parentSession：带它的会话会被 DSH 从列表/可恢复集合里排除。
    } catch {}
    try {
      child = ctx.sessions.create(`session-${randomUUID()}`, { meta });
      createdEmpty = true;
    } catch (e0) {
      createNote = `meta被拒(${String((e0 && e0.message) || e0)})`;
      try {
        child = ctx.sessions.create(`session-${randomUUID()}`);
        createdEmpty = true;
      } catch (e1) {
        createNote += `；create失败(${String((e1 && e1.message) || e1)})，退回fork`;
      }
    }
  }
  // [2026-10-13 兜底] create 链全断时退回 fork —— 这是本机**实测在侧栏可见**的那条路：
  // 旧插件 dsh-auto-handoff 一直用 ctx.sessions.fork(...)（其 index.js:279-295 八种 shape 轮试），
  // 用户实测「之前列表里是可以自动新建的」＝这条路的铁证。
  // 代价：fork 继承全部历史，不是零上下文；卡片首行会写明怎么继续，别把历史当任务。
  if (!child && (config.childMode === "fork" || config.childMode === "create")) {
    try {
      child = ctx.sessions.fork(session, undefined, `session-${randomUUID()}`);
    } catch (error) {
      try {
        child = ctx.sessions.fork(session);
      } catch (error2) {
        forkError = String((error2 && error2.message) || (error && error.message) || error2);
      }
    }
    if (child) {
      const forkedId = child.header ? child.header.id : "(无 id)";
      console.log(`[xwide-handoff] 兜底 fork 成功：${forkedId}；createNote=${createNote || "(空)"}`);
    } else {
      console.log(`[xwide-handoff] 兜底 fork 也失败：${forkError || "(空)"}；createNote=${createNote || "(空)"}`);
    }
  }

  // 3) 命名：序号来自落盘计数器（单调递增），基名取最新标题/目录名
  const seq = claimSeq(config.counterFile, cwdKey);
  const base = resolveBase({ titles: titleHistory(session), cwd: cwdKey });
  const title = renderTitle({
    template: config.template,
    base,
    seq,
    note: notes,
    time: formatStamp(),
    seqWidth: config.seqWidth,
    maxChars: config.maxTitleChars,
  });

  // 通道②官方 rename → 通道③append 钉住（source.kind:"user" 是官方的钉住标记）
  const childId = child && child.header ? child.header.id : "(未创建)";
  let renamedBy = "";
  let renameError = "";
  if (child) {
    try {
      ctx.sessions.using(childId, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(title));
      renamedBy = "sessions.using→binding.session.rename";
    } catch (e1) {
      console.log(`[xwide-handoff] 通道②官方rename失败：${String((e1 && e1.message) || e1)}`);
      try {
        child.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
        renamedBy = "append session/title(user) 钉住";
      } catch (e2) {
        renameError = String((e2 && e2.message) || (e1 && e1.message) || e1);
      }
    }
    if (renamedBy) saveName(childId, title);
    console.log(`[xwide-handoff] 命名：base="${base}" seq=${seq} -> "${title}"; child=${childId}; 通道=${renamedBy || "NONE"}`);
  } else {
    console.log(`[xwide-handoff] 命名跳过：无子会话；forkError=${forkError || "(空)"}`);
  }

  // 4) 卡片落盘 + 注入新会话第一句（第一行就是标题 → 通道①）
  const card = buildCard({
    title,
    sourceId,
    childId,
    notes,
    messages,
    compacted,
    renamedBy,
    seq,
    // [dsh-fix 2026-10-12] 事实由插件扛，指令写进卡片 —— 见 buildCard 里「接手须知」的注释。
    files: changedFiles(session),
    usage: usageOf(session),
    sections: config.cardSections,
  });
  const file = join(cardDir(session), `handoff-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  let fileError = "";
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${card}\n`, "utf8");
  } catch (error) {
    fileError = String((error && error.message) || error);
  }
  let seeded = false;
  let seedError = "";
  // [dsh-fix 2026-10-14 B] preamble 提到外层：卡片正文现在由第 5 步的官方 prompt 通道投递，
  //   那段代码在 `if (child)` 块**外面**（原 :688），块内 const 在外面取不到 → 会 ReferenceError。
  const preamble =
    "【交接卡·只读】这是上一个会话自动注入的交接卡。你只需要回复一句『已接收交接，等待指令』；" +
    "不要分析卡片内容、不要给任何选项、不要自行开工。我的下一句指令才是任务。\n\n";
  if (child) {
    // [dsh-fix 2026-10-12 第四次] ★surface head 保护★ —— 本地 Agent 实测踩到的雷，根因在插件。
    //   DSH 要求「可见序列（surface）的第一条必须是 system/message」：
    //     @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:599
    //       if (event.type === "system/message" && this.surface.length > 0 && this.protectedHead === void 0)
    //         throw new SessionFormatError("system/message requires a protected first surface head");
    //     :601 只有 surface.length === 0 时到来的 system/message 才会被记为 protectedHead。
    //   而 SURFACE_EVENT_TYPES（@deepseek-ai/dsh-session/lib/index.js:154-160）只有这五种：
    //     system/message · developer/message · user/message · assistant/message · tool/result
    //   —— session/title、agent/inbox/spliced、turn/start 都**不进** surface。
    //   所以我们若在建会话瞬间直接注入 user/message，就抢在 DSH 写系统提示之前占住 surface 首位，
    //   之后 DSH 写自己的 system/message 时抛错 → 整个会话被判「stored log is corrupt」打不开
    //   （实测：session-a48315dc-59a7-457d-8b97-bde91bec6283；前几次没炸只是因为没驱动首轮）。
    //   解法：先 append 一条形状合法的 system/message 占住 protectedHead，再注入卡片。
    //   system/message 的形状校验见 @deepseek-ai/dsh-session/lib/index.js:1196-1208：
    //     data.message 必须 { id: 非空字符串, role: "system",
    //                         source: { kind: "system-prompt" }, content: 数组 }
    let headSeeded = false;
    let headError = "";
    // [dsh-fix 2026-10-13] 原来这里是 [[0, 0], [1, 1]] —— [0,0] 必然失败，而且**会留下坏行**：
    //   @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:226-228 `positive(value, subject)`
    //   在 `sessionFormatCount(value, subject) === 0` 时抛 `format v4 ${subject} must be positive`；
    //   :252-256 `assertV4SystemMessageFields(row)` 对 system/message 同时要求 turn 与 step ≥ 1。
    //   child.append 的校验不在同步路径上（异常来不到这里的 catch），所以 [0,0] 那行照样落盘，
    //   之后**读取/恢复该会话时**抛 `format v4 system/message turn must be positive` → 前端显示
    //   「本轮运行失败」，重复交接几次就重复几行。故候选里只保留合法值。
    // [dsh-fix 2026-10-14 A] ★占位头之前必须先开 turn/step★ —— 「重启后所有交接会话判 corrupt」的根因。
    //   system/message 是 step-scoped 事件，官方两处校验都要求它落在「当前打开」的 turn/step 上：
    //     @deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js:574 requireStep(event, data)
    //       if (this.turn===null||this.step===null||data["turn"]!==this.turn||data["step"]!==this.step)
    //         throw new SessionFormatError(`${event.type} does not match an open turn and step`)
    //     dsh-session/lib/types/invariant.js:33-66（append 时的实时 trace）同一套规则；
    //     :746-749 turn/start 只能在无 open turn 时开且 data.turn===nextTurn（新会话=1）；
    //     :758-760 step/start 必须在 open turn 内、无 open step，且 data.step===nextStep（=1）。
    //   原实现直接 append system/message(turn=1,step=1)，此刻会话里**没有任何 open turn** →
    //   重载时 :574 抛 `system/message does not match an open turn and step` → 整条会话标成
    //   「stored log is corrupt」→ 重启后历史加载失败（实证 session-9cc3cb15-fbed-4fc8-a7d1-b330c5b33180：
    //   它的 seq=4 就是这条占位头，而 turn/start 直到 seq=7 才出现）。
    //   修法：按官方真实事件形状先开 turn/step（本机活会话日志实测取值：
    //     turn/start {"turn":1} · step/start {"turn":1,"step":1}
    //     · step/end {"turn":1,"step":1} · turn/end {"turn":1,"reason":{"kind":"completed"}}），
    //   卡片注完立刻关掉（见下面 user/message 之后的 step/end + turn/end）；不关的话 DSH 驱动首轮
    //   自己写的 turn/start 会撞 :747 `turn/start does not open the expected turn` → 又 corrupt。
    //   关掉后 nextTurn=2，DSH 按同一 trace 取号，它的首轮自然变成 turn=2，链上自洽。
    // [dsh-fix 2026-10-14 B] ★候选置空 = 整段占位头不再执行★（不写 turn/start、step/start、system/message）。
    //   实证根因（逐帧解 session.v4.jsonl.zstd，本机三个交接会话一致）：
    //     seq=9  turn/end t1      ← 插件合成的 turn 1 在这里关掉，回放器的 nextTurn 变成 2
    //     seq=11 turn/start t1    ← DSH 驱动首轮时按**自己的内存状态**取号，写的还是 t1
    //   → 重载回放到 seq=11 撞 invariant.js:746-749（turn/start 必须 data.turn === nextTurn）
    //   → 抛错 → 「stored log is corrupt」→ **重启后这些会话的历史全部打不开**。
    //   上一版 A 修法只修掉了 _17/_19 的旧形状（seq=4 占位头没有 open turn），
    //   却把冲突挪到了 seq=11 —— 所以「猛猛操作一番还是一样的问题」。
    //   现在插件**一条事件都不合成**：卡片改由第 5 步官方 prompt 通道投递，
    //   surface 首位由 DSH 自己写的 system/message 占据，turn/step 全由官方取号。
    for (const [turn, step] of []) {
      try {
        child.append("turn/start", { turn });
        child.append("step/start", { turn, step });
        child.append(
          "system/message",
          {
            turn,
            step,
            message: {
              id: `handoff-head-${randomUUID()}`,
              role: "system",
              source: { kind: "system-prompt" },
              content: [
                {
                  type: "text",
                  text: "（本会话由 /handoff 交接而来：交接卡见下方第一条用户消息。动手前先按卡片里的『接手须知』做。）",
                },
              ],
            },
          },
          { surfaceOp: "append" },
        );
        headSeeded = true;
        headError = "";
        break;
      } catch (error) {
        headError = String((error && error.message) || error);
      }
    }
    if (!headSeeded) {
      try {
        console.log(`[xwide-handoff] 占位 system/message 失败（两种 turn/step 都试过）：${headError}`);
      } catch {}
    }
    // [dsh-fix 2026-10-14 B] ★卡片不再由插件写事件★ —— 下面整段 append 停用（`if (false)` 保留原文可追溯）。
    //   插件写 user/message + step/end + turn/end 的后果（本机日志实证，见上面 seq=9/seq=11 注释）：
    //   插件替 DSH 把 turn 1 用掉并关掉，DSH 驱动首轮时仍按自己的状态写 turn/start t1 → 回放撞号 → corrupt。
    //   现在卡片的投递唯一通道 = 第 5 步官方 prompt（sessionController.prompt），
    //   surface 首位由 DSH 自己写的 system/message 占住，turn/step 全由官方取号，插件零合成事件。
    seeded = true; // 卡片待由 prompt 投递；成败记在 engaged / engageError
    if (false) try {
      child.append(
        "user/message",
        {
          id: `handoff-${randomUUID()}`,
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: `${preamble}${card}` }],
        },
        // [dsh-fix 2026-10-12] user/message 是 surface-eligible 事件。缺第三个参数时，
        // session.append 内部的 this.surfaceManager.validateNext(event) 会抛
        //   session event "user/message" is surface-eligible and requires a surfaceOp marker
        // 注入静默失败 → 新会话变成空壳（turns 0 / blank true / contextTimeline.sums.user 0）。
        // 官方 @deepseek-ai/dsh-compaction-basic/lib/index.js:650 同样传第三个参数。
        // 实证：command/done seq=93 的 seedError 原文即上面那句。
        { surfaceOp: "append" },
      );
      // [dsh-fix 2026-10-14 A] 卡片注完立刻关掉合成的 turn 1（形状见上面注释）。
      //   step/end 要求 step 正开着（invariant.js:72-77）；turn/end 要求 step 已关（:44-53），
      //   之后 nextTurn+=1 → DSH 驱动的首轮自然取到 turn=2，不再撞 :747。
      child.append("step/end", { turn: 1, step: 1 });
      child.append("turn/end", { turn: 1, reason: { kind: "completed" } });
      seeded = true;
    } catch (error) {
      seedError = String((error && error.message) || error);
      try {
        console.log(`[xwide-handoff] 注入 user/message 失败：${seedError}`);
      } catch {}
    }
  }

  // 5) [dsh-fix 2026-10-12] 让新会话真的跑一轮 —— 这一步决定它在侧栏里是否可见。
  //    注入 user/message 只更新 lastPromptAt，不产生 turn/start；而 DSH 只认 turn/start 翻 blank：
  //      dsh-api-session-controller/lib/index.js:1808
  //        const blank = state.blank && event.type !== "turn/start";
  //    blank=true 的会话会被侧栏直接滤掉（dsh-client-ui-workspace/lib/client.js:359
  //      if (session.blank && session.id !== current) return false），
  //    即使显示，标题也会被换成「新建会话」（同文件 :1123）。所以必须真的驱动一次 turn。
  //    走官方 prompt 通道（dsh-api-session-controller/lib/types/commands.js:290 async prompt）
  //      → resolveAgent(request.sessionId) → agent.followup(message) → turn/start。
  let engaged = false;
  let engageError = "";
  if (child && seeded) {
    try {
      const ctl = typeof ctx.get === "function" ? ctx.get("sessionController") : void 0;
      if (ctl && typeof ctl.prompt === "function") {
        await ctl.prompt(
          {
            sessionId: childId,
            requestId: `handoff-engage-${randomUUID()}`,
            // [dsh-fix 2026-10-14 B] 正文＝交接卡本身（官方 prompt 通道 = GUI 发第一条消息的同一条路）。
            //   卡片首行仍是目标标题 → 通道①的取名启发式照旧生效；显式 rename 在这之前已完成。
            content: [
              {
                type: "text",
                text: `${preamble}${card}`,
              },
            ],
          },
          // [dsh-fix 2026-10-12 第二次] 第二个参数 signal 必须给：prompt 包装层
          // （dsh-api-session-controller/lib/types/index.js:477）第一行就调 signal.throwIfAborted()，
          // 不给会抛 "Cannot read properties of undefined (reading 'throwIfAborted')" ——
          // 实测日志 2026-10-12T12:48:47.591Z 正是这个错。
          // AbortSignal 自带 throwIfAborted（Node 17.2+ 标准），给一个永不 abort 的 signal 即可。
          new AbortController().signal,
        );
        engaged = true;
        try {
          console.log(`[xwide-handoff] 已驱动新会话跑首轮：${childId}`);
        } catch {}
      } else {
        engageError = "sessionController.prompt 不可用";
        // [dsh-fix 2026-10-14 B] 投递通道断了就如实报「卡片没送进去」，绝不再退回自己写事件那条老路
        //   （自己写事件 = 本次 corrupt 的根因）。卡片文件已落盘，head 文案会提示用户手动粘贴。
        seeded = false;
        seedError = engageError;
        try {
          console.log(`[xwide-handoff] 驱动新会话失败：${engageError}`);
        } catch {}
      }
    } catch (error) {
      engageError = String((error && error.message) || error);
      // [dsh-fix 2026-10-14 B] prompt 抛错 = 卡片没送进去；如实置 seedError，让 head 提示手动粘贴卡片，
      //   绝不退回「插件自己写事件」那条老路（那正是本次 corrupt 的根因）。
      seeded = false;
      seedError = engageError;
      try {
        console.log(`[xwide-handoff] 驱动新会话失败：${engageError}`);
      } catch {}
    }
  }

  // [dsh-fix 2026-10-12] 把新会话置顶 —— 用户要求「新交接出来的会话要显眼、位置别再被折叠埋掉」。
  //   官方置顶 API：@deepseek-ai/dsh-workspace/lib/index.js:374 注册服务名 "workspaceRegistry"；
  //   :576 pinSession(sessionId) 返回 Promise（内部 enqueueOperation）；:584
  //   pinnedSessionIds: [sessionId, ...state.pinnedSessionIds] → 新置顶的排在**最前**。
  //   置顶后客户端 dsh-client-ui-workspace/lib/client.js:372-380 sectionMembers() 会
  //   把 pinned 的行 leading.push 提到分组最前；折叠（collapsedSessionRows，:2122）
  //   不会把它埋掉。已在 pin 集合里的 id 直接 resolve（不写、不重排）。
  //   注：pinSession 要求会话 known（live / header 索引 / 持久化列表），新会话刚落盘，满足。
  let pinnedNote = "";
  if (child && childId && childId !== "(未创建)") {
    try {
      const reg = typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : void 0;
      if (reg && typeof reg.pinSession === "function") {
        await reg.pinSession(childId);
        pinnedNote = "已置顶（侧栏分组内排最前，不会被折叠埋掉）";
      } else {
        pinnedNote = "workspaceRegistry 服务不可用（未置顶）";
      }
    } catch (error) {
      pinnedNote = `置顶失败(${String((error && error.message) || error)}) —— 可在侧栏右键手动置顶`;
      try {
        console.log(`[xwide-handoff] 置顶新会话失败：${pinnedNote}`);
      } catch {}
    }
  }

  // [dsh-fix 2026-10-12 第三次] 把新会话归入**源会话所在的项目分组**。
  //   用户要求：「置顶（新会话自动置顶到侧栏最上面）这一项置顶的话，不应该置顶在未分组，
  //   而应该置顶在当前项目在的夹子里面。如果没有，才是置顶在那个未分组」。
  //   dsh-project-groups 把分组存在自己的 Host 域里（服务名 'projectController'，
  //   见 node_modules/dsh-project-groups/src/protocol.ts:20 PROJECT_SERVICE_KEY），
  //   表 'assignments' 的形状是 { [sessionId]: projectId }：
  //     · @Remote('baseline')  src/index.ts:924（无参）→ { projects, assignments, ... }
  //       src/index.ts:933  assignments = Object.fromEntries([[sessionId, record.projectId], ...])
  //     · @Remote('assign')    src/index.ts:1139 → assignments.put(sessionId, { projectId, assignedAt })
  //       request 形状 { sessionId, projectId }（src/protocol.ts:279）；projectId 不存在会抛 unknown project
  //     · @Remote('unassign')  src/index.ts:1157 → 删除记录（= 回到 Ungrouped）
  //   为什么必须在这里显式归组：GUI「新建会话」走 vendored/client/index.ts:334 placeUnscoped
  //   → resolveTarget()（src/client/target.ts:42，按 newSessionTarget 设置 ungrouped/current/recent 决议），
  //   而 sessionController.create 造的会话**不走那条路** —— 所以它们一律落到未分组。
  //   源会话自己没分组（assignments 里查不到）时**什么都不做**：新会话同样留在未分组，正合用户要求。
  let projectNote = "";
  if (child && childId && childId !== "(未创建)" && sourceId && sourceId !== "(unknown)") {
    try {
      const pc = typeof ctx.get === "function" ? ctx.get("projectController") : void 0;
      if (pc && typeof pc.baseline === "function" && typeof pc.assign === "function") {
        const base = await pc.baseline();
        const assignments = (base && base.assignments) || {};
        const projectId = assignments[sourceId];
        if (typeof projectId === "string" && projectId !== "") {
          await pc.assign({ sessionId: childId, projectId });
          projectNote = "已归入源会话所在的项目分组";
        } else {
          projectNote = "源会话未分组，新会话留在未分组";
        }
      } else {
        projectNote = "projectController 服务不可用（未归组）";
      }
    } catch (error) {
      projectNote = `归组失败(${String((error && error.message) || error)})`;
      try {
        console.log(`[xwide-handoff] 归入项目分组失败：${projectNote}`);
      } catch {}
    }
  }

  const head =
    config.childMode === "none"
      ? `交接已就绪：浏览器半会用 GUI「新建对话」同一条 API 建**可见**会话、命名为「${title}」、把卡片填成第一句（零上下文，继承当前智能体/模型）`
      : !child
        ? `压缩已执行，但新会话未创建：${forkError || "(未知原因)"}`
        : seeded
          ? `已交接：新会话「${title}」（id ${childId}）—— 交接卡已注入第一句${engaged ? "，并已驱动它跑首轮（侧栏可见，标题即此名）" : "，打开就能接着聊"}${engageError ? `；驱动首轮失败（${engageError}）` : ""}`
          : `已交接：新会话「${title}」（id ${childId}）；自动注入失败（${seedError}），请把下面卡片作为第一句粘贴`;
  const extras = [];
  if (child) extras.push(`新会话类型：${createdEmpty ? "全新空会话（上下文清零）" : "fork（继承全部历史）"}${createNote ? `；${createNote}` : ""}`);
  extras.push(`序号：第 ${seq} 次交接（计数器落盘，跨交接递增）`);
  if (renamedBy) extras.push(`命名通道：${renamedBy}`);
  else if (renameError) extras.push(`命名失败：${renameError} —— 请手动把标题设为「${title}」`);
  extras.push(fileError ? `卡片写文件失败：${fileError}` : `卡片文件：${file}`);
  if (pinnedNote) extras.push(`侧栏位置：${pinnedNote}`);
  if (projectNote) extras.push(`项目分组：${projectNote}`);
  if (compacted && compacted.skipped) extras.push(`压缩跳过：${compacted.skipped}`);

  if (config.childMode === "none")
    extras.push(`新建方式：GUI 亲生 API（浏览器半），继承当前智能体/模型 preset=${agentPreset || "(未取到)"}`);
  // 浏览器半协议：结果文本末尾追加**单行** payload（卡片 JSON 化，换行被转义 → 整行可解析）
  const payload = JSON.stringify({ title, cwd: cwdKey, agentPreset, stamp: new Date().toISOString(), card });
  const tail = config.childMode === "none" ? `\n\nHANDOFF-PAYLOAD-V1 ${payload}` : "";
  return { kind: "success", text: `${head}\n${extras.join("\n")}\n\n${card}${tail}` };
}

function invocaationAborted(invocation) {
  return Boolean(invocation && invocation.signal && invocation.signal.aborted);
}

// ---------- 通道③：自愈重钉 ----------
// dsh-session-title 的 refresh() 是**故意的解钉通道**（其注释自认
// "overwriting a pinned user title is the point"）。名单落盘后监听改名事件，
// 凡名单内会话出现非 user 来源的改名 → 把目标名再钉一次（上限 repinLimit）。

function attachSelfHeal(ctx, config) {
  const names = readJson(NAMES_FILE);
  const repins = new Map();
  ctx.on("session/event", (session, event) => {
    try {
      if (!isNonUserTitleEvent(event)) return;
      const sid = session && session.header ? session.header.id : "";
      const want = names[sid];
      if (!want) return;
      const n = repins.get(sid) || 0;
      if (n >= config.repinLimit) {
        console.log(`[xwide-handoff] 自愈重钉已达上限(${config.repinLimit})，放弃：${sid}`);
        return;
      }
      repins.set(sid, n + 1);
      try {
        ctx.sessions.using(sid, { source: "workspaceOperation" }, (ref) => ref.binding.session.rename(want));
        console.log(`[xwide-handoff] 自愈重钉：${sid} -> "${want}"（第${n + 1}次）`);
      } catch (e1) {
        session.append("session/title", { title: want, messageSeqs: [], source: { kind: "user" } });
        console.log(`[xwide-handoff] 自愈重钉(append)：${sid} -> "${want}"（第${n + 1}次；通道②异常=${String((e1 && e1.message) || e1)}）`);
      }
    } catch (e) {
      console.log(`[xwide-handoff] 自愈watcher异常：${String((e && e.message) || e)}`);
    }
  });
  console.log(`[xwide-handoff] 自愈watcher已挂载（名单 ${Object.keys(names).length} 条，上限 ${config.repinLimit}）`);
}

// ---------- A 半自动：到阈值自动把新会话备好 ----------
// [dsh-fix 2026-10-12] 用户拍板「A 半自动」：**不替用户切会话**，只把新会话备好（建好/命名/
//   置顶/卡片注入/驱动首轮），用户在侧栏点那条置顶的新会话继续。
//
//   占用判据（2026-10-12 实测，工具 .tmp-zstd\dump-usage.js）：
//     · 新会话 assistant/message.data.usage = {"inputTokens":16676,"outputTokens":44,"totalTokens":16720}
//     · 大会话 assistant/message.data.usage = {"inputTokens":18461,"outputTokens":5581,
//                                              "totalTokens":205248,"cacheReadTokens":181206}
//     → **inputTokens 才是「本次请求携带的上下文量」**，正是判占用要的；
//       totalTokens 是累计消耗（205248），**不能**拿来判占用。
//   触发点：turn/end（一轮结束，绝不在半途打断）。
//   保险：按会话只备一次（armed）、全局冷却、总开关 config.autoReady（默认关）。

function attachAutoReady(ctx, config) {
  if (!config.autoReady) return;
  const used = new Map(); // sid -> 最近一次 inputTokens
  const armed = new Set(); // 已备好过的会话
  let lastAt = 0;
  console.log(
    `[xwide-handoff] 自动备好已开：阈值 ${(config.readyPct * 100).toFixed(0)}%／窗口 ${config.contextWindow}／冷却 ${Math.round(config.readyCooldownMs / 60000)} 分钟`,
  );

  ctx.on("session/event", (session, event) => {
    try {
      const sid = session && session.header ? session.header.id : "";
      if (!sid) return;
      if (event.type === "assistant/message") {
        const u = event.data && event.data.usage;
        if (u && Number.isFinite(u.inputTokens)) used.set(sid, u.inputTokens);
        return;
      }
      if (event.type !== "turn/end") return;
      if (armed.has(sid)) return;
      const n = used.get(sid);
      if (!Number.isFinite(n)) return;
      const ratio = n / config.contextWindow;
      if (ratio < config.readyPct) return;
      const now = Date.now();
      if (now - lastAt < config.readyCooldownMs) {
        console.log(`[xwide-handoff] 自动备好：${sid} 已达 ${(ratio * 100).toFixed(1)}%，但冷却中，跳过`);
        return;
      }
      armed.add(sid);
      lastAt = now;
      console.log(
        `[xwide-handoff] 上下文 ${(ratio * 100).toFixed(1)}%（${n}/${config.contextWindow}），开始自动备好新会话：${sid}`,
      );
      autoReadyOnce(ctx, config, sid, n).catch((error) => {
        console.log(`[xwide-handoff] 自动备好失败：${String((error && error.message) || error)}`);
      });
    } catch (error) {
      console.log(`[xwide-handoff] 自动备好watcher异常：${String((error && error.message) || error)}`);
    }
  });
}

async function autoReadyOnce(ctx, config, sid, tokens) {
  const ctl = typeof ctx.get === "function" ? ctx.get("sessionController") : void 0;
  if (!ctl || typeof ctl.resolveAgent !== "function") {
    console.log("[xwide-handoff] 自动备好跳过：sessionController 服务不可用");
    return;
  }
  const agent = await ctl.resolveAgent(sid);
  const session = agent && agent.session;
  if (!session) {
    console.log("[xwide-handoff] 自动备好跳过：拿不到会话对象");
    return;
  }
  const pct = ((tokens / config.contextWindow) * 100).toFixed(0);
  const invocation = {
    agent,
    rawInput: `（自动备好：源会话上下文已到 ${pct}%，新会话已建好，从这里接着做）`,
    signal: new AbortController().signal,
    commandId: undefined,
  };
  // compact:false —— 源会话已到阈值，再压一次只会多花时间；卡片本身就是摘要式的。
  const result = await runHandoff(ctx, { ...config, compact: false }, invocation);
  const ok = Boolean(result && result.kind === "success");
  console.log(
    `[xwide-handoff] 自动备好${ok ? "完成" : `未完成（${String((result && result.text) || "").slice(0, 160)}）`}`,
  );
}

// ---------- 设置表单（harness 0.1.7 Config 驱动模型，照 @falling-ts/dsh-force-compact）----------
// 装载行 config 是基线；设置页里改的键写进 settings.yaml 的同名命名空间（= 装载行 entry id），
// 覆盖基线；清空一项 = 回落基线。字段全部 .volatile()（表单可写的前提）。schemastery 解析不到时
// Config=undefined：没有设置表单，一切照旧走装载行 config，绝不抛错。
async function resolveZ() {
  try {
    const mod = await import("@deepseek-ai/schemastery");
    const z = mod.default ?? mod;
    if (z && typeof z.object === "function") return z;
  } catch {}
  return undefined;
}

function asVolatile(field) {
  const carrier = (typeof field === "object" && field !== null) || typeof field === "function";
  return carrier && typeof field.volatile === "function" ? field.volatile() : field;
}

/** 设置命名空间 = 装载行 entry id（harness 由 entry id 推导表单命名空间）。 */
export const SETTINGS_NS = "dsh-xwide-handoff";

const CONFIG_DEFAULTS = {
  enabled: true,
  commandName: "handoff",
  titleTemplate: DEFAULT_TEMPLATE,
  seqWidth: DEFAULT_SEQ_WIDTH,
  maxTitleChars: DEFAULT_MAX_TITLE_CHARS,
  recentUserMessages: 6,
  compact: true,
  repinLimit: 3,
  keepFork: false,
  childMode: "none",
  autoReady: false,
  readyPct: 0.7,
  readyCooldownMs: 600000,
  contextWindow: 262144,
};

export const Config = await (async () => {
  const z = await resolveZ();
  if (!z) return undefined;
  try {
    const shape = {};
    for (const [key, def] of Object.entries(CONFIG_DEFAULTS)) {
      const base =
        typeof def === "boolean" ? z.boolean().default(def)
        : typeof def === "number" ? z.number().default(def)
        : z.string().default(def);
      shape[key] = asVolatile(base);
    }
    // counterFile / cardSections：无默认值（缺省=用内置路径/三段全开），z.any() 兼容
    // 厂商 schemastery 的最小面（object/any/string/number/boolean/array）。
    shape.counterFile = asVolatile(z.any());
    shape.cardSections = asVolatile(z.any());
    return z.object(shape);
  } catch {
    return undefined;
  }
})();

export function apply(ctx, rawConfig = {}) {
  const config = cfg(rawConfig);
  if (!config.enabled) {
    console.log("[xwide-handoff] disabled");
    return;
  }
  // 声明「本插件自带设置页分区」（client.js 注册 settings.section），宿主不要再自动生成表单。
  // settings 服务挂载晚于本 effect，故惰性 ctx.inject；失败只是外观问题，不影响功能。
  try {
    ctx.inject(["settings"], (child) => {
      child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });
  } catch (error) {
    console.log(`[xwide-handoff] settings.configure 声明失败（仅外观）：${(error && error.message) || error}`);
  }
  try {
    attachSelfHeal(ctx, config);
    attachAutoReady(ctx, config);
    ctx.effect(
      function* () {
        const active = new Set();
        yield ctx.commands.register({
          definitionId: "@local/dsh-xwide-handoff",
          name: config.commandName,
          description: "交接：本地压缩 → 新建上下文清零的会话 → 按递增序号命名并写入交接卡（全本地、零模型调用）",
          handler: (invocation) => {
            const operation = runHandoff(ctx, config, invocation);
            active.add(operation);
            const retire = () => active.delete(operation);
            operation.then(retire, retire);
            return operation;
          },
        });
      },
      "dsh-xwide-handoff lifecycle",
    );
    console.log(`[xwide-handoff] /${config.commandName} registered（模板 ${config.template}，序号位数 ${config.seqWidth}）`);
  } catch (error) {
    console.log(`[xwide-handoff] 注册失败（不影响启动）：${(error && error.message) || error}`);
  }
}
